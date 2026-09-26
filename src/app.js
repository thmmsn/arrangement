import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CapacityError } from './db.js';
import { registrationsToCsv } from './csv.js';
import * as templates from './email.js';
import { accessTokenFrom, AccessError, createAccessVerifier } from './cfAccess.js';
import { hashSecret, newSecret, newSlug, secretMatches, SLUG_PATTERN } from './ids.js';
import { rateLimit } from './rateLimit.js';
import { loadTheme, themeCspSources, themeCss } from './theme.js';
import { createViews } from './views.js';
import { registrationStatus, validateBooking, validateEvent, ValidationError } from './validation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'views');
const ASSETS = path.join(ROOT, 'public', 'assets');
// Egne filer (logo, favicon, CSS) fra ./branding, tilgjengelige som /assets/custom/<fil>.
const BRANDING = path.join(ROOT, 'branding');

// Maks antall forespørsler per IP-adresse innenfor tidsvinduet. Kan overstyres via config.rateLimits.
const DEFAULT_RATE_LIMITS = {
  register: { windowMs: 10 * 60_000, max: 30 },
  cancel: { windowMs: 10 * 60_000, max: 30 },
  create: { windowMs: 15 * 60_000, max: 20 },
};

const STATUS_MESSAGES = {
  closed: 'Påmeldingen er stengt.',
  deadline_passed: 'Påmeldingsfristen har gått ut.',
  full: 'Arrangementet er fullt.',
};

export function createApp({ repo, mailer, config, logger = console, accessVerifier = defaultAccessVerifier(config) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  // Skill mellom store og små bokstaver i adressene. Ellers ville /ADMIN/ny og /API/ADMIN/… gitt
  // samme svar som /admin/… – og en Cloudflare Access-regel på stien «admin» dekker kanskje ikke dem.
  app.set('case sensitive routing', true);

  const theme = config.theme ?? loadTheme({}, { baseUrl: config.baseUrl }).theme;
  const page = createViews(VIEWS, theme);
  const csp = themeCspSources(theme);

  // Med eget admin-vertsnavn peker admin-lenkene dit; ellers til samme domene som resten.
  const adminBaseUrl = config.adminHost ? `https://${config.adminHost}` : config.baseUrl;
  const eventUrl = (slug) => `${config.baseUrl}/${slug}`;
  // Hemmeligheter legges etter # i lenken. Den delen sendes aldri til serveren av nettleseren,
  // så den havner ikke i serverlogger, proxy-logger eller Referer-headere.
  const adminUrl = (slug, key) => `${adminBaseUrl}/admin/${slug}#${key}`;
  const cancelUrl = (slug, token) => `${config.baseUrl}/${slug}/avmelding#${token}`;
  const adminHint = 'Du finner hele listen over påmeldte via administrasjonslenken du fikk da arrangementet ble opprettet.';

  // ---------- Felles mellomvare ----------

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Lekker ikke arrangementets adresse til eksterne nettsteder (f.eks. der et forsidebilde ligger).
      'Referrer-Policy': 'no-referrer',
      // Arrangementer skal bare kunne nås via lenke – be søkemotorer om å holde seg unna.
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        `style-src ${csp.styles.join(' ')}`,
        `font-src ${csp.fonts.join(' ')}`,
        "img-src 'self' https: data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });

  app.use('/assets/custom', express.static(BRANDING, { maxAge: '1h' }));
  app.use('/assets', express.static(ASSETS, { maxAge: '1h' }));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  const css = themeCss(theme);
  app.get('/theme.css', (req, res) => res.type('text/css').set('Cache-Control', 'public, max-age=300').send(css));

  const sendPage = (res, name, status = 200) => res.status(status).type('html').send(page(name));

  // ---------- Admin-porten ----------
  // Alt som har med administrasjon å gjøre ligger under /admin (sider) og /api/admin (API),
  // slik at én Cloudflare Access-regel – på et eget vertsnavn eller på disse stiene – dekker alt.

  // Vertsnavnet fra Host-headeren. Bevisst IKKE req.hostname: med «trust proxy» leser den
  // X-Forwarded-Host, som en klient kan sette selv og dermed late som den kom via admin-domenet.
  const hostOf = (req) => (req.get('host') || '').toLowerCase().replace(/:\d+$/, '');

  function adminGate(kind) {
    const deny = (res, status, message) => (kind === 'api'
      ? res.status(status).set('Cache-Control', 'no-store').json({ error: message })
      : sendPage(res, String(status), status));

    return async (req, res, next) => {
      // Med eget admin-vertsnavn finnes ikke admin på det offentlige domenet i det hele tatt.
      if (config.adminHost && hostOf(req) !== config.adminHost) return deny(res, 404, 'Ukjent adresse.');
      if (accessVerifier) {
        try {
          req.accessUser = await accessVerifier(accessTokenFrom(req));
        } catch (err) {
          if (!(err instanceof AccessError)) logger.error('Cloudflare Access-sjekk feilet:', err);
          return deny(res, 403, 'Ingen tilgang: logg inn via Cloudflare Access.');
        }
      }
      next();
    };
  }

  // ---------- Sider ----------

  app.get('/', (req, res) => sendPage(res, 'index'));

  app.get('/admin', adminGate('page'), (req, res) => res.redirect('/admin/ny'));
  app.get('/admin/ny', adminGate('page'), (req, res) => sendPage(res, 'new'));
  app.get('/admin/:slug', adminGate('page'), (req, res, next) => {
    const slug = req.params.slug.toLowerCase();
    if (!SLUG_PATTERN.test(slug) || !repo.findEvent(slug)) return sendPage(res, '404', 404);
    sendPage(res, 'admin');
  });

  // Gamle adresser fra før admin ble samlet under /admin. Nettleseren tar med #nøkkelen videre.
  app.get('/ny', (req, res) => res.redirect(301, `${config.adminHost ? adminBaseUrl : ''}/admin/ny`));
  app.get('/:slug/admin', (req, res, next) => {
    const slug = req.params.slug.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return next();
    res.redirect(301, `${config.adminHost ? adminBaseUrl : ''}/admin/${slug}`);
  });

  const eventPage = (name) => (req, res, next) => {
    const slug = req.params.slug.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return next();
    if (!repo.findEvent(slug)) return sendPage(res, '404', 404);
    sendPage(res, name);
  };
  app.get('/:slug', eventPage('event'));
  app.get('/:slug/avmelding', eventPage('cancel'));

  // ---------- API: hjelpefunksjoner ----------

  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const api = express.Router({ caseSensitive: true });
  api.use(express.json({ limit: '100kb' }), noStore);
  const adminApi = express.Router({ caseSensitive: true });
  adminApi.use(adminGate('api'), express.json({ limit: '100kb' }), noStore);

  // Klientens IP til rate limiting. Bak Cloudflare Tunnel kommer alle forespørsler fra cloudflared,
  // så den ekte adressen må hentes fra headeren Cloudflare setter (CLIENT_IP_HEADER).
  const clientKey = (req) => (config.clientIpHeader && req.get(config.clientIpHeader)) || req.ip;
  const limits = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  const registerLimiter = rateLimit({ ...limits.register, key: clientKey });
  const cancelLimiter = rateLimit({ ...limits.cancel, key: clientKey });
  const createLimiter = rateLimit({ ...limits.create, key: clientKey });

  function loadEvent(req, res, next) {
    const slug = String(req.params.slug).toLowerCase();
    const event = SLUG_PATTERN.test(slug) ? repo.findEvent(slug) : null;
    if (!event) return res.status(404).json({ error: 'Fant ikke arrangementet.' });
    req.event = event;
    next();
  }

  // Admin-nøkkelen for et arrangement sendes som «Authorization: Bearer <nøkkel>».
  function requireEventAdmin(req, res, next) {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!match || !secretMatches(match[1], req.event.adminKeyHash)) {
      return res.status(401).json({ error: 'Ugyldig administrasjonslenke.' });
    }
    next();
  }

  // Oppretting av nye arrangementer krever ADMIN_PASSWORD. Når Cloudflare Access verifiseres
  // (adminGate har allerede sluppet forespørselen gjennom), kan passordet droppes.
  function requireCreator(req, res, next) {
    if (config.adminPassword) {
      if (!secretMatches(req.get('x-admin-password') || '', hashSecret(config.adminPassword))) {
        return res.status(401).json({ error: 'Feil passord.' });
      }
      return next();
    }
    if (accessVerifier) return next();
    return res.status(403).json({ error: 'Oppretting av arrangementer er slått av (verken ADMIN_PASSWORD eller Cloudflare Access er satt opp).' });
  }

  function publicEvent(event, count) {
    const { showCount, capacity } = event;
    return {
      slug: event.slug,
      url: eventUrl(event.slug),
      title: event.title,
      description: event.description,
      location: event.location,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      registrationDeadline: event.registrationDeadline,
      organizerName: event.organizerName,
      imageUrl: event.imageUrl,
      fields: event.fields,
      maxPerBooking: event.maxPerBooking,
      timeZone: config.timeZone,
      status: registrationStatus(event, count),
      // Arrangøren kan skjule antallet. Da skjules også kapasiteten, siden den sammen med
      // «fullt»-statusen ellers ville røpet mye av det samme.
      count: showCount ? count : null,
      capacity: showCount ? capacity : null,
      spotsLeft: showCount && capacity != null ? Math.max(0, capacity - count) : null,
    };
  }

  function adminEvent(event, count) {
    return {
      ...publicEvent(event, count),
      count,
      capacity: event.capacity,
      spotsLeft: event.capacity != null ? Math.max(0, event.capacity - count) : null,
      showCount: event.showCount,
      isOpen: event.isOpen,
      organizerEmail: event.organizerEmail,
      createdAt: event.createdAt,
    };
  }

  // E-post skal aldri stoppe en påmelding: feil logges, og svaret forteller om sendingen gikk bra.
  async function sendEmails(messages) {
    const results = await Promise.allSettled(messages.map((m) => mailer.send(m)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') logger.error(`Kunne ikke sende e-post til ${messages[i].to}:`, result.reason);
    });
    return results.map((r) => r.status === 'fulfilled');
  }

  // ---------- API: offentlig ----------

  api.get('/config', (req, res) => res.json({ timeZone: config.timeZone }));
  adminApi.get('/config', (req, res) => res.json({
    timeZone: config.timeZone,
    passwordRequired: Boolean(config.adminPassword),
    accessEmail: req.accessUser?.email ?? null,
  }));

  api.get('/events/:slug', loadEvent, (req, res) => {
    res.json(publicEvent(req.event, repo.countRegistrations(req.event.id)));
  });

  // Feilmelding når hele gruppen ikke får plass. Antallet ledige plasser nevnes bare hvis arrangøren
  // viser antall påmeldte offentlig.
  function notEnoughSpots(event, spotsLeft) {
    if (spotsLeft <= 0) return { error: STATUS_MESSAGES.full, status: 'full' };
    const error = event.showCount
      ? `Det er bare ${spotsLeft} ${spotsLeft === 1 ? 'ledig plass' : 'ledige plasser'} igjen. Fjern noen personer og prøv igjen.`
      : 'Det er ikke nok ledige plasser til alle. Prøv med færre personer.';
    return { error, status: 'not_enough', ...(event.showCount && { spotsLeft }) };
  }

  // En påmelding består av kontaktpersonen (name, email, answers) og eventuelle personer
  // som er lagt til (guests). Hver person blir én gjest og tar én plass.
  api.post('/events/:slug/registrations', registerLimiter, loadEvent, async (req, res) => {
    const { event } = req;

    // Honningkrukke: et skjult felt som mennesker ikke ser, men som roboter gjerne fyller ut.
    // Vi later som alt gikk bra, slik at roboten ikke lærer noe.
    if (req.body?.website) {
      return res.status(201).json({
        booking: { contactName: '', contactEmail: '', persons: [] },
        emailSent: true,
        event: publicEvent(event, repo.countRegistrations(event.id)),
      });
    }

    // Raske sjekker før validering, så gjesten får «fullt»/«stengt» i stedet for feltfeil.
    // Selve plassene reserveres likevel trygt inne i transaksjonen i repo.register().
    const count = repo.countRegistrations(event.id);
    const status = registrationStatus(event, count);
    if (status !== 'open') return res.status(409).json({ error: STATUS_MESSAGES[status], status });
    const requested = 1 + (Array.isArray(req.body?.guests) ? req.body.guests.length : 0);
    if (event.capacity != null && count + requested > event.capacity) {
      return res.status(409).json(notEnoughSpots(event, event.capacity - count));
    }

    const { contact, persons } = validateBooking(req.body, event.fields, event.maxPerBooking);
    const cancelToken = newSecret(18);
    const booking = { contactName: contact.name, contactEmail: contact.email, persons };

    let result;
    try {
      result = repo.register(event, { ...booking, cancelTokenHash: hashSecret(cancelToken) });
    } catch (err) {
      if (err instanceof CapacityError) return res.status(409).json(notEnoughSpots(event, err.spotsLeft));
      throw err;
    }

    const [guestSent] = await sendEmails([
      templates.guestConfirmation({
        event,
        booking,
        eventUrl: eventUrl(event.slug),
        cancelUrl: cancelUrl(event.slug, cancelToken),
        timeZone: config.timeZone,
        theme,
      }),
      templates.organizerNotification({ event, booking, count: result.count, adminHint, theme }),
    ]);

    res.status(201).json({
      booking: { contactName: contact.name, contactEmail: contact.email, persons: persons.map(({ name }) => ({ name })) },
      emailSent: guestSent,
      event: publicEvent(event, result.count),
    });
  });

  function findBooking(req) {
    const token = req.body?.token;
    return typeof token === 'string' && token ? repo.findBookingByToken(req.event.id, hashSecret(token)) : null;
  }
  const notFoundCancel = 'Fant ingen påmelding for denne lenken. Kanskje den allerede er meldt av?';

  // Viser hvem avmeldingslenken gjelder før gjesten bekrefter. Avmeldingen skjer først ved POST
  // til /cancel – mange e-posttjenester åpner lenker automatisk for å sjekke dem for virus,
  // og det skal ikke melde noen av.
  api.post('/events/:slug/cancel/lookup', cancelLimiter, loadEvent, (req, res) => {
    const booking = findBooking(req);
    if (!booking) return res.status(404).json({ error: notFoundCancel });
    res.json({
      contactName: booking.contactName,
      persons: booking.persons.map(({ id, name }) => ({ id, name })),
      event: publicEvent(req.event, repo.countRegistrations(req.event.id)),
    });
  });

  // body: { token, ids? } – uten ids meldes hele påmeldingen av, ellers bare de valgte personene.
  api.post('/events/:slug/cancel', cancelLimiter, loadEvent, async (req, res) => {
    const { event } = req;
    const booking = findBooking(req);
    if (!booking) return res.status(404).json({ error: notFoundCancel });

    let ids = booking.persons.map((p) => p.id);
    if (req.body.ids !== undefined) {
      if (!Array.isArray(req.body.ids) || !req.body.ids.every(Number.isInteger)) {
        return res.status(400).json({ error: 'Ugyldig valg av personer.' });
      }
      ids = req.body.ids.filter((id) => ids.includes(id)); // Bare personer i denne påmeldingen.
      if (!ids.length) return res.status(400).json({ error: 'Velg hvem som skal meldes av.' });
    }

    const cancelled = repo.deleteFromBooking(event.id, booking.id, ids);
    if (!cancelled.length) return res.status(404).json({ error: notFoundCancel });
    const remaining = booking.persons.filter((p) => !cancelled.some((c) => c.id === p.id));

    const count = repo.countRegistrations(event.id);
    await sendEmails([
      templates.guestCancellation({ event, booking, cancelled, remaining, eventUrl: eventUrl(event.slug), theme }),
      templates.organizerCancellation({ event, booking, cancelled, count, theme }),
    ]);
    res.json({
      cancelled: cancelled.map(({ name }) => ({ name })),
      remaining: remaining.map(({ id, name }) => ({ id, name })),
      event: publicEvent(event, count),
    });
  });

  // ---------- API: administrasjon ----------

  adminApi.post('/events', createLimiter, requireCreator, async (req, res) => {
    const data = validateEvent(req.body);
    let slug = newSlug();
    while (repo.findEvent(slug)) slug = newSlug(); // Kollisjon er svært usannsynlig, men sjekkes likevel.
    const adminKey = newSecret();

    const event = repo.createEvent({ ...data, slug, adminKeyHash: hashSecret(adminKey) });
    const urls = { eventUrl: eventUrl(slug), adminUrl: adminUrl(slug, adminKey) };
    const [emailSent] = await sendEmails([templates.eventCreated({ event, ...urls, timeZone: config.timeZone, theme })]);

    res.status(201).json({ slug, adminKey, ...urls, emailSent });
  });

  adminApi.get('/events/:slug', loadEvent, requireEventAdmin, (req, res) => {
    const registrations = repo.listRegistrations(req.event.id);
    res.json({
      event: adminEvent(req.event, registrations.length),
      registrations: registrations.map(({ id, bookingId, position, name, email, answers, createdAt, contactName, contactEmail }) =>
        ({ id, bookingId, position, name, email, answers, createdAt, contactName, contactEmail })),
    });
  });

  adminApi.put('/events/:slug', loadEvent, requireEventAdmin, (req, res) => {
    const data = validateEvent(req.body);
    repo.updateEvent(req.event.id, data);
    const event = repo.findEvent(req.event.slug);
    res.json({ event: adminEvent(event, repo.countRegistrations(event.id)) });
  });

  adminApi.delete('/events/:slug', loadEvent, requireEventAdmin, (req, res) => {
    repo.deleteEvent(req.event.id);
    res.json({ ok: true });
  });

  adminApi.delete('/events/:slug/registrations/:id', loadEvent, requireEventAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !repo.deleteRegistration(req.event.id, id)) {
      return res.status(404).json({ error: 'Fant ikke påmeldingen.' });
    }
    res.json({ ok: true, count: repo.countRegistrations(req.event.id) });
  });

  adminApi.get('/events/:slug/registrations.csv', loadEvent, requireEventAdmin, (req, res) => {
    const csv = registrationsToCsv(req.event, repo.listRegistrations(req.event.id), config.timeZone);
    res.type('text/csv; charset=utf-8');
    res.attachment(`pameldte-${req.event.slug}.csv`);
    res.send(csv);
  });

  // Feil i API-et blir alltid til JSON med en norsk feilmelding.
  const notFound = (req, res) => res.status(404).json({ error: 'Ukjent adresse.' });
  const apiErrors = (err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, errors: err.errors });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ugyldig JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Forespørselen er for stor.' });
    logger.error(err);
    res.status(500).json({ error: 'Noe gikk galt på serveren. Prøv igjen senere.' });
  };
  api.use(notFound, apiErrors);
  adminApi.use(notFound, apiErrors);

  // /api/admin før /api, slik at admin-forespørsler alltid går gjennom admin-porten.
  app.use('/api/admin', adminApi);
  app.use('/api', api);

  app.use((req, res) => sendPage(res, '404', 404));

  return app;
}

// Access-verifisering slås på når både team-domenet og AUD er satt. Er bare ett av dem satt, er det
// en feilkonfigurasjon – da nekter appen å starte, i stedet for å stille kjøre uten beskyttelse.
function defaultAccessVerifier(config) {
  const team = config.cfAccessTeamDomain;
  const audiences = config.cfAccessAudiences ?? [];
  if (!team && !audiences.length) return null;
  if (!team || !audiences.length) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD må settes sammen (eller ingen av dem).');
  }
  return createAccessVerifier({ teamDomain: team, audiences });
}

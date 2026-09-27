import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CapacityError } from './db.js';
import { registrationsToCsv } from './csv.js';
import * as templates from './email.js';
import { accessTokenFrom, AccessError, createAccessVerifier } from './cfAccess.js';
import { hashSecret, newSecret, newSlug, secretMatches, SLUG_PATTERN } from './ids.js';
import { rateLimit } from './rateLimit.js';
import { loadSites } from './sites.js';
import { themeCspSources, themeCss } from './theme.js';
import { createViews } from './views.js';
import { registrationStatus, translateErrors, validateBooking, validateEvent, ValidationError } from './validation.js';

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

export function createApp({ repo, mailer, config, logger = console, accessVerifier = defaultAccessVerifier(config) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  // Skill mellom store og små bokstaver i adressene. Ellers ville /ADMIN/ny og /API/ADMIN/… gitt
  // samme svar som /admin/… – og en Cloudflare Access-regel på stien «admin» dekker kanskje ikke dem.
  app.set('case sensitive routing', true);

  // ---------- Nettsteder ----------
  // Hvert nettsted har eget domene, språk, tema og base-URL. Nettstedet for en forespørsel velges
  // ut fra Host-headeren; et ukjent vertsnavn får hovednettstedet. Admin bruker alltid hovednettstedet.
  const { sites, mainSite } = config.sites ? config : loadSites({ BASE_URL: config.baseUrl });
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const siteByHost = new Map(sites.filter((site) => site.host).map((site) => [site.host, site]));
  const siteOf = (event) => siteById.get(event.site) ?? mainSite;
  const adminT = mainSite.t;

  // Vertsnavnet fra Host-headeren. Bevisst IKKE req.hostname: med «trust proxy» leser den
  // X-Forwarded-Host, som en klient kan sette selv og dermed late som den kom via et annet domene.
  const hostOf = (req) => (req.get('host') || '').toLowerCase().replace(/:\d+$/, '');

  // Hvert nettsted får sitt eget genererte temastilark. Navnet er en hash av innholdet, så det
  // ikke kan gjettes eller listes opp uten en gyldig arrangementslenke, og kan caches for alltid.
  const themeFiles = new Map();
  const cssHref = new Map();
  for (const site of sites) {
    const css = themeCss(site.theme);
    const file = `${createHash('sha256').update(css).digest('hex').slice(0, 20)}.css`;
    cssHref.set(site.id, `/assets/theme/${file}`);
    themeFiles.set(file, css);
  }
  const views = createViews(VIEWS);
  const csp = themeCspSources(sites.map((site) => site.theme));

  // ---------- Lenker ----------
  // Alle lenker bygges fra arrangementets nettsted – aldri fra DOMAIN direkte.
  // Hemmeligheter legges etter # i lenken. Den delen sendes aldri til serveren av nettleseren,
  // så den havner ikke i serverlogger, proxy-logger eller Referer-headere.
  const eventUrl = (event) => `${siteOf(event).baseUrl}/${event.slug}`;
  const cancelUrl = (event, token) => `${siteOf(event).baseUrl}/${event.slug}/avmelding#${token}`;
  // Med eget admin-vertsnavn peker admin-lenkene dit; ellers til arrangementets domene.
  const adminBaseUrl = (event) => (config.adminHost ? `https://${config.adminHost}` : siteOf(event).baseUrl);
  const adminUrl = (event, key) => `${adminBaseUrl(event)}/admin/${event.slug}#${key}`;

  // ---------- Svar uten innhold ----------
  // Uten en gyldig arrangementslenke skal et offentlig domene ikke avsløre noe som helst: forsiden,
  // ukjente adresser og ugyldige lenker får alle det samme nakne svaret – uten logo, navn eller språk.
  // Egen streng CSP: et tekstsvar kan ikke kjøre noe, og nettleseren får bruke sin innebygde
  // visningsstil for ren tekst (ellers logger Chromium en CSP-feil for hver 404).
  const notFound = (req, res) => res.status(404)
    .set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
    .type('text/plain')
    .send('Not Found');

  const sendPage = (res, name, site, status = 200) =>
    res.status(status).type('html').send(views(name, { ...site, cssHref: cssHref.get(site.id) }));

  // ---------- Felles mellomvare ----------

  // OPTIONS ville ellers svart «Allow: GET, HEAD» på adresser som finnes – og dermed røpet dem.
  app.use((req, res, next) => (req.method === 'OPTIONS' ? notFound(req, res) : next()));

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
    req.site = siteByHost.get(hostOf(req)) ?? mainSite;
    req.t = req.site.t;
    next();
  });

  app.use('/assets/custom', express.static(BRANDING, { maxAge: '1h' }));
  app.get('/assets/theme/:file', (req, res) => {
    const css = themeFiles.get(req.params.file);
    if (!css) return notFound(req, res);
    res.type('text/css').set('Cache-Control', 'public, max-age=31536000, immutable').send(css);
  });
  app.use('/assets', express.static(ASSETS, { maxAge: '1h' }));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  // ---------- Admin-porten ----------
  // Alt som har med administrasjon å gjøre ligger under /admin (sider) og /api/admin (API),
  // slik at én Cloudflare Access-regel – på et eget vertsnavn eller på disse stiene – dekker alt.

  function adminGate(kind) {
    return async (req, res, next) => {
      // Med eget admin-vertsnavn finnes ikke admin på de offentlige domenene i det hele tatt.
      if (config.adminHost && hostOf(req) !== config.adminHost) return notFound(req, res);
      req.t = adminT;
      if (accessVerifier) {
        try {
          req.accessUser = await accessVerifier(accessTokenFrom(req));
        } catch (err) {
          if (!(err instanceof AccessError)) logger.error('Cloudflare Access-sjekk feilet:', err);
          return kind === 'api'
            ? res.status(403).set('Cache-Control', 'no-store').json({ error: adminT('errors.accessDenied') })
            : sendPage(res, '403', mainSite, 403);
        }
      }
      next();
    };
  }

  // ---------- Sider ----------

  app.get('/admin', adminGate('page'), (req, res) => res.redirect('/admin/ny'));
  app.get('/admin/ny', adminGate('page'), (req, res) => sendPage(res, 'new', mainSite));
  app.get('/admin/:slug', adminGate('page'), (req, res) => {
    if (!findEventBySlug(req.params.slug)) return notFound(req, res);
    sendPage(res, 'admin', mainSite);
  });

  function findEventBySlug(value) {
    const slug = String(value).toLowerCase();
    return SLUG_PATTERN.test(slug) ? repo.findEvent(slug) : null;
  }

  // Gammel admin-adresse fra før admin ble samlet under /admin. Nettleseren tar med #nøkkelen videre.
  // Sendes bare videre for arrangementer som finnes, så adressen ikke kan brukes til å lete.
  app.get('/:slug/admin', (req, res) => {
    const event = findEventBySlug(req.params.slug);
    if (!event) return notFound(req, res);
    res.redirect(301, `${config.adminHost ? adminBaseUrl(event) : ''}/admin/${event.slug}`);
  });

  // Arrangementssiden og avmeldingssiden. Åpnes et arrangement på feil domene, sendes nettleseren
  // videre til arrangementets eget domene (301), med samme sti – og nettleseren tar med #nøkkelen.
  const eventPage = (view) => (req, res) => {
    const event = findEventBySlug(req.params.slug);
    if (!event) return notFound(req, res);
    const site = siteOf(event);
    if (site !== req.site) return res.redirect(301, `${site.baseUrl}${req.originalUrl}`);
    sendPage(res, view, site);
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
  const limiter = (options) => rateLimit({ ...options, key: clientKey, message: (req) => req.t('errors.rateLimited') });
  const registerLimiter = limiter(limits.register);
  const cancelLimiter = limiter(limits.cancel);
  const createLimiter = limiter(limits.create);

  // Offentlig API: et ukjent arrangement gir det samme nakne svaret som en ukjent side. Finnes det,
  // brukes arrangementets nettsted (språk, tema, avsender) for resten av forespørselen.
  function loadPublicEvent(req, res, next) {
    const event = findEventBySlug(req.params.slug);
    if (!event) return notFound(req, res);
    req.event = event;
    req.eventSite = siteOf(event);
    req.t = req.eventSite.t;
    next();
  }

  function loadAdminEvent(req, res, next) {
    const event = findEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: adminT('errors.eventNotFound') });
    req.event = event;
    next();
  }

  // Admin-nøkkelen for et arrangement sendes som «Authorization: Bearer <nøkkel>».
  function requireEventAdmin(req, res, next) {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!match || !secretMatches(match[1], req.event.adminKeyHash)) {
      return res.status(401).json({ error: adminT('errors.invalidAdminLink') });
    }
    next();
  }

  // Oppretting av nye arrangementer krever ADMIN_PASSWORD. Når Cloudflare Access verifiseres
  // (adminGate har allerede sluppet forespørselen gjennom), kan passordet droppes.
  function requireCreator(req, res, next) {
    if (config.adminPassword) {
      if (!secretMatches(req.get('x-admin-password') || '', hashSecret(config.adminPassword))) {
        return res.status(401).json({ error: adminT('errors.wrongPassword') });
      }
      return next();
    }
    if (accessVerifier) return next();
    return res.status(403).json({ error: adminT('errors.creationDisabled') });
  }

  function publicEvent(event, count) {
    const { showCount, capacity } = event;
    return {
      slug: event.slug,
      url: eventUrl(event),
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
      site: siteOf(event).id,
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

  api.get('/events/:slug', loadPublicEvent, (req, res) => {
    res.json(publicEvent(req.event, repo.countRegistrations(req.event.id)));
  });

  // Feilmelding når hele gruppen ikke får plass. Antallet ledige plasser nevnes bare hvis arrangøren
  // viser antall påmeldte offentlig.
  function notEnoughSpots(req, spotsLeft) {
    const { event, t } = req;
    if (spotsLeft <= 0) return { error: t('status.full'), status: 'full' };
    const error = event.showCount ? t('errors.notEnough', { count: spotsLeft }) : t('errors.notEnoughHidden');
    return { error, status: 'not_enough', ...(event.showCount && { spotsLeft }) };
  }

  // En påmelding består av kontaktpersonen (name, email, answers) og eventuelle personer
  // som er lagt til (guests). Hver person blir én gjest og tar én plass.
  api.post('/events/:slug/registrations', loadPublicEvent, registerLimiter, async (req, res) => {
    const { event, eventSite: site, t } = req;

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
    if (status !== 'open') return res.status(409).json({ error: t(`status.${status}`), status });
    const requested = 1 + (Array.isArray(req.body?.guests) ? req.body.guests.length : 0);
    if (event.capacity != null && count + requested > event.capacity) {
      return res.status(409).json(notEnoughSpots(req, event.capacity - count));
    }

    const { contact, persons } = validateBooking(req.body, event.fields, event.maxPerBooking);
    const cancelToken = newSecret(18);
    const booking = { contactName: contact.name, contactEmail: contact.email, persons };

    let result;
    try {
      result = repo.register(event, { ...booking, cancelTokenHash: hashSecret(cancelToken) });
    } catch (err) {
      if (err instanceof CapacityError) return res.status(409).json(notEnoughSpots(req, err.spotsLeft));
      throw err;
    }

    const [guestSent] = await sendEmails([
      templates.guestConfirmation({
        event,
        booking,
        eventUrl: eventUrl(event),
        cancelUrl: cancelUrl(event, cancelToken),
        timeZone: config.timeZone,
        site,
      }),
      templates.organizerNotification({ event, booking, count: result.count, site }),
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

  // Viser hvem avmeldingslenken gjelder før gjesten bekrefter. Avmeldingen skjer først ved POST
  // til /cancel – mange e-posttjenester åpner lenker automatisk for å sjekke dem for virus,
  // og det skal ikke melde noen av.
  api.post('/events/:slug/cancel/lookup', loadPublicEvent, cancelLimiter, (req, res) => {
    const booking = findBooking(req);
    if (!booking) return res.status(404).json({ error: req.t('errors.cancelNotFound') });
    res.json({
      contactName: booking.contactName,
      persons: booking.persons.map(({ id, name }) => ({ id, name })),
      event: publicEvent(req.event, repo.countRegistrations(req.event.id)),
    });
  });

  // body: { token, ids? } – uten ids meldes hele påmeldingen av, ellers bare de valgte personene.
  api.post('/events/:slug/cancel', loadPublicEvent, cancelLimiter, async (req, res) => {
    const { event, eventSite: site, t } = req;
    const booking = findBooking(req);
    if (!booking) return res.status(404).json({ error: t('errors.cancelNotFound') });

    let ids = booking.persons.map((p) => p.id);
    if (req.body.ids !== undefined) {
      if (!Array.isArray(req.body.ids) || !req.body.ids.every(Number.isInteger)) {
        return res.status(400).json({ error: t('errors.invalidSelection') });
      }
      ids = req.body.ids.filter((id) => ids.includes(id)); // Bare personer i denne påmeldingen.
      if (!ids.length) return res.status(400).json({ error: t('errors.selectSomeone') });
    }

    const cancelled = repo.deleteFromBooking(event.id, booking.id, ids);
    if (!cancelled.length) return res.status(404).json({ error: t('errors.cancelNotFound') });
    const remaining = booking.persons.filter((p) => !cancelled.some((c) => c.id === p.id));

    const count = repo.countRegistrations(event.id);
    await sendEmails([
      templates.guestCancellation({ event, booking, cancelled, remaining, eventUrl: eventUrl(event), site }),
      templates.organizerCancellation({ event, booking, cancelled, count, site }),
    ]);
    res.json({
      cancelled: cancelled.map(({ name }) => ({ name })),
      remaining: remaining.map(({ id, name }) => ({ id, name })),
      event: publicEvent(event, count),
    });
  });

  // ---------- API: administrasjon ----------

  const siteIds = sites.map((site) => site.id);

  adminApi.get('/config', (req, res) => res.json({
    timeZone: config.timeZone,
    passwordRequired: Boolean(config.adminPassword),
    accessEmail: req.accessUser?.email ?? null,
    // Nettstedene arrangøren kan velge mellom. Hovednettstedet først.
    sites: sites.map(({ id, label, lang, baseUrl }) => ({ id, label, lang, baseUrl })),
  }));

  adminApi.post('/events', createLimiter, requireCreator, async (req, res) => {
    const data = validateEvent(req.body, { siteIds });
    let slug = newSlug();
    while (repo.findEvent(slug)) slug = newSlug(); // Kollisjon er svært usannsynlig, men sjekkes likevel.
    const adminKey = newSecret();

    const event = repo.createEvent({ ...data, slug, adminKeyHash: hashSecret(adminKey) });
    const urls = { eventUrl: eventUrl(event), adminUrl: adminUrl(event, adminKey) };
    const [emailSent] = await sendEmails([
      templates.eventCreated({ event, ...urls, timeZone: config.timeZone, site: siteOf(event) }),
    ]);

    res.status(201).json({ slug, adminKey, ...urls, emailSent });
  });

  adminApi.get('/events/:slug', loadAdminEvent, requireEventAdmin, (req, res) => {
    const registrations = repo.listRegistrations(req.event.id);
    res.json({
      event: adminEvent(req.event, registrations.length),
      registrations: registrations.map(({ id, bookingId, position, name, email, answers, createdAt, contactName, contactEmail }) =>
        ({ id, bookingId, position, name, email, answers, createdAt, contactName, contactEmail })),
    });
  });

  adminApi.put('/events/:slug', loadAdminEvent, requireEventAdmin, (req, res) => {
    const data = validateEvent(req.body, { siteIds });
    repo.updateEvent(req.event.id, data);
    const event = repo.findEvent(req.event.slug);
    res.json({ event: adminEvent(event, repo.countRegistrations(event.id)) });
  });

  adminApi.delete('/events/:slug', loadAdminEvent, requireEventAdmin, (req, res) => {
    repo.deleteEvent(req.event.id);
    res.json({ ok: true });
  });

  adminApi.delete('/events/:slug/registrations/:id', loadAdminEvent, requireEventAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !repo.deleteRegistration(req.event.id, id)) {
      return res.status(404).json({ error: adminT('errors.registrationNotFound') });
    }
    res.json({ ok: true, count: repo.countRegistrations(req.event.id) });
  });

  adminApi.get('/events/:slug/registrations.csv', loadAdminEvent, requireEventAdmin, (req, res) => {
    const csv = registrationsToCsv(req.event, repo.listRegistrations(req.event.id), config.timeZone, mainSite.lang);
    res.type('text/csv; charset=utf-8');
    res.attachment(adminT('csv.filename', { slug: req.event.slug }));
    res.send(csv);
  });

  // Feil i API-et blir alltid til JSON, med melding på språket forespørselen gjelder (req.t).
  const apiErrors = (err, req, res, next) => {
    const t = req.t ?? adminT;
    if (err instanceof ValidationError) return res.status(400).json({ error: t(err.message), errors: translateErrors(err.errors, t) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: t('errors.invalidJson') });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: t('errors.tooLarge') });
    logger.error(err);
    res.status(500).json({ error: t('errors.server') });
  };
  // Kroppen tolkes før arrangementet slås opp, så en feil der (f.eks. ugyldig JSON) kan komme før
  // loadPublicEvent har kjørt. Arrangementet hentes da fra adressen: finnes det ikke, får man det
  // samme nakne svaret som alt annet uten gyldig lenke – ellers en vanlig feilmelding på nettstedets språk.
  api.use(notFound, (err, req, res, next) => {
    const event = req.event ?? findEventBySlug(/^\/events\/([^/]+)/.exec(req.path)?.[1] ?? '');
    if (!event) return notFound(req, res);
    req.t = siteOf(event).t;
    return apiErrors(err, req, res, next);
  });
  adminApi.use((req, res) => res.status(404).json({ error: adminT('errors.unknownPath') }), apiErrors);

  // /api/admin før /api, slik at admin-forespørsler alltid går gjennom admin-porten.
  app.use('/api/admin', adminApi);
  app.use('/api', api);

  // Alt annet – også forsiden – finnes ikke.
  app.use(notFound);

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

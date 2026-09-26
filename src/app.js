import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CapacityError } from './db.js';
import { registrationsToCsv } from './csv.js';
import * as templates from './email.js';
import { hashSecret, newSecret, newSlug, secretMatches, SLUG_PATTERN } from './ids.js';
import { rateLimit } from './rateLimit.js';
import { registrationStatus, validateEvent, validateRegistration, ValidationError } from './validation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'views');
const ASSETS = path.join(ROOT, 'public', 'assets');

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

export function createApp({ repo, mailer, config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const eventUrl = (slug) => `${config.baseUrl}/${slug}`;
  // Hemmeligheter legges etter # i lenken. Den delen sendes aldri til serveren av nettleseren,
  // så den havner ikke i serverlogger, proxy-logger eller Referer-headere.
  const adminUrl = (slug, key) => `${config.baseUrl}/${slug}/admin#${key}`;
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
        "style-src 'self' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' https: data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });

  app.use('/assets', express.static(ASSETS, { maxAge: '1h' }));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  // ---------- Sider ----------

  const sendPage = (res, name, status = 200) => res.status(status).sendFile(path.join(VIEWS, `${name}.html`));

  app.get('/', (req, res) => sendPage(res, 'index'));
  app.get('/ny', (req, res) => sendPage(res, 'new'));

  const eventPage = (name) => (req, res, next) => {
    const slug = req.params.slug.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return next();
    if (!repo.findEvent(slug)) return sendPage(res, '404', 404);
    sendPage(res, name);
  };
  app.get('/:slug', eventPage('event'));
  app.get('/:slug/admin', eventPage('admin'));
  app.get('/:slug/avmelding', eventPage('cancel'));

  // ---------- API: hjelpefunksjoner ----------

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const limits = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  const registerLimiter = rateLimit(limits.register);
  const cancelLimiter = rateLimit(limits.cancel);
  const createLimiter = rateLimit(limits.create);

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

  // Oppretting av nye arrangementer krever det globale passordet fra ADMIN_PASSWORD.
  function requireAdminPassword(req, res, next) {
    if (!config.adminPassword) {
      return res.status(403).json({ error: 'Oppretting av arrangementer er slått av (ADMIN_PASSWORD er ikke satt på serveren).' });
    }
    if (!secretMatches(req.get('x-admin-password') || '', hashSecret(config.adminPassword))) {
      return res.status(401).json({ error: 'Feil passord.' });
    }
    next();
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

  api.get('/events/:slug', loadEvent, (req, res) => {
    res.json(publicEvent(req.event, repo.countRegistrations(req.event.id)));
  });

  api.post('/events/:slug/registrations', registerLimiter, loadEvent, async (req, res) => {
    const { event } = req;

    // Honningkrukke: et skjult felt som mennesker ikke ser, men som roboter gjerne fyller ut.
    // Vi later som alt gikk bra, slik at roboten ikke lærer noe.
    if (req.body?.website) {
      return res.status(201).json({ registration: { name: '', email: '' }, emailSent: true, event: publicEvent(event, repo.countRegistrations(event.id)) });
    }

    // Rask sjekk før validering, så gjesten får «fullt»/«stengt» i stedet for feltfeil.
    // Selve plassen reserveres likevel trygt inne i transaksjonen i repo.register().
    const status = registrationStatus(event, repo.countRegistrations(event.id));
    if (status !== 'open') return res.status(409).json({ error: STATUS_MESSAGES[status], status });

    const data = validateRegistration(req.body, event.fields);
    const cancelToken = newSecret(18);

    let result;
    try {
      result = repo.register(event, { ...data, cancelTokenHash: hashSecret(cancelToken) });
    } catch (err) {
      if (err instanceof CapacityError) return res.status(409).json({ error: STATUS_MESSAGES.full, status: 'full' });
      throw err;
    }

    const registration = { ...data, id: result.id };
    const [guestSent] = await sendEmails([
      templates.guestConfirmation({
        event,
        registration,
        eventUrl: eventUrl(event.slug),
        cancelUrl: cancelUrl(event.slug, cancelToken),
        timeZone: config.timeZone,
      }),
      templates.organizerNotification({ event, registration, count: result.count, adminHint, timeZone: config.timeZone }),
    ]);

    res.status(201).json({
      registration: { name: data.name, email: data.email },
      emailSent: guestSent,
      event: publicEvent(event, result.count),
    });
  });

  function findByToken(req) {
    const token = req.body?.token;
    return typeof token === 'string' && token ? repo.findRegistrationByToken(req.event.id, hashSecret(token)) : null;
  }
  const notFoundCancel = 'Fant ingen påmelding for denne lenken. Kanskje du allerede er meldt av?';

  // Viser hvem avmeldingslenken gjelder før gjesten bekrefter. Avmeldingen skjer først ved POST
  // til /cancel – mange e-posttjenester åpner lenker automatisk for å sjekke dem for virus,
  // og det skal ikke melde noen av.
  api.post('/events/:slug/cancel/lookup', cancelLimiter, loadEvent, (req, res) => {
    const registration = findByToken(req);
    if (!registration) return res.status(404).json({ error: notFoundCancel });
    res.json({ name: registration.name, event: publicEvent(req.event, repo.countRegistrations(req.event.id)) });
  });

  api.post('/events/:slug/cancel', cancelLimiter, loadEvent, async (req, res) => {
    const { event } = req;
    const registration = findByToken(req);
    if (!registration) return res.status(404).json({ error: notFoundCancel });

    repo.deleteRegistration(event.id, registration.id);
    const count = repo.countRegistrations(event.id);
    await sendEmails([
      templates.guestCancellation({ event, registration, eventUrl: eventUrl(event.slug) }),
      templates.organizerCancellation({ event, registration, count }),
    ]);
    res.json({ ok: true, event: publicEvent(event, count) });
  });

  // ---------- API: administrasjon ----------

  api.post('/events', createLimiter, requireAdminPassword, async (req, res) => {
    const data = validateEvent(req.body);
    let slug = newSlug();
    while (repo.findEvent(slug)) slug = newSlug(); // Kollisjon er svært usannsynlig, men sjekkes likevel.
    const adminKey = newSecret();

    const event = repo.createEvent({ ...data, slug, adminKeyHash: hashSecret(adminKey) });
    const urls = { eventUrl: eventUrl(slug), adminUrl: adminUrl(slug, adminKey) };
    const [emailSent] = await sendEmails([templates.eventCreated({ event, ...urls, timeZone: config.timeZone })]);

    res.status(201).json({ slug, adminKey, ...urls, emailSent });
  });

  api.get('/events/:slug/admin', loadEvent, requireEventAdmin, (req, res) => {
    const registrations = repo.listRegistrations(req.event.id);
    res.json({
      event: adminEvent(req.event, registrations.length),
      registrations: registrations.map(({ id, name, email, answers, createdAt }) => ({ id, name, email, answers, createdAt })),
    });
  });

  api.put('/events/:slug/admin', loadEvent, requireEventAdmin, (req, res) => {
    const data = validateEvent(req.body);
    repo.updateEvent(req.event.id, data);
    const event = repo.findEvent(req.event.slug);
    res.json({ event: adminEvent(event, repo.countRegistrations(event.id)) });
  });

  api.delete('/events/:slug/admin', loadEvent, requireEventAdmin, (req, res) => {
    repo.deleteEvent(req.event.id);
    res.json({ ok: true });
  });

  api.delete('/events/:slug/admin/registrations/:id', loadEvent, requireEventAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !repo.deleteRegistration(req.event.id, id)) {
      return res.status(404).json({ error: 'Fant ikke påmeldingen.' });
    }
    res.json({ ok: true, count: repo.countRegistrations(req.event.id) });
  });

  api.get('/events/:slug/admin/registrations.csv', loadEvent, requireEventAdmin, (req, res) => {
    const csv = registrationsToCsv(req.event, repo.listRegistrations(req.event.id), config.timeZone);
    res.type('text/csv; charset=utf-8');
    res.attachment(`pameldte-${req.event.slug}.csv`);
    res.send(csv);
  });

  api.use((req, res) => res.status(404).json({ error: 'Ukjent adresse.' }));

  // Feil i API-et blir alltid til JSON med en norsk feilmelding.
  api.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, errors: err.errors });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ugyldig JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Forespørselen er for stor.' });
    logger.error(err);
    res.status(500).json({ error: 'Noe gikk galt på serveren. Prøv igjen senere.' });
  });

  app.use('/api', api);

  app.use((req, res) => sendPage(res, '404', 404));

  return app;
}

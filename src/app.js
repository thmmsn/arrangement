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
import { ImageError, MAX_IMAGE_BYTES, processImage } from './images.js';
import { createLogoLoader } from './logo.js';
import { createPlaceSearch } from './places.js';
import { loadSites } from './sites.js';
import { loadSkins, skinName } from './skins.js';
import { themeCspSources, themeCss } from './theme.js';
import { createTicketFeature } from './tickets.js';
import { createTokens } from './tokens.js';
import { createViews } from './views.js';
import {
  deadlineOf, isLate, registrationStatus, translateErrors, validateBooking, validateEvent, ValidationError,
} from './validation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'views');
const ASSETS = path.join(ROOT, 'public', 'assets');
// Egne filer (logo, favicon, CSS) fra ./branding, tilgjengelige som /assets/custom/<fil>.
const BRANDING = path.join(ROOT, 'branding');
// Skins (utseender per arrangement): de innebygde, og eierens egne i ./skins (se docs/skins.md).
const BUILTIN_SKINS = path.join(ASSETS, 'skins');
const CUSTOM_SKINS = path.join(ROOT, 'skins');
// jsQR leser QR-koder i nettleseren på skannersiden (når nettleseren ikke har BarcodeDetector).
const JSQR = path.join(ROOT, 'node_modules', 'jsqr', 'dist', 'jsQR.js');
const DAY = 86_400_000;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Maks antall forespørsler per IP-adresse innenfor tidsvinduet. Kan overstyres via config.rateLimits.
const DEFAULT_RATE_LIMITS = {
  register: { windowMs: 10 * 60_000, max: 30 },
  cancel: { windowMs: 10 * 60_000, max: 30 },
  create: { windowMs: 15 * 60_000, max: 20 },
  scanner: { windowMs: 10 * 60_000, max: 30 }, // innlogging med dørvaktlenken
};

export function createApp({
  repo, mailer, config, logger = console, accessVerifier = defaultAccessVerifier(config), placeSearch = createPlaceSearch(),
}) {
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
  const { skins, warnings: skinWarnings } = loadSkins({ dirs: config.skinDirs ?? [BUILTIN_SKINS, CUSTOM_SKINS] });
  for (const warning of skinWarnings) logger.warn?.(`ADVARSEL: ${warning}`);
  const skinFiles = new Map([...skins.values()].map((skin) => [skin.file, skin.css]));
  const csp = themeCspSources(sites.map((site) => site.theme));

  // ---------- Lenker ----------
  // Alle lenker bygges fra arrangementets nettsted – aldri fra DOMAIN direkte.
  // Hemmeligheter legges etter # i lenken. Den delen sendes aldri til serveren av nettleseren,
  // så den havner ikke i serverlogger, proxy-logger eller Referer-headere.
  const eventUrl = (event) => `${siteOf(event).baseUrl}/${event.slug}`;
  // Forsidebildet: et opplastet bilde (på arrangementets eget domene) går foran en lenke.
  const uploadedImageUrl = (event) => {
    const image = repo.imageMeta(event.id);
    return image ? `${eventUrl(event)}/bilde/${image.hash}.${IMAGE_EXT[image.type]}` : null;
  };
  const imageUrlOf = (event) => uploadedImageUrl(event) ?? event.imageUrl;
  // Med eget admin-vertsnavn peker admin-lenkene dit; ellers til arrangementets domene.
  const adminBaseUrl = (event) => (config.adminHost ? `https://${config.adminHost}` : siteOf(event).baseUrl);
  const adminUrl = (event, key) => `${adminBaseUrl(event)}/admin/${event.slug}#${key}`;
  // Samme admin-side, åpnet rett på «Avlys arrangement».
  const cancelEventUrl = (event, key) => `${adminBaseUrl(event)}/admin/${event.slug}/avlys#${key}`;

  // ---------- Svar uten innhold ----------
  // Uten en gyldig arrangementslenke skal et offentlig domene ikke avsløre noe som helst: forsiden,
  // ukjente adresser og ugyldige lenker får alle det samme nakne svaret – uten logo, navn eller språk.
  // Egen streng CSP: et tekstsvar kan ikke kjøre noe, og nettleseren får bruke sin innebygde
  // visningsstil for ren tekst (ellers logger Chromium en CSP-feil for hver 404).
  const notFound = (req, res) => res.status(404)
    .set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
    .type('text/plain')
    .send('Not Found');

  // `event` (valgfritt) gir arrangementets skin, lagt oppå nettstedets tema.
  const sendPage = (res, name, site, status = 200, event = null) => {
    const skinHref = (event?.skin && skins.get(event.skin)?.href) || '';
    res.status(status).type('html').send(views(name, { ...site, cssHref: cssHref.get(site.id), skinHref }));
  };

  // ---------- Oppbevaring ----------
  // Alle data om et arrangement slettes så mange dager etter at det er over (DELETE_AFTER_DAYS).
  const deleteAfterDays = config.deleteAfterDays ?? 30;
  const deleteAt = (event) => new Date(Date.parse(event.endsAt || event.startsAt) + deleteAfterDays * DAY);

  // Klientens IP til rate limiting. Bak Cloudflare Tunnel kommer alle forespørsler fra cloudflared,
  // så den ekte adressen må hentes fra headeren Cloudflare setter (CLIENT_IP_HEADER).
  const clientKey = (req) => (config.clientIpHeader && req.get(config.clientIpHeader)) || req.ip;
  const limits = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  const limiter = (options) => rateLimit({ ...options, key: clientKey, message: (req) => req.t('errors.rateLimited') });

  // ---------- Billetter, kalender, Wallet og innsjekking (se tickets.js) ----------
  const tokens = createTokens(repo.secret());
  // Logoen til PDF-billetten. Hentes med én gang for hvert nettsted, så en logo som ikke kan brukes
  // i PDF (feil sti, WebP …) gir en advarsel i loggen ved oppstart – ikke først når noen melder seg på.
  const logoFor = createLogoLoader({ brandingDir: BRANDING, assetsDir: ASSETS, logger });
  for (const site of sites) logoFor(site.theme);
  const tickets = createTicketFeature({
    repo, config, tokens, siteOf, eventUrl, imageUrlOf, findEventBySlug, notFound, sendPage, logger, adminT, placeSearch, limiter, limits,
    logoFor,
  });

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
        // blob: trengs for forhåndsvisning av et bilde før det lastes opp (admin-skjemaet).
        "img-src 'self' https: data: blob:",
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
  app.get('/assets/skins/:file', (req, res) => {
    const css = skinFiles.get(req.params.file);
    if (!css) return notFound(req, res);
    res.type('text/css').set('Cache-Control', 'public, max-age=31536000, immutable').send(css);
  });
  app.get('/assets/vendor/jsqr.js', (req, res) => res.set('Cache-Control', 'public, max-age=86400').type('text/javascript').sendFile(JSQR));
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
  const adminPage = (req, res) => {
    if (!findEventBySlug(req.params.slug)) return notFound(req, res);
    sendPage(res, 'admin', mainSite);
  };
  app.get('/admin/:slug', adminGate('page'), adminPage);
  app.get('/admin/:slug/avlys', adminGate('page'), adminPage);

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

  tickets.mountPages(app);

  // Arrangementssiden og avmeldingssiden. Åpnes et arrangement på feil domene, sendes nettleseren
  // videre til arrangementets eget domene (301), med samme sti – og nettleseren tar med #nøkkelen.
  const eventPage = (view) => (req, res) => {
    const event = findEventBySlug(req.params.slug);
    if (!event) return notFound(req, res);
    const site = siteOf(event);
    if (site !== req.site) return res.redirect(301, `${site.baseUrl}${req.originalUrl}`);
    sendPage(res, view, site, 200, event);
  };
  // Opplastet forsidebilde. Adressen har en hash av innholdet, så et nytt bilde får ny adresse.
  // «private»: bildet skal ikke ligge igjen i en delt mellomlagring (f.eks. hos Cloudflare) etter at
  // arrangementet er slettet.
  app.get('/:slug/bilde/:file', (req, res) => {
    const event = findEventBySlug(req.params.slug);
    const image = event && repo.image(event.id);
    if (!image || req.params.file !== `${image.hash}.${IMAGE_EXT[image.type]}`) return notFound(req, res);
    const site = siteOf(event);
    if (site !== req.site) return res.redirect(301, `${site.baseUrl}${req.originalUrl}`);
    res.type(image.type).set('Cache-Control', 'private, max-age=86400').send(image.data);
  });
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

  // Oppretting av nye arrangementer krever Cloudflare Access (adminGate har da allerede verifisert
  // tokenet). Uten Access er oppretting slått av – med mindre ADMIN_NO_AUTH=true er satt for lokal
  // utvikling. Slik blir en glemt innstilling aldri til at hvem som helst kan opprette arrangementer
  // og sende e-post i ditt navn.
  function requireCreator(req, res, next) {
    if (accessVerifier || config.adminNoAuth) return next();
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
      imageUrl: imageUrlOf(event),
      fields: event.fields,
      maxPerBooking: event.maxPerBooking,
      timeZone: config.timeZone,
      geo: event.geo,
      // Kalender og veibeskrivelse: bare offentlig informasjon, samme for alle.
      links: publicLinks(event),
      status: registrationStatus(event, count),
      // Åpen etter fristen fordi arrangøren tillater etteranmelding.
      late: registrationStatus(event, count) === 'open' && isLate(event),
      cancelled: Boolean(event.cancelledAt),
      // Arrangøren kan skjule antallet. Da skjules også kapasiteten, siden den sammen med
      // «fullt»-statusen ellers ville røpet mye av det samme.
      count: showCount ? count : null,
      capacity: showCount ? capacity : null,
      spotsLeft: showCount && capacity != null ? Math.max(0, capacity - count) : null,
    };
  }

  function publicLinks(event) {
    const { ics, googleCalendar, directions, appleDirections } = tickets.links(event, '');
    return { ics, googleCalendar, directions, appleDirections };
  }

  function adminEvent(event, count) {
    return {
      ...publicEvent(event, count),
      features: event.features,
      // Lenken arrangøren har skrevet inn, og et eventuelt opplastet bilde (som går foran).
      imageUrl: event.imageUrl,
      uploadedImage: uploadedImageUrl(event),
      // Dørvaktlenken kan alltid vises på nytt: nøkkelen er avledet (se tokens.js).
      scannerUrl: event.features.tickets ? tickets.scannerUrl(event) : null,
      checkedIn: repo.countCheckedIn(event.id),
      count,
      capacity: event.capacity,
      spotsLeft: event.capacity != null ? Math.max(0, event.capacity - count) : null,
      showCount: event.showCount,
      isOpen: event.isOpen,
      organizerEmail: event.organizerEmail,
      site: siteOf(event).id,
      allowLate: event.allowLate,
      skin: event.skin,
      cancelledAt: event.cancelledAt,
      cancelMessage: event.cancelMessage,
      reportAt: deadlineOf(event).toISOString(),
      reportSentAt: event.deadlineReportSentAt,
      deleteAt: deleteAt(event).toISOString(),
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
    const booking = { contactName: contact.name, contactEmail: contact.email, persons };
    // Etter fristen (når arrangøren tillater det): merkes, og arrangøren får «Etteranmelding» i emnet.
    const late = isLate(event);

    let result;
    try {
      result = repo.register(event, { ...booking, late });
    } catch (err) {
      if (err instanceof CapacityError) return res.status(409).json(notEnoughSpots(req, err.spotsLeft));
      throw err;
    }

    // Billettside, Wallet, kalender, PDF-vedlegg og avmelding – etter arrangementets brytere.
    const extras = await tickets.confirmationExtras(event, result.bookingCode);
    const [guestSent] = await sendEmails([
      {
        ...templates.guestConfirmation({
          event,
          // Den som meldte på, får alt for hver person: dørkode, billett, Wallet, PDF og avmelding
          // – til å videresende. Arrangøren trenger ingen av delene.
          booking: {
            ...booking,
            persons: persons.map((p, i) => ({
              ...p, doorCode: event.features.tickets ? result.persons[i].doorCode : null, links: extras.persons[i],
            })),
          },
          eventUrl: eventUrl(event),
          timeZone: config.timeZone,
          site,
          links: extras.links,
        }),
        attachments: extras.attachments,
      },
      templates.organizerNotification({ event, booking, count: result.count, site, late }),
    ]);

    res.status(201).json({
      booking: { contactName: contact.name, contactEmail: contact.email, persons: persons.map(({ name }) => ({ name })) },
      emailSent: guestSent,
      // Den som meldte på, får billettene, Wallet, PDF og avmelding med én gang – som i e-posten.
      links: extras.links,
      event: publicEvent(event, result.count),
    });
  });

  /**
   * Påmeldingen avmeldingsnøkkelen gjelder (se tokens.js), med personene nøkkelen kan melde av:
   * - påmeldingens nøkkel (i e-posten, etter påmeldingen og på siden med alle billettene): alle
   * - én persons nøkkel (i e-posten, til å videresende sammen med billetten): bare den personen
   * Nøkkelen står etter # i adressen og sendes i forespørselen. Returnerer påmeldingen, eller null.
   */
  function findBooking(req) {
    const token = req.body?.token;
    const bookingCode = tokens.parseCancelBooking(token);
    const ticketCode = !bookingCode && tokens.parseCancelTicket(token);
    let booking = null;
    if (bookingCode) booking = repo.findBookingByCode(bookingCode);
    if (ticketCode) {
      const person = repo.findRegistrationByCode(ticketCode);
      const whole = person && repo.findBookingByCode(person.bookingCode);
      booking = whole && { ...whole, personal: true, persons: whole.persons.filter((p) => p.id === person.id) };
    }
    if (!booking || booking.eventId !== req.event.id || !booking.persons.length) return null;
    return booking;
  }

  // Arrangøren kan slå av avmelding på nettet. Da må gjesten svare på bekreftelsen i stedet.
  function selfCancelAllowed(req, res) {
    if (req.event.features.selfCancel) return true;
    res.status(403).json({ error: req.t('errors.selfCancelDisabled'), selfCancelDisabled: true });
    return false;
  }

  // Viser hvem avmeldingslenken gjelder før gjesten bekrefter. Avmeldingen skjer først ved POST
  // til /cancel – mange e-posttjenester åpner lenker automatisk for å sjekke dem for virus,
  // og det skal ikke melde noen av.
  api.post('/events/:slug/cancel/lookup', loadPublicEvent, cancelLimiter, (req, res) => {
    if (!selfCancelAllowed(req, res)) return;
    const booking = findBooking(req);
    if (!booking) return res.status(404).json({ error: req.t('errors.cancelNotFound') });
    res.json({
      contactName: booking.contactName,
      // Én persons egen lenke, videresendt av den som meldte på: siden snakker til personen selv.
      personal: Boolean(booking.personal),
      persons: booking.persons.map(({ id, name }) => ({ id, name })),
      event: publicEvent(req.event, repo.countRegistrations(req.event.id)),
    });
  });

  // body: { token, ids? } – uten ids meldes hele påmeldingen av, ellers bare de valgte personene.
  api.post('/events/:slug/cancel', loadPublicEvent, cancelLimiter, async (req, res) => {
    const { event, eventSite: site, t } = req;
    if (!selfCancelAllowed(req, res)) return;
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

  tickets.mountApi(api, { loadPublicEvent });

  // ---------- API: administrasjon ----------

  const siteIds = sites.map((site) => site.id);

  adminApi.get('/config', (req, res) => res.json({
    timeZone: config.timeZone,
    accessEmail: req.accessUser?.email ?? null,
    // Nettstedene arrangøren kan velge mellom. Hovednettstedet først.
    sites: sites.map(({ id, label, lang, baseUrl }) => ({ id, label, lang, baseUrl })),
    // Utseender arrangøren kan velge, med navn på admin-språket og farger til forhåndsvisningen.
    skins: [...skins.values()].map((skin) => ({ id: skin.id, name: skinName(skin, mainSite.lang), preview: skin.preview })),
    deleteAfterDays,
    // Wallet-bryterne vises bare når tjenesten er satt opp.
    wallets: { apple: Boolean(config.wallet?.apple), google: Boolean(config.wallet?.google) },
  }));

  const skinIds = [...skins.keys()];

  // Til tjenesteadministratoren(e) (ADMIN_EMAIL): samme innhold, med adressen byttet ut.
  const toAdmins = (message) => config.adminEmails?.length
    ? config.adminEmails.map((to) => ({ ...message, to, replyTo: undefined }))
    : [];

  adminApi.post('/events', createLimiter, requireCreator, async (req, res) => {
    const data = validateEvent(req.body, { siteIds, skinIds });
    let slug = newSlug();
    while (repo.findEvent(slug)) slug = newSlug(); // Kollisjon er svært usannsynlig, men sjekkes likevel.
    const adminKey = newSecret();

    const event = repo.createEvent({ ...data, slug, adminKeyHash: hashSecret(adminKey) });
    const urls = { eventUrl: eventUrl(event), adminUrl: adminUrl(event, adminKey) };
    // Den første e-posten inneholder alt arrangøren trenger senere: admin-lenken finnes bare her.
    const details = {
      event,
      ...urls,
      cancelEventUrl: cancelEventUrl(event, adminKey),
      scannerUrl: event.features.tickets ? tickets.scannerUrl(event) : null,
      reportAt: deadlineOf(event),
      deleteAt: deleteAt(event),
      timeZone: config.timeZone,
    };
    const [emailSent] = await sendEmails([
      templates.eventCreated({ ...details, site: siteOf(event) }),
      // Tjenesteadministratoren varsles om hvert nye arrangement, med de samme lenkene – på
      // hovednettstedets språk.
      ...toAdmins(templates.eventCreated({ ...details, site: mainSite, forAdmin: true, createdBy: req.accessUser?.email ?? null })),
    ]);

    res.status(201).json({ slug, adminKey, ...urls, scannerUrl: details.scannerUrl, emailSent });
  });

  // Avlys arrangementet: påmeldingen stenges, billettene slutter å virke og kalenderfilen blir
  // «avlyst». body: { notify: boolean, message?: string } – med notify får hver påmelding en e-post
  // med arrangørens melding. Arrangøren og tjenesteadministratoren får en kvittering.
  const MAX_CANCEL_MESSAGE = 2000;
  adminApi.post('/events/:slug/cancel', loadAdminEvent, requireEventAdmin, async (req, res) => {
    const { event } = req;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (message.length > MAX_CANCEL_MESSAGE) {
      throw new ValidationError({ cancelMessage: { key: 'cancelMessageTooLong', vars: { max: MAX_CANCEL_MESSAGE } } });
    }
    if (event.cancelledAt) return res.json({ event: adminEvent(event, repo.countRegistrations(event.id)), notified: 0 });

    repo.setCancelled(event.id, new Date().toISOString(), message || null);
    const cancelled = repo.findEventById(event.id);
    const site = siteOf(cancelled);

    // Én e-post per påmelding, til den som meldte på.
    const bookings = [...new Map(repo.listRegistrations(event.id).map((r) => [r.bookingId, r])).values()]
      .map((r) => ({ contactName: r.contactName, contactEmail: r.contactEmail }));
    const guestResults = req.body?.notify
      ? await sendEmails(bookings.map((booking) =>
        templates.eventCancelledGuest({ event: cancelled, booking, message, timeZone: config.timeZone, site })))
      : [];
    const notified = guestResults.filter(Boolean).length;

    const receipt = { event: cancelled, notified, deleteAt: deleteAt(cancelled), timeZone: config.timeZone };
    await sendEmails([
      templates.eventCancelledOrganizer({ ...receipt, site }),
      ...toAdmins(templates.eventCancelledOrganizer({ ...receipt, site: mainSite })),
    ]);
    res.json({ event: adminEvent(cancelled, repo.countRegistrations(event.id)), notified });
  });

  // Forsidebilde: last opp (PUT med selve bildet som body) eller fjern (DELETE). Bildet sjekkes og
  // renses for metadata (GPS-posisjon o.l.) før det lagres – se images.js.
  const imageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES });
  adminApi.put('/events/:slug/image', loadAdminEvent, requireEventAdmin, imageBody, (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: adminT('errors.imageInvalid') });
    let image;
    try {
      image = processImage(req.body);
    } catch (err) {
      if (!(err instanceof ImageError)) throw err;
      const key = err.message === 'tooLarge' ? 'errors.imageTooLarge'
        : err.message === 'tooManyPixels' ? 'errors.imageTooManyPixels' : 'errors.imageInvalid';
      return res.status(err.message === 'tooLarge' ? 413 : 400).json({ error: adminT(key, { max: MAX_IMAGE_BYTES / 1024 / 1024 }) });
    }
    repo.setImage(req.event.id, image);
    res.json({ uploadedImage: uploadedImageUrl(req.event), width: image.width, height: image.height });
  });
  adminApi.delete('/events/:slug/image', loadAdminEvent, requireEventAdmin, (req, res) => {
    repo.deleteImage(req.event.id);
    res.json({ uploadedImage: null });
  });

  // Opphev avlysningen (f.eks. ved et feiltrykk). Ingen får e-post om dette.
  adminApi.delete('/events/:slug/cancel', loadAdminEvent, requireEventAdmin, (req, res) => {
    repo.setCancelled(req.event.id, null);
    const event = repo.findEventById(req.event.id);
    res.json({ event: adminEvent(event, repo.countRegistrations(event.id)) });
  });

  adminApi.get('/events/:slug', loadAdminEvent, requireEventAdmin, (req, res) => {
    const registrations = repo.listRegistrations(req.event.id);
    res.json({
      event: adminEvent(req.event, registrations.length),
      registrations: registrations.map(({
        id, bookingId, position, name, email, answers, createdAt, contactName, contactEmail, code, doorCode, checkedInAt, checkedInBy, late,
      }) => ({
        id, bookingId, position, name, email, answers, createdAt, contactName, contactEmail, checkedInAt, checkedInBy, late,
        doorCode: req.event.features.tickets ? doorCode : null,
        ticketUrl: req.event.features.tickets ? tickets.ticketUrl(req.event, code) : null,
      })),
    });
  });

  adminApi.put('/events/:slug', loadAdminEvent, requireEventAdmin, (req, res) => {
    const data = validateEvent(req.body, { siteIds, skinIds });
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

  tickets.mountAdminApi(adminApi, { loadAdminEvent, requireEventAdmin });

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

  // ---------- Vedlikehold (kjøres jevnlig av server.js) ----------

  /**
   * 1. Rapport til arrangøren for hvert arrangement der påmeldingsfristen er nådd.
   * 2. Sletter alle data om arrangementer som var over for mer enn DELETE_AFTER_DAYS dager siden.
   * Returnerer hva som ble gjort, for logg og tester.
   */
  app.runMaintenance = async (now = new Date()) => {
    const reported = [];
    for (const event of repo.eventsDueForReport(now)) {
      // Avlyste arrangementer får ingen rapport.
      if (event.cancelledAt) {
        repo.markReportSent(event.id, now);
        continue;
      }
      const site = siteOf(event);
      const registrations = repo.listRegistrations(event.id);
      const message = templates.deadlineReport({
        event, registrations, count: registrations.length, site, timeZone: config.timeZone,
        scannerUrl: event.features.tickets ? tickets.scannerUrl(event) : null, deleteAt: deleteAt(event),
      });
      if (registrations.length) {
        message.attachments = [{
          filename: site.t('csv.filename', { slug: event.slug }),
          content: Buffer.from(registrationsToCsv(event, registrations, config.timeZone, site.lang)),
          contentType: 'text/csv; charset=utf-8',
        }];
      }
      const [sent] = await sendEmails([message]);
      // Går sendingen galt, prøves det igjen ved neste kjøring – men ikke i mer enn to døgn.
      if (sent || now - deadlineOf(event) > 2 * DAY) {
        repo.markReportSent(event.id, now);
        if (sent) reported.push(event.slug);
      }
    }
    const deleted = repo.deleteEventsEndedBefore(new Date(now.getTime() - deleteAfterDays * DAY));
    return { reported, deleted };
  };

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

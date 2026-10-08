import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AliasError, CapacityError } from './db.js';
import { registrationsToCsv } from './csv.js';
import * as templates from './email.js';
import { createEmailLogo } from './emailLogo.js';
import { accessTokenFrom, AccessError, createAccessVerifier } from './cfAccess.js';
import { escapeHtml } from './html.js';
import { aliasKey, hashSecret, isAlias, newSecret, newSlug, secretMatches, SLUG_PATTERN, splitAliases } from './ids.js';
import { rateLimit } from './rateLimit.js';
import { ImageError, MAX_IMAGE_BYTES, processImage } from './images.js';
import { loadLegalTexts } from './legal.js';
import { createLogoLoader } from './logo.js';
import { createOgImage, OG_IMAGE_HEIGHT, OG_IMAGE_TYPE, OG_IMAGE_WIDTH, OgImageError } from './ogImage.js';
import { createPlaceSearch } from './places.js';
import { loadSites } from './sites.js';
import { loadSkins, skinName } from './skins.js';
import { themeCspSources, themeCss } from './theme.js';
import { createTicketFeature, parseCookies } from './tickets.js';
import { createTokens } from './tokens.js';
import { readVersion } from './version.js';
import { createViews } from './views.js';
import {
  deadlineOf, isLate, registrationStatus, translateErrors, validateAlias, validateBooking, validateEvent, ValidationError,
} from './validation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'views');
const ASSETS = path.join(ROOT, 'public', 'assets');
// Egne filer (logo, favicon, CSS, personvern) fra ./branding, tilgjengelige som /assets/custom/<fil>.
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
  overviewLogin: { windowMs: 15 * 60_000, max: 10 }, // innlogging med passord til oversikten
};

// ---------- Betrodd LAN-port ----------
// Med LAN_PORT starter server.js en ekstra lytter for kontorets LAN, som sender forespørslene inn via
// app.lanHandler. Den merker forespørselen med dette symbolet FØR appen ser den. Symbolet er privat for
// modulen: ingen header, query, body eller informasjonskapsel kan sette det. En forespørsel er dermed
// betrodd bare hvis den faktisk kom inn på LAN-lytteren – det er porten som avgjør, aldri noe klienten
// sender (Host, X-Forwarded-*, cf-connecting-ip … kan alle settes fritt).
const LAN = Symbol('lan');
/** Kom forespørselen inn på den betrodde LAN-porten? */
export const isLan = (req) => req[LAN] === true;

export function createApp({
  repo, mailer, config, logger = console, accessVerifier = defaultAccessVerifier(config), placeSearch = createPlaceSearch(),
  version = readVersion(),
  // Leser LOGO_URL (se logo.js). Kan byttes ut i testene.
  logoFor = createLogoLoader({ brandingDir: BRANDING, assetsDir: ASSETS, logger }),
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
  // På LAN kan nettstedet også velges med ?site=<id> (f.eks. ?site=com), så sidene for et annet
  // domene kan forhåndsvises uten å endre Host. På PORT har parameteren ingen virkning.
  const lanSiteOf = (req) => (isLan(req) && typeof req.query.site === 'string' ? siteById.get(req.query.site) : undefined);
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
  // Personvern og databehandleravtaler (LEGAL_FILE i ./branding), vist i et vindu fra bunnteksten.
  const { texts: legalTexts, warnings: legalWarnings } = loadLegalTexts(sites, { brandingDir: config.brandingDir ?? BRANDING });
  for (const warning of legalWarnings) logger.warn?.(`ADVARSEL: ${warning}`);
  const views = createViews(VIEWS, { version, legal: legalTexts });
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
  // Delingsbildet (og:image) lages bare fra et opplastet bilde – aldri fra en lenke til et bilde et
  // annet sted. Adressen har samme hash som forsidebildet, så et nytt bilde gir også ny adresse her.
  const ogImageUrl = (event) => {
    const image = repo.imageMeta(event.id);
    return image?.hasOg ? `${eventUrl(event)}/bilde/${image.hash}-deling.jpg` : null;
  };
  // Admin-lenken ligger på arrangementets eget domene, med samme hash som arrangementet:
  // <domene>/<hash> (påmelding), <domene>/admin/<hash>#<nøkkel> og <domene>/dorvakt/<hash>#<nøkkel>.
  // Admin-nøkkelen er det eneste som gir tilgang (se «Tilgang til administrasjonen»). Eldre lenker til
  // admin-vertsnavnet (ADMIN_HOST) virker fortsatt, fordi administrasjonen svarer på alle vertsnavn.
  const adminUrl = (event, key) => `${siteOf(event).baseUrl}/admin/${event.slug}#${key}`;
  // Samme admin-side, åpnet rett på «Avlys arrangement».
  const cancelEventUrl = (event, key) => `${siteOf(event).baseUrl}/admin/${event.slug}/avlys#${key}`;

  // ---------- Svar uten innhold ----------
  // Uten en gyldig arrangementslenke skal et offentlig domene ikke avsløre noe som helst: forsiden,
  // ukjente adresser og ugyldige lenker får alle det samme nakne svaret – uten logo, navn eller språk.
  // Egen streng CSP: et tekstsvar kan ikke kjøre noe, og nettleseren får bruke sin innebygde
  // visningsstil for ren tekst (ellers logger Chromium en CSP-feil for hver 404).
  const notFound = (req, res) => res.status(404)
    .set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
    .type('text/plain')
    .send('Not Found');

  // `event` (valgfritt) gir arrangementets skin, lagt oppå nettstedets tema. `meta`: ekstra
  // <meta>-tagger for akkurat denne siden (se shareMeta).
  const sendPage = (res, name, site, status = 200, event = null, meta = '') => {
    const skinHref = (event?.skin && skins.get(event.skin)?.href) || '';
    res.status(status).type('html').send(views(name, { ...site, cssHref: cssHref.get(site.id), skinHref }, { meta }));
  };

  // Open Graph- og Twitter-tagger, så arrangementslenken får tittel og bilde når den deles
  // (Messenger, Slack, Teams, iMessage, LinkedIn …). Disse tjenestene kjører ikke JavaScript, så
  // taggene må stå i HTML-en fra serveren. Bildet er delingsbildet laget fra det opplastede bildet.
  function shareMeta(event, site) {
    const tags = [
      ['property', 'og:type', 'website'],
      ['property', 'og:site_name', site.theme.siteName || site.t('meta.siteNameFallback')],
      ['property', 'og:title', event.title],
      ['property', 'og:url', eventUrl(event)],
    ];
    const image = ogImageUrl(event);
    if (image) {
      tags.push(
        ['property', 'og:image', image],
        ['property', 'og:image:type', OG_IMAGE_TYPE],
        ['property', 'og:image:width', OG_IMAGE_WIDTH],
        ['property', 'og:image:height', OG_IMAGE_HEIGHT],
      );
    }
    tags.push(['name', 'twitter:card', image ? 'summary_large_image' : 'summary']);
    return tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`).join('\n  ');
  }

  // ---------- Oppbevaring ----------
  // Alle data om et arrangement slettes så mange dager etter at det er over (DELETE_AFTER_DAYS).
  const deleteAfterDays = config.deleteAfterDays ?? 30;
  const deleteAt = (event) => new Date(Date.parse(event.endsAt || event.startsAt) + deleteAfterDays * DAY);

  // Klientens IP til rate limiting. Bak Cloudflare Tunnel kommer alle forespørsler fra cloudflared,
  // så den ekte adressen må hentes fra headeren Cloudflare setter (CLIENT_IP_HEADER).
  // På LAN leses den alltid fra socketen – headeren kommer fra klienten selv og betyr ingenting der.
  const clientKey = (req) => (isLan(req) ? req.socket.remoteAddress
    : (config.clientIpHeader && req.get(config.clientIpHeader)) || req.ip);
  const limits = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  // Rate limiting gjelder ikke på den betrodde LAN-porten.
  const limiter = (options) => rateLimit({ ...options, key: clientKey, skip: isLan, message: (req) => req.t('errors.rateLimited') });

  // Feil nettsted for arrangementet. Offentlig: 301 til arrangementets eget domene, med samme sti (og
  // nettleseren tar med #nøkkelen). På LAN: samme adresse på LAN-porten med ?site=<id>, så man blir på
  // kontornettet – 302, fordi den ikke skal huskes av nettleseren. Også 302 når arrangementet ble funnet
  // via et alias: et alias kan fjernes og senere brukes av et arrangement på et annet domene.
  function redirectToSite(req, res, site, event = null) {
    if (!isLan(req)) return res.redirect(event?.viaAlias ? 302 : 301, `${site.baseUrl}${req.originalUrl}`);
    const url = new URL(req.originalUrl, 'http://lan');
    url.searchParams.set('site', site.id);
    // Alltid en sti på samme vertsnavn: nøyaktig én / først, så Location aldri kan bli «//annet-domene».
    return res.redirect(302, `/${url.pathname.replace(/^\/+/, '')}${url.search}`);
  }

  // ---------- Billetter, kalender, Wallet og innsjekking (se tickets.js) ----------
  const tokens = createTokens(repo.secret());
  // Logoen til PDF-billetten. Hentes med én gang for hvert nettsted, så en logo som ikke kan brukes
  // i PDF (feil sti, WebP …) gir en advarsel i loggen ved oppstart – ikke først når noen melder seg på.
  // Samme logo bygges inn i e-postene som PNG (se emailLogo.js) – lages også med én gang.
  const emailLogoFor = createEmailLogo({ logoFor, logger });
  for (const site of sites) emailLogoFor(site.theme);
  const tickets = createTicketFeature({
    repo, config, tokens, siteOf, eventUrl, imageUrlOf, findEventBySlug, notFound, sendPage, logger, adminT, placeSearch, limiter, limits,
    logoFor, isLan, redirectToSite,
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
    req.site = lanSiteOf(req) ?? siteByHost.get(hostOf(req)) ?? mainSite;
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
  // Skript, ordbøker og stilark: «no-cache» – nettleseren (og Cloudflare) beholder filen, men spør hver gang
  // om den er endret (ETag), og får 304 når den ikke er det. Sidene laster hovedskriptet med versjonen i
  // adressen (…/admin.js?v=<versjon>), men filene det importerer (common.js, i18n/nb.js …) har den ikke. Med
  // «max-age» kunne en ny versjon da kjørt med en gammel ordbok, og vist tekstnøkler som «overview.manage»
  // i stedet for teksten – til hurtigbufferen gikk ut.
  app.use('/assets', express.static(ASSETS, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  // ---------- Tilgang til administrasjonen ----------
  // Alt som har med administrasjon å gjøre ligger under /admin (sider) og /api/admin (API). Det finnes
  // tre slags tilgang (den tredje, oversikten, er beskrevet ved overviewAuth under):
  //
  // 1. Opprette arrangementer: /admin/ny og resten av /api/admin (config, places, POST events).
  //    Slipper inn med den betrodde LAN-porten, opprettingsnøkkelen (CREATE_KEY, lenken
  //    /admin/ny#<nøkkel>) eller et gyldig Cloudflare Access-token. Med ADMIN_HOST finnes dette bare
  //    på admin-vertsnavnet – på de offentlige domenene gir det den nakne 404-en.
  // 2. Administrere ett arrangement: /admin/<hash> og /api/admin/events/<hash>/…. Krever bare
  //    arrangementets admin-nøkkel (lenken /admin/<hash>#<nøkkel>) – verken Access eller ADMIN_HOST.
  //    Nøkkelen er 24 tilfeldige byte (192 bit) og kan ikke gjettes. Virker på alle vertsnavn:
  //    arrangementets eget domene (der nye lenker peker), admin-vertsnavnet (der eldre lenker peker) og LAN.
  //
  // Nøklene står etter # i lenkene, så nettleseren sender dem aldri til serveren når en side åpnes.
  // JavaScript på siden sender dem i «Authorization: Bearer <nøkkel>» til API-et.

  const createKeyHash = config.createKey ? hashSecret(config.createKey) : null;
  // 3. Oversikten over alle arrangementer: /admin og GET /api/admin/overview. Eieren velger selv hvordan
  //    den beskyttes (OVERVIEW_AUTH, se overviewAuth.js): nøkkel, passord, Cloudflare Access, LAN-porten
  //    eller ingenting – én av de valgte holder. Med ADMIN_HOST finnes den bare der (og på LAN-porten),
  //    som oppretting. Uten noen valgt måte finnes den ikke, og /admin sender videre til /admin/ny som før.
  const overviewAuth = config.overview ?? { methods: [] };
  const overviewMethods = new Set(overviewAuth.methods);
  const overviewKeyHash = overviewAuth.key ? hashSecret(overviewAuth.key) : null;
  // Brukernavn og passord sammenlignes samlet, så svaret aldri røper hvilket av dem som var feil.
  const loginOf = (user, password) => `${user}\n${password}`;
  const overviewLoginHash = overviewAuth.password != null ? hashSecret(loginOf(overviewAuth.user, overviewAuth.password)) : null;
  // Innloggingen huskes i en informasjonskapsel: en HMAC av brukernavn og passord med appens hemmelighet.
  // Nytt passord (eller brukernavn) = ny verdi, så alle som er logget inn, må logge inn på nytt.
  const OVERVIEW_COOKIE = 'ov';
  // Hele /api/admin: informasjonskapselen gir også tilgang til hvert arrangements admin-API (se eventAdminGate).
  // Før 2026.10.8.5 var stien /api/admin/overview – utloggingen sletter den også.
  const OVERVIEW_COOKIE_PATH = '/api/admin';
  const OLD_OVERVIEW_COOKIE_PATH = '/api/admin/overview';
  const overviewSession = overviewLoginHash
    ? createHmac('sha256', repo.secret()).update(`overview-session:${overviewLoginHash}`).digest('base64url')
    : null;
  const overviewSessionHash = overviewSession ? hashSecret(overviewSession) : null;
  const overviewHere = (req) => overviewMethods.size > 0 && (isLan(req) || !config.adminHost || hostOf(req) === config.adminHost);
  const bearerOf = (req) => /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1] ?? '';

  // Oppretting (1). Setter req.creator når forespørselen har lov til å opprette arrangementer.
  function creatorGate(kind) {
    return async (req, res, next) => {
      req.t = adminT;
      req.accessUser = null;
      req.creator = false;
      // Den betrodde LAN-porten slipper inn uten ADMIN_HOST, Access og nøkkel.
      if (isLan(req)) {
        req.creator = true;
        return next();
      }
      // Med eget admin-vertsnavn finnes oppretting ikke på de offentlige domenene i det hele tatt.
      if (config.adminHost && hostOf(req) !== config.adminHost) return notFound(req, res);
      if (createKeyHash && secretMatches(bearerOf(req), createKeyHash)) {
        req.creator = true;
        return next();
      }
      if (accessVerifier) {
        try {
          req.accessUser = await accessVerifier(accessTokenFrom(req));
          req.creator = true;
        } catch (err) {
          if (!(err instanceof AccessError)) logger.error('Cloudflare Access-sjekk feilet:', err);
          // Nøkkelen etter # kommer aldri med når siden åpnes. Med opprettingsnøkkel vises derfor siden
          // (den har ingen data) – nøkkelen sjekkes når siden kaller API-et.
          if (kind === 'page' && createKeyHash) return next();
          return kind === 'api'
            ? res.status(403).set('Cache-Control', 'no-store').json({ error: adminT(createKeyHash ? 'errors.createKeyRequired' : 'errors.accessDenied') })
            : sendPage(res, '403', mainSite, 403);
        }
        return next();
      }
      // Verken gyldig nøkkel eller Access. ADMIN_NO_AUTH (lokal utvikling) gjelder bare når ingen annen
      // innlogging er satt opp: med CREATE_KEY skal nøkkelen alltid kreves.
      req.creator = config.adminNoAuth && !createKeyHash;
      next();
    };
  }

  // /api/admin/events/<hash> og alt under – men ikke POST /api/admin/events (oppretting).
  const EVENT_ADMIN_PATH = /^\/events\/([^/]+)(?:\/|$)/;

  // Ett arrangement (2). Et ukjent arrangement gir det samme nakne svaret som alt annet uten gyldig lenke,
  // så API-et ikke røper noe på de offentlige domenene. Uten riktig nøkkel: 401.
  //
  // Tilgangen til oversikten (3) gir også tilgang hit, til hvert arrangement – det er slik «Administrer» i
  // oversikten virker, siden admin-nøklene bare lagres som hash og lenkene ikke kan lages på nytt. Det
  // gjelder bare der oversikten finnes (med ADMIN_HOST: admin-vertsnavnet og LAN-porten), og med de
  // måtene eieren har valgt i OVERVIEW_AUTH. req.eventAccess sier hvilken tilgang som slapp inn.
  async function eventAdminGate(req, res, next) {
    req.t = adminT;
    req.accessUser = null;
    req.eventAccess = null;
    const event = findEventBySlug(EVENT_ADMIN_PATH.exec(req.path)[1]);
    if (!event) return notFound(req, res);
    if (secretMatches(bearerOf(req), event.adminKeyHash)) req.eventAccess = 'event';
    else if (overviewHere(req) && (req.overviewVia = await overviewVia(req))) req.eventAccess = 'overview';
    if (!req.eventAccess) {
      return res.status(401).set('Cache-Control', 'no-store').json({ error: adminT('errors.invalidAdminLink') });
    }
    // Kom forespørselen gjennom Cloudflare Access, brukes e-postadressen (f.eks. «sjekket inn av»).
    // Access kreves ikke: et manglende eller ugyldig token betyr bare at vi ikke vet hvem det er.
    const token = !req.accessUser && accessVerifier && !isLan(req) ? accessTokenFrom(req) : '';
    if (token) req.accessUser = await accessVerifier(token).catch(() => null);
    next();
  }

  // ---------- Sider ----------

  // Forsiden. Uten ROOT_REDIRECT (eller SITE_<ID>_ROOT_REDIRECT) for nettstedet: den samme nakne 404-en
  // som alt annet uten gyldig lenke. Med: videre til adressen, f.eks. firmaets nettsted. 302 og ikke 301,
  // fordi nettleseren husker en 301 – da ville en endret eller fjernet adresse ikke slått gjennom for dem
  // som har vært innom. Bare akkurat / sendes videre; /index.html og alt annet gir fortsatt 404.
  app.get('/', (req, res) => {
    if (!req.site.rootRedirect) return notFound(req, res);
    res.set('Cache-Control', 'no-store').redirect(302, req.site.rootRedirect);
  });

  // Siden har ingen data: de hentes med oversiktsnøkkelen, som bare JavaScript på siden kjenner (etter #).
  app.get('/admin', (req, res, next) => (overviewHere(req) ? sendPage(res, 'overview', mainSite) : next()),
    creatorGate('page'), (req, res) => res.redirect('/admin/ny'));
  app.get('/admin/ny', creatorGate('page'), (req, res) => sendPage(res, 'new', mainSite));
  // Siden for ett arrangement vises for alle arrangementer som finnes. Den har ingen data: dataene
  // krever admin-nøkkelen, som bare JavaScript på siden kjenner.
  const adminPage = (req, res) => {
    if (!findEventBySlug(req.params.slug)) return notFound(req, res);
    sendPage(res, 'admin', mainSite);
  };
  app.get('/admin/:slug', adminPage);
  app.get('/admin/:slug/avlys', adminPage);

  // Hash-en eller et alias (se ids.js) – i alle adresser: /<alias>, /<alias>/avmelding, /admin/<alias> …
  // Et alias gir ingen tilgang hash-en ikke gir: nøklene etter # kreves akkurat som før. Et arrangement
  // funnet via alias merkes (viaAlias), så en videresending til riktig domene ikke huskes av nettleseren
  // (se redirectToSite) – aliaset kan senere fjernes og tas av et arrangement på et annet domene.
  function findEventBySlug(value) {
    // Express har allerede dekodet adressen (%C3%B8 → ø). aliasKey: små bokstaver og samme Unicode-form.
    const name = aliasKey(value);
    const event = SLUG_PATTERN.test(name) ? repo.findEvent(name) : null;
    if (event || !isAlias(name)) return event;
    const aliased = repo.findEventByAlias(name);
    return aliased && { ...aliased, viaAlias: true };
  }

  // Gammel admin-adresse fra før admin ble samlet under /admin. Nettleseren tar med #nøkkelen videre.
  // Sendes bare videre for arrangementer som finnes, så adressen ikke kan brukes til å lete. Admin-siden
  // for ett arrangement virker på alle vertsnavn, så den relative adressen holder.
  app.get('/:slug/admin', (req, res) => {
    const event = findEventBySlug(req.params.slug);
    if (!event) return notFound(req, res);
    res.redirect(event.viaAlias ? 302 : 301, `/admin/${event.slug}`);
  });

  tickets.mountPages(app);

  // Arrangementssiden og avmeldingssiden. Åpnes et arrangement på feil domene, sendes nettleseren
  // videre til arrangementets eget domene (301), med samme sti – og nettleseren tar med #nøkkelen.
  // Bare arrangementssiden får delingstagger: det er den lenken som deles. Avmeldingslenken er personlig.
  const eventPage = (view) => (req, res) => {
    const event = findEventBySlug(req.params.slug);
    if (!event) return notFound(req, res);
    const site = siteOf(event);
    if (site !== req.site) return redirectToSite(req, res, site, event);
    sendPage(res, view, site, 200, event, view === 'event' ? shareMeta(event, site) : '');
  };
  // Opplastet forsidebilde (<hash>.<filtype>) og delingsbildet laget fra det (<hash>-deling.jpg).
  // Adressen har en hash av innholdet, så et nytt bilde får ny adresse.
  // «private»: bildet skal ikke ligge igjen i en delt mellomlagring (f.eks. hos Cloudflare) etter at
  // arrangementet er slettet.
  app.get('/:slug/bilde/:file', (req, res) => {
    const event = findEventBySlug(req.params.slug);
    const meta = event && repo.imageMeta(event.id);
    if (!meta) return notFound(req, res);
    const isOg = req.params.file === `${meta.hash}-deling.jpg`;
    if (!isOg && req.params.file !== `${meta.hash}.${IMAGE_EXT[meta.type]}`) return notFound(req, res);
    const image = isOg ? repo.ogImage(event.id) : repo.image(event.id);
    if (!image) return notFound(req, res);
    const site = siteOf(event);
    if (site !== req.site) return redirectToSite(req, res, site, event);
    res.type(isOg ? OG_IMAGE_TYPE : image.type).set('Cache-Control', 'private, max-age=86400').send(image.data);
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
  // Ett arrangement krever admin-nøkkelen; alt annet under /api/admin gjelder oppretting.
  const apiCreatorGate = creatorGate('api');
  const adminApiGate = (req, res, next) => {
    // Express godtar også /overview/ for ruten – porten må gjøre det samme.
    if (/^\/overview(?:\/(?:login|logout))?\/?$/.test(req.path)) return overviewGate(req, res, next);
    return (EVENT_ADMIN_PATH.test(req.path) ? eventAdminGate : apiCreatorGate)(req, res, next);
  };
  adminApi.use(adminApiGate, express.json({ limit: '100kb' }), noStore);

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

  /**
   * Hvilken av eierens valgte måter slipper forespørselen inn til oversikten? 'none', 'lan', 'key',
   * 'password' eller 'access' – eller null. Access sjekkes sist, fordi den krever et nettverkskall.
   */
  async function overviewVia(req) {
    if (overviewMethods.has('none')) return 'none';
    if (overviewMethods.has('lan') && isLan(req)) return 'lan';
    if (overviewMethods.has('key') && secretMatches(bearerOf(req), overviewKeyHash)) return 'key';
    if (overviewMethods.has('password')) {
      const cookie = parseCookies(req.get('cookie'))[OVERVIEW_COOKIE];
      if (secretMatches(cookie, overviewSessionHash)) return 'password';
    }
    if (overviewMethods.has('access') && accessVerifier && !isLan(req)) {
      const token = accessTokenFrom(req);
      if (token) {
        try {
          req.accessUser = await accessVerifier(token);
          return 'access';
        } catch (err) {
          if (!(err instanceof AccessError)) logger.error('Cloudflare Access-sjekk feilet:', err);
        }
      }
    }
    return null;
  }

  // Det siden trenger for å vise riktig innlogging når den ikke slipper inn.
  const overviewLogin = () => ({
    key: overviewMethods.has('key'),
    password: overviewMethods.has('password'),
    user: overviewMethods.has('password') && Boolean(overviewAuth.user),
    access: overviewMethods.has('access'),
    lan: overviewMethods.has('lan'),
  });

  // Oversikten (3). Finnes den ikke her (ingen valgt måte, eller feil vertsnavn med ADMIN_HOST), er svaret
  // den nakne 404-en. Innlogging og utlogging slipper alltid gjennom (de finnes bare med passord); selve
  // oversikten krever en av de valgte måtene, ellers 401 med hvilke måter som finnes.
  async function overviewGate(req, res, next) {
    req.t = adminT;
    req.accessUser = null;
    if (!overviewHere(req)) return notFound(req, res);
    if (/^\/overview\/(?:login|logout)\/?$/.test(req.path)) {
      return overviewMethods.has('password') ? next() : notFound(req, res);
    }
    req.overviewVia = await overviewVia(req);
    if (!req.overviewVia) {
      return res.status(401).set('Cache-Control', 'no-store').json({ error: adminT('errors.overviewDenied'), login: overviewLogin() });
    }
    next();
  }

  // Sjekken gjentas i ruten, som for requireEventAdmin: ruten skal aldri kunne bli åpen ved en feil.
  // req.overviewVia settes bare av overviewGate.
  function requireOverview(req, res, next) {
    if (!overviewHere(req) || !req.overviewVia) {
      return res.status(401).json({ error: adminT('errors.overviewDenied'), login: overviewLogin() });
    }
    next();
  }

  // Innloggingen skal komme fra admin-siden selv. Informasjonskapselen er SameSite=Strict, og API-et krever
  // JSON; dette er en ekstra sperre mot CSRF.
  function overviewSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* ugyldig */ }
      if (host !== req.get('host')) return res.status(403).json({ error: adminT('errors.forbidden') });
    }
    next();
  }

  // Admin-nøkkelen for et arrangement sendes som «Authorization: Bearer <nøkkel>». eventAdminGate har
  // allerede sjekket den; sjekken gjentas her for hver rute, så en rute aldri kan bli åpen ved en feil.
  // req.eventAccess === 'overview' settes bare av eventAdminGate, etter at oversikts-tilgangen er sjekket.
  function requireEventAdmin(req, res, next) {
    if (req.eventAccess !== 'overview' && !secretMatches(bearerOf(req), req.event.adminKeyHash)) {
      return res.status(401).json({ error: adminT('errors.invalidAdminLink') });
    }
    next();
  }

  // Oppretting av nye arrangementer (og oppsettet og stedsoppslaget som skjemaet bruker) krever at
  // creatorGate har sluppet forespørselen inn: LAN-porten, opprettingsnøkkelen eller Cloudflare Access.
  // Ellers er oppretting slått av – med mindre ADMIN_NO_AUTH=true er satt for lokal utvikling. Slik blir
  // en glemt innstilling aldri til at hvem som helst kan opprette arrangementer og sende e-post i ditt navn.
  function requireCreator(req, res, next) {
    if (req.creator) return next();
    return res.status(403).json({ error: adminT(createKeyHash ? 'errors.createKeyRequired' : 'errors.creationDisabled') });
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
      // Delingsbildet (og:image) som er laget fra det opplastede bildet.
      ogImage: ogImageUrl(event),
      // Lesbare adresser til det samme arrangementet (se «Alias»), og starten på dem til skjemaet.
      aliases: aliasesOf(event),
      maxAliases: MAX_ALIASES,
      baseUrl: siteOf(event).baseUrl,
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
  // Logoen bygges inn i hver e-post (se emailLogo.js); kan den ikke det, står lenken til den igjen.
  //
  // Sikkerhetsnett: avviser e-posttjenesten avsenderen – domenet er ikke verifisert ennå (Resend,
  // Cloudflare; typisk rett etter at et nytt domene er lagt til), eller postkassen finnes ikke eller kan
  // ikke brukes (Microsoft 365, SMTP) – sendes e-posten på nytt fra hovednettstedets avsender, så gjesten
  // får bekreftelsen likevel, og loggen sier tydelig fra. Se `senderRejected` i mailer.js.
  async function sendEmails(messages) {
    const results = await Promise.allSettled(messages.map(async (m) => {
      const { site, ...message } = templates.embedLogo(m, await emailLogoFor(m.site?.theme));
      try {
        return await mailer.send(message);
      } catch (err) {
        const fallback = mainSite.emailFrom;
        if (!message.from || message.from === fallback || !(err.senderRejected || /not verified/i.test(err.message))) throw err;
        logger.error(`ADVARSEL: E-posttjenesten godtar ikke avsenderen ${message.from} (${err.message}). E-posten til ${message.to} sendes fra ${fallback} i stedet. Sett opp avsenderen hos e-posttjenesten (se README, «Sette opp e-post»), eller sett EMAIL_FROM for nettstedet.`);
        return mailer.send({ ...message, from: fallback });
      }
    }));
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

  // Oppsettet skjemaet trenger. Samme innhold for oppretting (/config) og for ett arrangement
  // (/events/<hash>/config, med admin-nøkkelen), så admin-siden aldri trenger opprettingstilgang.
  const adminConfig = (req, res) => res.json({
    timeZone: config.timeZone,
    accessEmail: req.accessUser?.email ?? null,
    // Nettstedene arrangøren kan velge mellom. Hovednettstedet først.
    sites: sites.map(({ id, label, lang, baseUrl }) => ({ id, label, lang, baseUrl })),
    // Utseender arrangøren kan velge, med navn på admin-språket og farger til forhåndsvisningen.
    skins: [...skins.values()].map((skin) => ({ id: skin.id, name: skinName(skin, mainSite.lang), preview: skin.preview })),
    deleteAfterDays,
    // Wallet-bryterne vises bare når tjenesten er satt opp.
    wallets: { apple: Boolean(config.wallet?.apple), google: Boolean(config.wallet?.google) },
  });
  adminApi.get('/config', requireCreator, adminConfig);
  adminApi.get('/events/:slug/config', loadAdminEvent, requireEventAdmin, adminConfig);

  const skinIds = [...skins.keys()];

  // Til tjenesteadministratoren(e) (ADMIN_EMAIL): samme innhold, med adressen byttet ut. Teksten er på
  // hovednettstedets språk, men avsenderen er arrangementets nettsted – e-post om et arrangement kommer
  // alltid fra domenet arrangementet hører til.
  const toAdmins = (message, event) => config.adminEmails?.length
    ? config.adminEmails.map((to) => ({ ...message, to, from: siteOf(event).emailFrom, replyTo: undefined }))
    : [];

  adminApi.post('/events', createLimiter, requireCreator, async (req, res) => {
    const data = validateEvent(req.body, { siteIds, skinIds });
    let slug = newSlug();
    // Kollisjon er svært usannsynlig, men sjekkes likevel – også mot alias, som deler navnerom med hash-ene.
    while (repo.isNameTaken(slug)) slug = newSlug();
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
      ...toAdmins(templates.eventCreated({ ...details, site: mainSite, forAdmin: true, createdBy: req.accessUser?.email ?? null }), event),
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
      ...toAdmins(templates.eventCancelledOrganizer({ ...receipt, site: mainSite }), cancelled),
    ]);
    res.json({ event: adminEvent(cancelled, repo.countRegistrations(event.id)), notified });
  });

  // Forsidebilde: last opp (PUT med selve bildet som body) eller fjern (DELETE). Bildet sjekkes og
  // renses for metadata (GPS-posisjon o.l.) før det lagres – se images.js. Samtidig lages
  // delingsbildet (og:image) fra det – se ogImage.js. Kan ikke bildedataene leses, avvises bildet:
  // da ville det heller ikke vist seg i nettleseren.
  const imageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES });
  adminApi.put('/events/:slug/image', loadAdminEvent, requireEventAdmin, imageBody, async (req, res) => {
    const invalid = () => res.status(400).json({ error: adminT('errors.imageInvalid') });
    if (!Buffer.isBuffer(req.body)) return invalid();
    let image;
    try {
      image = processImage(req.body);
    } catch (err) {
      if (!(err instanceof ImageError)) throw err;
      const key = err.message === 'tooLarge' ? 'errors.imageTooLarge'
        : err.message === 'tooManyPixels' ? 'errors.imageTooManyPixels' : 'errors.imageInvalid';
      return res.status(err.message === 'tooLarge' ? 413 : 400).json({ error: adminT(key, { max: MAX_IMAGE_BYTES / 1024 / 1024 }) });
    }
    let ogData;
    try {
      ogData = await createOgImage(image.data);
    } catch (err) {
      if (!(err instanceof OgImageError)) throw err;
      return invalid();
    }
    // Arrangementet kan ha blitt slettet mens bildet ble behandlet.
    if (!repo.findEventById(req.event.id)) return notFound(req, res);
    repo.setImage(req.event.id, { ...image, ogData });
    res.json({
      uploadedImage: uploadedImageUrl(req.event), ogImage: ogImageUrl(req.event), width: image.width, height: image.height,
    });
  });
  adminApi.delete('/events/:slug/image', loadAdminEvent, requireEventAdmin, (req, res) => {
    repo.deleteImage(req.event.id);
    res.json({ uploadedImage: null, ogImage: null });
  });

  // ---------- Oversikt over alle arrangementer ----------
  // Alle arrangementene som finnes (de slettes DELETE_AFTER_DAYS dager etter at de er over), med tall –
  // aldri opplysninger om gjestene. Admin-lenkene er ikke med: admin-nøklene lagres bare som hash, og
  // står bare i e-posten til arrangøren (og tjenesteadministratoren, ADMIN_EMAIL).
  adminApi.get('/overview', requireOverview, (req, res) => {
    const now = new Date();
    const events = repo.listEventsOverview().map(({ event, count, bookings, checkedIn, aliases }) => {
      const site = siteOf(event);
      return {
        slug: event.slug,
        title: event.title,
        url: eventUrl(event),
        aliases: aliases.map((alias) => `${site.baseUrl}/${alias}`),
        site: site.id,
        location: event.location,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        registrationDeadline: event.registrationDeadline,
        status: registrationStatus(event, count, now),
        cancelledAt: event.cancelledAt,
        count,
        capacity: event.capacity,
        bookings,
        // Innsjekking finnes bare med billetter.
        checkedIn: event.features.tickets ? checkedIn : null,
        organizerName: event.organizerName,
        organizerEmail: event.organizerEmail,
        // Over: sluttidspunktet (eller starten, uten slutt) er passert. Slettes da etter DELETE_AFTER_DAYS.
        ended: new Date(event.endsAt || event.startsAt) <= now,
        deleteAt: deleteAt(event).toISOString(),
        createdAt: event.createdAt,
      };
    });
    res.json({
      // Hvordan forespørselen slapp inn – siden viser «Logg ut» når det var med passord.
      via: req.overviewVia,
      timeZone: config.timeZone,
      deleteAfterDays,
      sites: sites.map(({ id, label }) => ({ id, label })),
      events,
    });
  });

  // Innlogging med brukernavn og passord (OVERVIEW_AUTH=password). body: { username, password }.
  // Begrenset per IP-adresse (rateLimits.overviewLogin), så passordet ikke kan prøves i det uendelige.
  const overviewLoginLimiter = limiter(limits.overviewLogin);
  adminApi.post('/overview/login', overviewLoginLimiter, overviewSameOrigin, (req, res) => {
    const username = overviewAuth.user ? String(req.body?.username ?? '').trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!secretMatches(loginOf(username, password), overviewLoginHash)) {
      return res.status(401).json({ error: adminT(overviewAuth.user ? 'errors.overviewLoginFailed' : 'errors.overviewPasswordFailed') });
    }
    // Secure når hovednettstedet er på https – men ikke på LAN-porten, som er vanlig http. Der ville
    // nettleseren ellers forkastet informasjonskapselen.
    const secure = !isLan(req) && mainSite.baseUrl.startsWith('https:');
    res.cookie(OVERVIEW_COOKIE, overviewSession, {
      httpOnly: true, sameSite: 'strict', secure, path: OVERVIEW_COOKIE_PATH, maxAge: overviewAuth.sessionDays * DAY,
    });
    res.json({ ok: true });
  });

  adminApi.post('/overview/logout', overviewSameOrigin, (req, res) => {
    res.clearCookie(OVERVIEW_COOKIE, { path: OVERVIEW_COOKIE_PATH });
    res.clearCookie(OVERVIEW_COOKIE, { path: OLD_OVERVIEW_COOKIE_PATH });
    res.json({ ok: true });
  });

  // ---------- Alias ----------
  // Lesbare adresser (<domene>/julebord) i tillegg til hash-en. Hash-lenken er fortsatt hovedlenken (i
  // e-postene, delingstaggene og billettene); et alias viser bare den samme siden. Aliaset følger
  // arrangementets nettsted, og forsvinner når arrangementet slettes.
  const MAX_ALIASES = 50;
  const aliasesOf = (event) => repo.listAliases(event.id).map((alias) => ({ alias, url: `${siteOf(event).baseUrl}/${alias}` }));

  // body: { alias } – ett eller flere navn, skilt med komma, semikolon eller linjeskift. Hvert navn
  // normaliseres («Bacalao før Qingdao» → «bacalao-før-qingdao», se ids.js) og legges til for seg.
  // Svaret: added (de som ble lagt til), existing (de arrangementet allerede hadde – ingen feil), failed
  // ([{ input, error }]) og alle aliasene. 201 når noe ble lagt til, 200 når alt fantes fra før. Ellers 400
  // (409 når det ene navnet er i bruk av et annet arrangement), med feilen i errors.alias som før.
  adminApi.post('/events/:slug/aliases', loadAdminEvent, requireEventAdmin, (req, res) => {
    const inputs = typeof req.body?.alias === 'string' ? splitAliases(req.body.alias) : [];
    if (!inputs.length) validateAlias(''); // kaster «Skriv inn et navn»
    const added = [];
    const existing = [];
    const failed = [];
    const own = new Set(repo.listAliases(req.event.id));
    let taken = 0;
    for (const input of inputs) {
      let alias;
      try {
        alias = validateAlias(input);
        if (added.includes(alias) || existing.includes(alias)) continue; // samme navn to ganger i lista
        if (own.has(alias)) {
          existing.push(alias);
          continue;
        }
        repo.addAlias(req.event.id, alias, MAX_ALIASES);
        added.push(alias);
      } catch (err) {
        if (err instanceof ValidationError) {
          const { key, vars } = err.errors.alias;
          failed.push({ input, error: adminT(`validation.${key}`, vars) });
        } else if (err instanceof AliasError) {
          if (err.reason === 'taken') taken += 1;
          failed.push({
            input,
            error: err.reason === 'taken'
              ? adminT('validation.aliasTaken', { alias })
              : adminT('validation.aliasTooMany', { max: MAX_ALIASES }),
          });
        } else {
          throw err;
        }
      }
    }
    const aliases = aliasesOf(req.event);
    if (!added.length && !existing.length) {
      // Én feil: meldingen som den er. Flere: «navn»: feil, én per linje.
      const error = failed.length === 1 ? failed[0].error : failed.map((f) => `«${f.input}»: ${f.error}`).join('\n');
      const status = failed.length === 1 && taken === 1 ? 409 : 400;
      return res.status(status).json({ error, errors: { alias: error }, added, existing, failed, aliases });
    }
    res.status(added.length ? 201 : 200).json({ alias: added[0] ?? existing[0], added, existing, failed, aliases });
  });

  adminApi.delete('/events/:slug/aliases/:alias', loadAdminEvent, requireEventAdmin, (req, res) => {
    if (!repo.removeAlias(req.event.id, aliasKey(req.params.alias))) {
      return res.status(404).json({ error: adminT('errors.aliasNotFound') });
    }
    res.json({ aliases: aliasesOf(req.event) });
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
      // 'event' (arrangementets egen admin-nøkkel) eller 'overview' (via oversikten – siden viser da
      // «Alle arrangementer» som vei tilbake).
      access: req.eventAccess,
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

  tickets.mountAdminApi(adminApi, { loadAdminEvent, requireEventAdmin, requireCreator });

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

  // Alt annet finnes ikke – også forsiden, med mindre nettstedet har ROOT_REDIRECT.
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
    const ogImages = await createMissingOgImages();
    return { reported, deleted, ogImages };
  };

  // Forsidebilder lastet opp før delingsbildet fantes, får det her (ved første vedlikehold etter
  // oppgraderingen). Et bilde som ikke kan leses, merkes, så det ikke prøves igjen hver gang.
  async function createMissingOgImages() {
    let created = 0;
    for (const { eventId, hash } of repo.imagesWithoutOg()) {
      const image = repo.image(eventId);
      if (!image || image.hash !== hash) continue;
      let ogData;
      try {
        ogData = await createOgImage(image.data);
      } catch (err) {
        if (!(err instanceof OgImageError)) throw err;
        logger.warn?.(`ADVARSEL: Kunne ikke lage delingsbilde for arrangement ${eventId}: ${err.message}`);
        ogData = Buffer.alloc(0);
      }
      if (repo.setOgImage(eventId, hash, ogData) && ogData.length) created++;
    }
    return created;
  }

  /**
   * Inngangen for den betrodde LAN-lytteren (se server.js): http.createServer(app.lanHandler).
   * Samme app og database – forespørselen merkes bare som betrodd før den slippes inn.
   */
  app.lanHandler = (req, res) => {
    req[LAN] = true;
    app(req, res);
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

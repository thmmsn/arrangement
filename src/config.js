// All konfigurasjon leses fra miljøvariabler (se .env.example).

import { loadMailConfig } from './mailConfig.js';
import { loadSites, normalizeHost } from './sites.js';
import { loadWalletConfig } from './walletConfig.js';

export function loadConfig(rawEnv = process.env) {
  const env = unquoteAll(rawEnv);
  const port = Number(env.PORT) || 3000;
  const lanWarnings = [];
  // Betrodd port for kontorets LAN (valgfri). Se lanPort under.
  const lanPort = parseLanPort(env.LAN_PORT, port, lanWarnings);
  // Nettstedene: hovednettstedet fra DOMAIN/BASE_URL/tema-variablene, pluss eventuelle SITE_<ID>_*.
  // Ugyldige verdier ignoreres og havner i `warnings`; alvorlige feil kaster SiteConfigError.
  const { sites, mainSite, warnings } = loadSites(env, { port });
  // Apple Wallet og Google Wallet: valgfrie, og slås av med en advarsel hvis oppsettet er ufullstendig.
  const wallet = loadWalletConfig(env);
  // E-posttjenesten (Resend, Cloudflare, Microsoft 365 eller SMTP), med eventuelle reserver.
  const mail = loadMailConfig(env);
  warnings.push(...wallet.warnings, ...lanWarnings, ...mail.warnings);

  return {
    port,
    // Ekstra HTTP-lytter for kontorets LAN, i samme prosess og med samme app og database. Alt som
    // kommer inn på denne porten er BETRODD: admin uten ADMIN_HOST og Access, ingen rate limiting.
    // Tilliten følger porten forespørselen kom inn på – aldri headere, som klienten kan sette selv.
    // Porten må aldri rutes gjennom tunnelen eller publiseres mot internett. null = av.
    lanPort,
    sites,
    mainSite,
    // Hovednettstedets verdier, for kode som bare trenger «nettstedet» (logger, enkle oppsett).
    baseUrl: mainSite.baseUrl,
    theme: mainSite.theme,
    emailFrom: mainSite.emailFrom,
    warnings,
    wallet: { apple: wallet.apple, google: wallet.google },
    databasePath: env.DATABASE_PATH || 'data/arrangement.db',
    // Alle data om et arrangement (påmeldinger, navn, e-post, svar) slettes så mange dager etter
    // at det er over. Standard 30.
    deleteAfterDays: parseDays(env.DELETE_AFTER_DAYS, warnings),
    // Tjenesteadministratoren: får e-post med alle lenkene når et arrangement opprettes eller avlyses.
    // Flere adresser skilles med komma.
    adminEmails: parseEmails(env.ADMIN_EMAIL, warnings),
    // Opprettingsnøkkelen: lenken /admin/ny#<nøkkel> gir rett til å opprette arrangementer, uten
    // Cloudflare Access. Minst 32 tegn; en for kort eller ugyldig nøkkel ignoreres, og oppretting er da
    // stengt (med mindre Access eller LAN-porten brukes).
    createKey: parseKey('CREATE_KEY', env.CREATE_KEY, warnings, 'Ingen kan opprette arrangementer med nøkkel.'),
    // Oversiktsnøkkelen: lenken /admin#<nøkkel> viser alle arrangementene (uten opplysninger om gjestene).
    // Samme krav som CREATE_KEY. Nøkkelen kreves alltid – også på LAN-porten og med Cloudflare Access,
    // som eieren kan legge foran som et ekstra lag. Uten nøkkel finnes oversikten ikke.
    overviewKey: parseKey('OVERVIEW_KEY', env.OVERVIEW_KEY, warnings, 'Oversikten over alle arrangementer (/admin) er stengt.'),
    // Oppretting av arrangementer uten Cloudflare Access og uten CREATE_KEY. BARE for lokal utvikling –
    // da kan alle som når /admin opprette arrangementer.
    adminNoAuth: ['true', '1', 'yes', 'ja'].includes((env.ADMIN_NO_AUTH || '').trim().toLowerCase()),
    // Tjenestene e-posten sendes med, i rekkefølge (se mailConfig.js). Tom liste: e-postene skrives til
    // konsollen i stedet (nyttig i utvikling). `unavailable`: MAIL_PROVIDER er satt, men ingen tjeneste er
    // brukbar – da feiler sendingen.
    mail: { providers: mail.providers, unavailable: mail.unavailable },
    // Tidssonen arrangementstider vises i, uavhengig av hvor gjesten befinner seg.
    timeZone: env.TIME_ZONE || 'Europe/Oslo',
    // Sett til f.eks. 1 når appen kjører bak én reverse proxy (Caddy, nginx, Fly, Railway …),
    // slik at rate limiting ser klientens ekte IP-adresse.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // Header med klientens ekte IP-adresse, brukt til rate limiting. Med Cloudflare Tunnel:
    // «cf-connecting-ip». Må bare settes når appen KUN kan nås gjennom Cloudflare, ellers kan
    // hvem som helst sende headeren selv.
    clientIpHeader: (env.CLIENT_IP_HEADER || '').toLowerCase(),

    // --- Oppretting av arrangementer (eget vertsnavn og Cloudflare Access) ---
    // Eget vertsnavn for oppretting (f.eks. arrangement-admin.domain.no). Når det er satt, svarer
    // /admin/ny og API-et for oppretting bare på dette vertsnavnet. Administrasjonen av ett arrangement
    // (/admin/<hash>#<nøkkel>) virker på alle vertsnavn – der er det nøkkelen som gir tilgang.
    adminHost: normalizeHost(env.ADMIN_HOST),
    // Når begge er satt, gir et gyldig Cloudflare Access-token rett til å opprette arrangementer.
    cfAccessTeamDomain: normalizeHost(env.CF_ACCESS_TEAM_DOMAIN),
    cfAccessAudiences: (env.CF_ACCESS_AUD || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

// `docker run --env-file` tar anførselstegn bokstavelig: EMAIL_FROM="Påmelding <a@b.no>" blir til
// en verdi som starter og slutter med ". Node (--env-file) og docker compose fjerner dem.
// For at .env skal virke likt uansett hvordan appen startes, fjernes ett par omsluttende
// anførselstegn her.
function unquoteAll(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const quoted = typeof value === 'string' && value.length >= 2 && /^(["']).*\1$/s.test(value);
    out[key] = quoted ? value.slice(1, -1) : value;
  }
  return out;
}

function parseEmails(value, warnings) {
  const emails = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const valid = emails.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  for (const e of emails) if (!valid.includes(e)) warnings.push(`ADMIN_EMAIL: «${e}» er ikke en gyldig e-postadresse og ignoreres.`);
  return valid;
}

// Bare tegn som kan stå etter # i en lenke uten å kodes (A–Z, a–z, 0–9, - og _), og minst 32 av dem.
// `openssl rand -hex 32` gir 64 tegn (256 tilfeldige bit).
// Gjelder både CREATE_KEY og OVERVIEW_KEY.
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

function parseKey(name, value, warnings, consequence) {
  const key = String(value ?? '').trim();
  if (!key) return null;
  if (KEY_PATTERN.test(key)) return key;
  warnings.push(`${name} ignoreres: må være minst 32 tegn, og bare A–Z, a–z, 0–9, - og _. Lag en med \`openssl rand -hex 32\`. ${consequence}`);
  return null;
}

function parseLanPort(value, port, warnings) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > 65535) {
    warnings.push(`LAN_PORT=${JSON.stringify(value)} ignoreres: må være et portnummer fra 1 til 65535. Ingen LAN-port startes.`);
    return null;
  }
  if (n === port) {
    warnings.push(`LAN_PORT=${n} ignoreres: kan ikke være den samme som PORT (${port}). Ingen LAN-port startes.`);
    return null;
  }
  return n;
}

function parseDays(value, warnings) {
  if (value === undefined || String(value).trim() === '') return 30;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 3650) return n;
  warnings.push(`DELETE_AFTER_DAYS=${JSON.stringify(value)} ignoreres: må være et helt antall dager fra 1 til 3650. Bruker 30.`);
  return 30;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

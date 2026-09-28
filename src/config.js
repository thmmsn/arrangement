// All konfigurasjon leses fra miljøvariabler (se .env.example).

import { loadSites, normalizeHost } from './sites.js';
import { loadWalletConfig } from './walletConfig.js';

export function loadConfig(rawEnv = process.env) {
  const env = unquoteAll(rawEnv);
  const port = Number(env.PORT) || 3000;
  // Nettstedene: hovednettstedet fra DOMAIN/BASE_URL/tema-variablene, pluss eventuelle SITE_<ID>_*.
  // Ugyldige verdier ignoreres og havner i `warnings`; alvorlige feil kaster SiteConfigError.
  const { sites, mainSite, warnings } = loadSites(env, { port });
  // Apple Wallet og Google Wallet: valgfrie, og slås av med en advarsel hvis oppsettet er ufullstendig.
  const wallet = loadWalletConfig(env);
  warnings.push(...wallet.warnings);

  return {
    port,
    sites,
    mainSite,
    // Hovednettstedets verdier, for kode som bare trenger «nettstedet» (logger, enkle oppsett).
    baseUrl: mainSite.baseUrl,
    theme: mainSite.theme,
    emailFrom: mainSite.emailFrom,
    warnings,
    wallet: { apple: wallet.apple, google: wallet.google },
    databasePath: env.DATABASE_PATH || 'data/booking.db',
    // Alle data om et arrangement (påmeldinger, navn, e-post, svar) slettes så mange dager etter
    // at det er over. Standard 30.
    deleteAfterDays: parseDays(env.DELETE_AFTER_DAYS, warnings),
    // Tjenesteadministratoren: får e-post med alle lenkene når et arrangement opprettes eller avlyses.
    // Flere adresser skilles med komma.
    adminEmails: parseEmails(env.ADMIN_EMAIL, warnings),
    // Oppretting av arrangementer uten Cloudflare Access. BARE for lokal utvikling – da kan alle som
    // når /admin opprette arrangementer.
    adminNoAuth: ['true', '1', 'yes', 'ja'].includes((env.ADMIN_NO_AUTH || '').trim().toLowerCase()),
    // Uten nøkkel skrives e-postene til konsollen i stedet for å sendes (nyttig i utvikling).
    resendApiKey: env.RESEND_API_KEY || '',
    // Tidssonen arrangementstider vises i, uavhengig av hvor gjesten befinner seg.
    timeZone: env.TIME_ZONE || 'Europe/Oslo',
    // Sett til f.eks. 1 når appen kjører bak én reverse proxy (Caddy, nginx, Fly, Railway …),
    // slik at rate limiting ser klientens ekte IP-adresse.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // Header med klientens ekte IP-adresse, brukt til rate limiting. Med Cloudflare Tunnel:
    // «cf-connecting-ip». Må bare settes når appen KUN kan nås gjennom Cloudflare, ellers kan
    // hvem som helst sende headeren selv.
    clientIpHeader: (env.CLIENT_IP_HEADER || '').toLowerCase(),

    // --- Administrasjon bak Cloudflare Access ---
    // Eget vertsnavn for admin (f.eks. booking-admin.domain.com). Når det er satt, svarer /admin og
    // /api/admin bare på dette vertsnavnet, og admin-lenkene i e-postene peker hit.
    adminHost: normalizeHost(env.ADMIN_HOST),
    // Når begge er satt, krever /admin og /api/admin et gyldig Cloudflare Access-token.
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

// Nettsteder: samme app, database og admin kan betjene flere offentlige domener samtidig.
// Hvert nettsted har sitt eget domene, språk, tema, avsenderadresse og sin egen base-URL.
//
// Hovednettstedet («main») kommer fra de vanlige variablene – DOMAIN, BASE_URL, EMAIL_FROM,
// SITE_LANG og temavariablene (SITE_NAME, LOGO_URL, COLOR_* …) – slik at eksisterende oppsett
// virker uendret.
//
// Et ekstra nettsted defineres med et prefiks, SITE_<ID>_, og finnes så snart SITE_<ID>_DOMAIN er satt:
//   SITE_COM_DOMAIN=arrangement.domain.no
//   SITE_COM_LANG=en
//   SITE_COM_SITE_NAME=…, SITE_COM_LOGO_URL=…, SITE_COM_EMAIL_FROM=…, SITE_COM_BASE_URL=…
// Temavariabler som ikke er satt for nettstedet, arves fra hovednettstedet. Tekst som er skrevet på
// ett språk (FOOTER_TEXT), arves bare hvis språket er det samme.
//
// Avsenderen følger domenet: første ledd blir adressen, resten blir e-postdomenet (se senderFor).
//   arrangement.arkitekt-thommesen.no  →  arrangement@arkitekt-thommesen.no
//   event.thommesenarchitecture.com    →  event@thommesenarchitecture.com
// Navnet på avsenderen er nettstedets SITE_NAME (uten det: «Påmelding» / «Registration»). EMAIL_FROM (hovednettstedet) og SITE_<ID>_EMAIL_FROM
// overstyrer.
//
// Forsiden (/) gir som standard den nakne 404-en. Med ROOT_REDIRECT (hovednettstedet) eller
// SITE_<ID>_ROOT_REDIRECT sendes den videre til en annen adresse, f.eks. firmaets nettsted. Arves ikke:
// hvert domene bestemmer selv hvor forsiden skal gå (et engelsk domene skal ikke havne på en norsk side).
//
// Språket for hovednettstedet heter SITE_LANG og ikke LANG, fordi LANG er en standard
// miljøvariabel i Linux (f.eks. «en_US.UTF-8») som ofte allerede er satt.

import { DEFAULT_LANG, isLanguage, LANGUAGES, translator } from '../public/assets/i18n/index.js';
import { LANGUAGE_BOUND_KEYS, loadTheme, THEME_ENV_KEYS } from './theme.js';

export const MAIN_SITE = 'main';
const DEFAULT_EMAIL_FROM = 'Påmelding <arrangement@example.com>';
// Variabler hovednettstedet bruker, og som begynner med SITE_ uten å være et prefiks.
const MAIN_SITE_KEYS = new Set(['SITE_NAME', 'SITE_LANG']);

export class SiteConfigError extends Error {}

/** «Arrangement.Domain.no:443/sti» → «arrangement.domain.no». Godtar også «https://…». */
export function normalizeHost(value) {
  return (value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @returns {{ sites: object[], mainSite: object, warnings: string[] }}
 * Kaster SiteConfigError ved feil som ville gitt et nettsted som ikke virker (f.eks. to nettsteder
 * på samme domene, eller en BASE_URL som ville gitt en uendelig løkke av omdirigeringer).
 */
export function loadSites(env, { port = 3000 } = {}) {
  const warnings = [];

  // ---------- Hovednettstedet ----------
  const mainDomain = normalizeHost(env.DOMAIN);
  const mainBaseUrl = trimSlash(env.BASE_URL || (mainDomain ? `https://${mainDomain}` : `http://localhost:${port}`));
  const mainLang = parseLang(env.SITE_LANG, DEFAULT_LANG, 'SITE_LANG', warnings);
  const mainTheme = loadTheme(env, { baseUrl: mainBaseUrl });
  warnings.push(...mainTheme.warnings);

  // Eldre oppsett har bare BASE_URL og ikke DOMAIN – da gjenkjennes nettstedet på vertsnavnet i BASE_URL.
  const mainHost = mainDomain || (env.BASE_URL ? hostOfUrl(mainBaseUrl) : '');
  const mainSite = makeSite({
    id: MAIN_SITE,
    host: mainHost,
    baseUrl: mainBaseUrl,
    lang: mainLang,
    emailFrom: env.EMAIL_FROM || senderFor(mainDomain, mainTheme.theme.siteName || translator(mainLang)('meta.siteNameFallback')) || DEFAULT_EMAIL_FROM,
    theme: mainTheme.theme,
    rootRedirect: parseRootRedirect(env.ROOT_REDIRECT, mainHost, 'ROOT_REDIRECT', warnings),
  });

  // ---------- Ekstra nettsteder ----------
  const prefixed = new Map(); // id → { VAR: verdi }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('SITE_') || MAIN_SITE_KEYS.has(key)) continue;
    const match = /^SITE_([A-Z0-9]+)_(.+)$/.exec(key);
    if (!match) {
      warnings.push(`${key} ignoreres: nettsteds-ID-en kan bare inneholde A–Z og 0–9 (f.eks. SITE_COM_DOMAIN).`);
      continue;
    }
    const [, id, name] = match;
    if (!prefixed.has(id)) prefixed.set(id, {});
    prefixed.get(id)[name] = value;
  }

  const sites = [mainSite];
  for (const [ID, vars] of prefixed) {
    const id = ID.toLowerCase();
    const name = (key) => `SITE_${ID}_${key}`;
    const domain = normalizeHost(vars.DOMAIN);
    if (!domain) {
      warnings.push(`${Object.keys(vars).map(name).join(', ')} ignoreres: ${name('DOMAIN')} mangler.`);
      continue;
    }
    if (id === MAIN_SITE) throw new SiteConfigError(`${name('DOMAIN')}: «${ID}» er reservert for hovednettstedet. Velg en annen ID.`);

    const baseUrl = trimSlash(vars.BASE_URL || `https://${domain}`);
    // Et arrangement på feil domene sendes videre til BASE_URL. Peker ikke BASE_URL på nettstedets
    // eget domene, ville nettleseren blitt sendt i ring.
    if (hostOfUrl(baseUrl) !== domain) {
      throw new SiteConfigError(`${name('BASE_URL')}=${baseUrl} må peke på ${name('DOMAIN')}=${domain}.`);
    }
    const lang = parseLang(vars.LANG, mainLang, name('LANG'), warnings);

    // Temaet: nettstedets egne verdier, ellers hovednettstedets. Ukjente variabler varsles.
    const merged = {};
    const source = {};
    for (const key of THEME_ENV_KEYS) {
      if (vars[key]) {
        merged[key] = vars[key];
        source[key] = name(key);
      } else if (env[key] && (lang === mainLang || !LANGUAGE_BOUND_KEYS.includes(key))) {
        merged[key] = env[key];
        source[key] = key;
      }
    }
    const known = new Set([...THEME_ENV_KEYS, 'DOMAIN', 'BASE_URL', 'LANG', 'EMAIL_FROM', 'ROOT_REDIRECT']);
    for (const key of Object.keys(vars)) {
      if (!known.has(key)) warnings.push(`${name(key)} ignoreres: ukjent innstilling for et nettsted.`);
    }

    const theme = loadTheme(merged, { baseUrl, nameOf: (key) => source[key] ?? name(key) });
    // Advarsler om arvede verdier er allerede gitt for hovednettstedet.
    warnings.push(...theme.warnings.filter((w) => w.startsWith(`SITE_${ID}_`)));

    const emailFrom = vars.EMAIL_FROM || senderFor(domain, theme.theme.siteName || translator(lang)('meta.siteNameFallback')) || mainSite.emailFrom;
    const rootRedirect = parseRootRedirect(vars.ROOT_REDIRECT, domain, name('ROOT_REDIRECT'), warnings);
    sites.push(makeSite({ id, host: domain, baseUrl, lang, emailFrom, theme: theme.theme, rootRedirect }));
  }

  // To nettsteder kan ikke dele domene – da ville det vært tilfeldig hvilket som svarte.
  const seen = new Map();
  for (const site of sites) {
    if (!site.host) continue;
    if (seen.has(site.host)) {
      throw new SiteConfigError(`Nettstedene «${seen.get(site.host)}» og «${site.id}» har samme domene: ${site.host}.`);
    }
    seen.set(site.host, site.id);
  }

  // En avsender på et annet domene enn nettstedet er nesten alltid en feil (f.eks. en kopiert linje):
  // gjestene får da e-post fra et domene de ikke kjenner igjen.
  for (const site of sites) {
    const mailHost = mailHostOf(site.emailFrom);
    if (site.host && mailHost && !sameDomain(mailHost, site.host)) {
      const name = site.id === MAIN_SITE ? 'EMAIL_FROM' : `SITE_${site.id.toUpperCase()}_EMAIL_FROM`;
      warnings.push(`${name}: avsenderen ${site.emailFrom} er ikke på nettstedets domene (${site.host}). E-post om arrangementene der kommer fra ${mailHost}.`);
    }
  }

  return { sites, mainSite, warnings };
}

// «Navn <lokal@domene>» eller «lokal@domene».
const EMAIL_FROM_PATTERN = /^(.*<)?\s*([^<>@\s]+)@([^<>@\s]+?)\s*(>?)\s*$/;

/** Domenet i en avsenderadresse, med små bokstaver, eller '' hvis den ikke kan leses. */
export function mailHostOf(emailFrom) {
  return EMAIL_FROM_PATTERN.exec(String(emailFrom ?? ''))?.[3].toLowerCase() ?? '';
}

// Samme domene, eller det ene er et underdomene av det andre (arrangement.domene.no og domene.no).
function sameDomain(a, b) {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Avsenderen laget fra nettstedets domene: første ledd er adressen, resten er e-postdomenet.
 *   arrangement.arkitekt-thommesen.no  →  «Thommesen Arkitekter <arrangement@arkitekt-thommesen.no>»
 * Et domene med bare to ledd (arkitekt-thommesen.no) har ikke noe ledd å ta av; da blir adressen
 * arrangement@arkitekt-thommesen.no. Uten domene (lokal utvikling): null.
 */
function senderFor(domain, siteName) {
  if (!domain) return null;
  const labels = domain.split('.');
  const address = labels.length >= 3 ? `${labels[0]}@${labels.slice(1).join('.')}` : `arrangement@${domain}`;
  return siteName ? `${displayName(siteName)} <${address}>` : address;
}

// Navnet i «Navn <adresse>». Med tegn som har en egen betydning i e-postadresser (f.eks. komma), må
// det stå i anførselstegn – ellers leses «Thommesen, Arkitekter <…>» som to mottakere.
function displayName(name) {
  const clean = name.replace(/[\r\n<>]/g, ' ').trim();
  return /[()[\]:;@\\,."]/.test(clean) ? `"${clean.replace(/(["\\])/g, '\\$1')}"` : clean;
}

function makeSite({ id, host, baseUrl, lang, emailFrom, theme, rootRedirect = null }) {
  const t = translator(lang);
  return {
    id,
    host,
    baseUrl,
    lang,
    emailFrom,
    theme,
    // Adressen forsiden (/) sendes videre til, eller null (forsiden gir den nakne 404-en).
    rootRedirect,
    t,
    // Navnet som vises i admin når man velger nettsted.
    label: `${theme.siteName || host || id} (${host || baseUrl.replace(/^https?:\/\//, '')}, ${lang})`,
  };
}

/**
 * ROOT_REDIRECT / SITE_<ID>_ROOT_REDIRECT: en full http(s)-adresse, f.eks. https://domain.no.
 * Noe annet (en sti, en adresse uten https://, javascript: …) ignoreres med en advarsel, og forsiden gir
 * da 404 som før. Det samme gjelder en adresse som peker på forsiden av nettstedet selv – den ville sendt
 * nettleseren i ring. En annen sti på samme domene (f.eks. et arrangement) er greit.
 */
function parseRootRedirect(value, host, name, warnings) {
  const raw = (value || '').trim();
  if (!raw) return null;
  let url = null;
  try {
    url = new URL(raw);
  } catch { /* ugyldig adresse */ }
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s"'<>\\]/.test(raw)) {
    warnings.push(`${name}=${JSON.stringify(value)} ignoreres: må være en full adresse som starter med https://, f.eks. https://domain.no. Forsiden gir 404.`);
    return null;
  }
  if (host && url.hostname === host && url.pathname === '/') {
    warnings.push(`${name}=${raw} ignoreres: peker på forsiden av nettstedet selv (${host}) og ville gitt en evig løkke. Forsiden gir 404.`);
    return null;
  }
  return url.href;
}

function parseLang(value, fallback, name, warnings) {
  const lang = (value || '').trim().toLowerCase();
  if (!lang) return fallback;
  if (isLanguage(lang)) return lang;
  warnings.push(`${name}=${JSON.stringify(value)} ignoreres: støttede språk er ${LANGUAGES.join(', ')}.`);
  return fallback;
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

// Nettsteder: samme app, database og admin kan betjene flere offentlige domener samtidig.
// Hvert nettsted har sitt eget domene, språk, tema, avsenderadresse og sin egen base-URL.
//
// Hovednettstedet («main») kommer fra de vanlige variablene – DOMAIN, BASE_URL, EMAIL_FROM,
// SITE_LANG og temavariablene (SITE_NAME, LOGO_URL, COLOR_* …) – slik at eksisterende oppsett
// virker uendret.
//
// Et ekstra nettsted defineres med et prefiks, SITE_<ID>_, og finnes så snart SITE_<ID>_DOMAIN er satt:
//   SITE_COM_DOMAIN=booking.domain.com
//   SITE_COM_LANG=en
//   SITE_COM_SITE_NAME=…, SITE_COM_LOGO_URL=…, SITE_COM_EMAIL_FROM=…, SITE_COM_BASE_URL=…
// Temavariabler og EMAIL_FROM som ikke er satt for nettstedet, arves fra hovednettstedet.
// Tekst som er skrevet på ett språk (FOOTER_TEXT), arves bare hvis språket er det samme.
//
// Språket for hovednettstedet heter SITE_LANG og ikke LANG, fordi LANG er en standard
// miljøvariabel i Linux (f.eks. «en_US.UTF-8») som ofte allerede er satt.

import { DEFAULT_LANG, isLanguage, LANGUAGES, translator } from '../public/assets/i18n/index.js';
import { LANGUAGE_BOUND_KEYS, loadTheme, THEME_ENV_KEYS } from './theme.js';

export const MAIN_SITE = 'main';
const DEFAULT_EMAIL_FROM = 'Påmelding <booking@example.com>';
// Variabler hovednettstedet bruker, og som begynner med SITE_ uten å være et prefiks.
const MAIN_SITE_KEYS = new Set(['SITE_NAME', 'SITE_LANG']);

export class SiteConfigError extends Error {}

/** «Booking.Domain.com:443/sti» → «booking.domain.com». Godtar også «https://…». */
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

  const mainSite = makeSite({
    id: MAIN_SITE,
    // Eldre oppsett har bare BASE_URL og ikke DOMAIN – da gjenkjennes nettstedet på vertsnavnet i BASE_URL.
    host: mainDomain || (env.BASE_URL ? hostOfUrl(mainBaseUrl) : ''),
    baseUrl: mainBaseUrl,
    lang: mainLang,
    emailFrom: env.EMAIL_FROM || DEFAULT_EMAIL_FROM,
    theme: mainTheme.theme,
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
    const known = new Set([...THEME_ENV_KEYS, 'DOMAIN', 'BASE_URL', 'LANG', 'EMAIL_FROM']);
    for (const key of Object.keys(vars)) {
      if (!known.has(key)) warnings.push(`${name(key)} ignoreres: ukjent innstilling for et nettsted.`);
    }

    const theme = loadTheme(merged, { baseUrl, nameOf: (key) => source[key] ?? name(key) });
    // Advarsler om arvede verdier er allerede gitt for hovednettstedet.
    warnings.push(...theme.warnings.filter((w) => w.startsWith(`SITE_${ID}_`)));

    sites.push(makeSite({ id, host: domain, baseUrl, lang, emailFrom: vars.EMAIL_FROM || mainSite.emailFrom, theme: theme.theme }));
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

  return { sites, mainSite, warnings };
}

function makeSite({ id, host, baseUrl, lang, emailFrom, theme }) {
  const t = translator(lang);
  return {
    id,
    host,
    baseUrl,
    lang,
    emailFrom,
    theme,
    t,
    // Navnet som vises i admin når man velger nettsted.
    label: `${theme.siteName || host || id} (${host || baseUrl.replace(/^https?:\/\//, '')}, ${lang})`,
  };
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

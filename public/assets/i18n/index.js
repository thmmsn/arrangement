// Språkstøtte, delt mellom nettleseren og serveren (Node importerer de samme filene).
import en from './en.js';
import nb from './nb.js';

export const DICTIONARIES = { nb, en };
export const LANGUAGES = Object.keys(DICTIONARIES);
export const DEFAULT_LANG = 'nb';

export function isLanguage(lang) {
  return Object.hasOwn(DICTIONARIES, lang);
}

function lookup(dict, key) {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
}

const cache = new Map();

/**
 * Oversetter for ett språk: t('form.thanks', { name: 'Ola' }) → «Takk, Ola!».
 * - {navn} i teksten byttes ut med vars.navn.
 * - Er verdien et objekt med «one»/«other», velges formen etter vars.count (Intl.PluralRules).
 * - Mangler nøkkelen, returneres selve nøkkelen, så feilen synes i stedet for å gi tom tekst.
 * t.lang og t.locale forteller hvilket språk oversetteren gjelder.
 */
export function translator(lang) {
  const resolved = isLanguage(lang) ? lang : DEFAULT_LANG;
  if (cache.has(resolved)) return cache.get(resolved);

  const dict = DICTIONARIES[resolved];
  const plurals = new Intl.PluralRules(dict.meta.locale);
  const t = (key, vars = {}) => {
    let value = lookup(dict, key);
    if (value && typeof value === 'object' && 'other' in value) {
      value = value[plurals.select(Number(vars.count))] ?? value.other;
    }
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
  };
  t.lang = resolved;
  t.locale = dict.meta.locale;
  /** Rå verdi (f.eks. et helt objekt med feltetiketter). */
  t.raw = (key) => lookup(dict, key);
  cache.set(resolved, t);
  return t;
}

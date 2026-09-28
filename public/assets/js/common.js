// Felles hjelpefunksjoner for alle sidene. Ingen rammeverk og ingen byggesteg – bare moderne JavaScript.
import * as dates from '../i18n/format.js';
import { translator } from '../i18n/index.js';

// Språket bestemmes av serveren (<html lang="…">): nettstedets språk på arrangementssidene,
// hovednettstedets språk på admin-sidene. All tekst hentes fra ordboken i /assets/i18n/.
export const t = translator(document.documentElement.lang);

/** Kaller API-et og kaster en feil med meldingen fra serveren (og eventuelle feltfeil) hvis noe går galt. */
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || t('common.genericError', { status: res.status }));
    err.status = res.status;
    err.errors = data.errors || {};
    err.data = data;
    throw err;
  }
  return data;
}

/** Laster opp et forsidebilde til et arrangement (selve bildet som body). */
export async function uploadImage(slug, adminKey, blob) {
  const res = await fetch(`/api/admin/events/${slug}/image`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type, Authorization: `Bearer ${adminKey}` },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('common.genericError', { status: res.status }));
  return data;
}

/**
 * Lager DOM-elementer: h('p', { class: 'x' }, 'tekst', h('b', {}, 'fet')).
 * Tekst settes alltid som tekstnoder, så innhold fra brukere kan aldri tolkes som HTML.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * Slug fra adressen: «k7hq2mxpr9az» fra /k7hq2mxpr9az, /k7hq2mxpr9az/avmelding, /admin/k7hq2mxpr9az,
 * /dorvakt/k7hq2mxpr9az og den eldre dørvaktadressen /k7hq2mxpr9az/skanner.
 */
export function slugFromPath() {
  const parts = location.pathname.split('/').filter(Boolean);
  return (parts[0] === 'admin' || parts[0] === 'dorvakt' ? parts[1] : parts[0])?.toLowerCase() || '';
}

/** Hemmeligheten etter # i adressen (admin-nøkkel, opprettingsnøkkel, dørvaktnøkkel eller avmeldingsnøkkel). */
export function secretFromHash() {
  return decodeURIComponent(location.hash.slice(1));
}

// ---------- Datoer og lister (på sidens språk) ----------

export const formatDay = (iso, timeZone) => dates.formatDay(iso, timeZone, t);
export const formatTime = (iso, timeZone) => dates.formatTime(iso, timeZone, t);
export const formatEventTime = (startsAt, endsAt, timeZone) => dates.formatEventTime(startsAt, endsAt, timeZone, t);
export const formatShort = (iso, timeZone) => dates.formatShort(iso, timeZone, t);
export const formatAnswer = (field, answers) => dates.formatAnswer(field, answers, t);
export const nameList = (names) => dates.nameList(names, t);

// <input type="datetime-local"> har ingen tidssone. Vi tolker alltid verdien i arrangementets
// tidssone (f.eks. Europe/Oslo), slik at tidene blir riktige selv om arrangøren sitter i utlandet.

/** Tidssonens avvik fra UTC i millisekunder ved et gitt tidspunkt (inkl. sommertid). */
function tzOffset(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]));
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** ISO-tid → verdi for datetime-local, som veggklokketid i tidssonen. */
export function toLocalInput(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() + tzOffset(date, timeZone)).toISOString().slice(0, 16);
}

/** Verdi fra datetime-local (veggklokketid i tidssonen) → ISO-tid i UTC. */
export function fromLocalInput(value, timeZone) {
  if (!value) return null;
  const [y, m, d, hh, mm] = value.split(/[-T:]/).map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Vi søker t slik at t + avvik(t) = veggklokketid. Avviket avhenger av t selv (sommertid),
  // så vi gjetter først og korrigerer én gang – det holder også rundt sommertidsskiftet.
  const guess = wall - tzOffset(new Date(wall), timeZone);
  return new Date(wall - tzOffset(new Date(guess), timeZone)).toISOString();
}

// ---------- Tekst ----------

/** Gjør nettadresser i vanlig tekst om til lenker – trygt, uten innerHTML. */
export function linkify(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    fragment.append(text.slice(last, match.index));
    fragment.append(h('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer' }, match[0]));
    last = match.index + match[0].length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

// ---------- Skjemafeil ----------

/** Viser feltfeil fra serveren under riktige felter. Nøkkelen matches mot data-error-for. */
export function showFieldErrors(form, errors) {
  clearFieldErrors(form);
  // Fjern feilmeldingen for et felt så snart brukeren begynner å rette det.
  if (!form.dataset.clearsErrors) {
    form.dataset.clearsErrors = 'true';
    const clear = (e) => {
      const row = e.target.closest('.has-error');
      if (!row) return;
      row.classList.remove('has-error');
      row.querySelector(':scope > .field-error')?.remove();
    };
    form.addEventListener('input', clear);
    form.addEventListener('change', clear);
  }
  let first = null;
  for (const [key, message] of Object.entries(errors || {})) {
    const row = form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
    if (!row) continue;
    row.classList.add('has-error');
    row.append(h('span', { class: 'field-error' }, message));
    first ??= row;
  }
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  first?.querySelector('input, select, textarea')?.focus({ preventScroll: true });
}

export function clearFieldErrors(form) {
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
  form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
}

export function notice(type, ...content) {
  return h('div', { class: `notice ${type}`, role: type === 'error' ? 'alert' : 'status' }, ...content);
}

// Kopiering til utklippstavlen.
// navigator.clipboard finnes bare i en «sikker kontekst» (HTTPS eller localhost). Over vanlig HTTP –
// f.eks. den betrodde LAN-porten (http://192.168.…:3001) – mangler den. Da kopieres teksten via et
// skjult tekstfelt og document.execCommand('copy'), som virker i alle nettlesere så lenge det skjer
// rett etter et klikk. Ingen popup: teksten havner på utklippstavlen med én gang.
function copyViaTextarea(text) {
  const focused = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true; // hindrer at tastaturet dukker opp på mobil
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length); // iOS velger ellers ingenting
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  focused?.focus?.({ preventScroll: true });
  return copied;
}

/** Legger `text` på utklippstavlen. Gir true når det lyktes. */
export async function writeClipboard(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* f.eks. nektet av nettleseren – prøv den andre måten */ }
  }
  return copyViaTextarea(text);
}

/**
 * Kopier-knappen: kopierer `text` og viser «Kopiert!» på knappen en liten stund. Lykkes det ikke
 * (svært sjelden), merkes teksten i `field` (lenkefeltet ved siden av knappen), så den kan kopieres
 * med tastatur eller langt trykk – uten popup.
 */
export async function copyToClipboard(text, button, field = null) {
  const copied = await writeClipboard(text);
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  button.textContent = t(copied ? 'common.copied' : 'common.copyFailed');
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => { button.textContent = original; }, copied ? 1500 : 4000);
  if (!copied && field) {
    field.focus();
    field.select();
  }
}

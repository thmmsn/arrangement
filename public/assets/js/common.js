// Felles hjelpefunksjoner for alle sidene. Ingen rammeverk og ingen byggesteg – bare moderne JavaScript.

/** Kaller API-et og kaster en feil med norsk melding (og eventuelle feltfeil) hvis noe går galt. */
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Noe gikk galt (${res.status})`);
    err.status = res.status;
    err.errors = data.errors || {};
    err.data = data;
    throw err;
  }
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

/** Slug fra adressen: «k7hq2mxpr9az» fra både /k7hq2mxpr9az, /k7hq2mxpr9az/avmelding og /admin/k7hq2mxpr9az. */
export function slugFromPath() {
  const parts = location.pathname.split('/').filter(Boolean);
  return (parts[0] === 'admin' ? parts[1] : parts[0])?.toLowerCase() || '';
}

/** Hemmeligheten etter # i adressen (admin-nøkkel eller avmeldingsnøkkel). */
export function secretFromHash() {
  return decodeURIComponent(location.hash.slice(1));
}

// ---------- Datoer ----------

function fmt(timeZone, options) {
  return new Intl.DateTimeFormat('nb-NO', { timeZone, ...options });
}

export function formatDay(iso, timeZone) {
  return fmt(timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

export function formatTime(iso, timeZone) {
  return fmt(timeZone, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function formatEventTime(startsAt, endsAt, timeZone) {
  const start = `${formatDay(startsAt, timeZone)} kl. ${formatTime(startsAt, timeZone)}`;
  if (!endsAt) return start;
  if (formatDay(startsAt, timeZone) === formatDay(endsAt, timeZone)) return `${start}–${formatTime(endsAt, timeZone)}`;
  return `${start} – ${formatDay(endsAt, timeZone)} kl. ${formatTime(endsAt, timeZone)}`;
}

export function formatShort(iso, timeZone) {
  return fmt(timeZone, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

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

export async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'Kopiert!';
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    prompt('Kopier teksten:', text);
  }
}

// Skannersiden for dørvakter: /dorvakt/<slug>#<dørvaktnøkkel> (eldre lenker: /<slug>/skanner#<nøkkel>).
//
// 1. Første gang: dørvakten skriver eventuelt navnet sitt og trykker Start. Nøkkelen sendes til
//    serveren, som lagrer en informasjonskapsel (HttpOnly) for arrangementet, og nøkkelen fjernes
//    fra adresselinjen så den ikke står synlig på skjermen.
// 2. Deretter: skann QR-koder med kameraet her, tast inn billettnummeret, eller søk på navn.
//    Vanlig kamera-app virker også: QR-koden åpner billetten, og billettsiden sjekker inn.
// 3. Uten nett: siden har en liste med hasher av alle billettene og kan kjenne igjen en ekte
//    billett selv. Innsjekkingen legges i kø og sendes når nettet er tilbake.
import { api, formatEventTime, h, notice, secretFromHash, t } from './common.js';
import { feedback, resultView } from './staff.js';

const app = document.getElementById('app');
// Tolkes her, ikke med slugFromPath i common.js: rett etter en ny versjon kan nettleseren ha en eldre
// common.js i hurtigbufferen (inntil én time), og den kjenner ikke /dorvakt/<slug>. Denne filen lastes
// alltid i riktig versjon (scanner.js?v=<versjon>), så skanneren virker også i den timen.
const [first, second] = location.pathname.split('/').filter(Boolean);
const slug = ((first === 'dorvakt' ? second : first) || '').toLowerCase();
const key = secretFromHash();
const QUEUE_KEY = `dv-queue-${slug}`;
const NAME_KEY = 'dv-name';
const REFRESH_MS = 30_000;
const SAME_CODE_PAUSE_MS = 3000;

let status = null; // { event, staff, stats, offline }
let resultArea;
let statsLine;
let pendingLine;

// ---------- Oppstart ----------

async function start() {
  if (key) return renderLogin();
  try {
    status = await api(`/events/${slug}/scanner`);
  } catch (err) {
    if (err.status) {
      app.replaceChildren(h('p', { class: 'kicker' }, t('scanner.title')), h('h1', {}, t('scanner.notLoggedIn')), h('p', {}, t('scanner.missingKey')));
      return;
    }
    status = readCachedStatus();
    if (!status) {
      app.replaceChildren(notice('error', err.message));
      return;
    }
  }
  cacheStatus();
  render();
  setInterval(refresh, REFRESH_MS);
  setInterval(flushQueue, 15_000);
  addEventListener('online', flushQueue);
  flushQueue();
}

function renderLogin() {
  const name = h('input', { id: 'staff-name', type: 'text', maxLength: 60, autocomplete: 'name', value: localStorage.getItem(NAME_KEY) || '' });
  const status = h('div');
  const form = h('form', { class: 'card' },
    status,
    h('div', { class: 'form-row' }, h('label', { for: 'staff-name' }, t('scanner.nameLabel')), name),
    h('button', { class: 'btn block', type: 'submit' }, t('scanner.start')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/events/${slug}/scanner/login`, { method: 'POST', body: { key, name: name.value } });
      try { localStorage.setItem(NAME_KEY, name.value); } catch { /* privat modus */ }
      // Fjern nøkkelen fra adressen, så den ikke står på skjermen eller i historikken.
      history.replaceState(null, '', location.pathname);
      location.reload();
    } catch (err) {
      status.replaceChildren(notice('error', err.message));
    }
  });
  app.replaceChildren(h('p', { class: 'kicker' }, t('scanner.title')), h('h1', {}, t('scanner.staffMode')), form);
  name.focus();
}

// ---------- Hovedvisningen ----------

function render() {
  const { event } = status;
  document.title = t('scanner.documentTitle', { title: event.title });
  resultArea = h('div', { class: 'scan-area' });
  statsLine = h('p', { class: 'scan-stats' });
  pendingLine = h('p', { class: 'small', role: 'status' });

  const logout = h('button', { class: 'btn secondary small', type: 'button' }, t('scanner.logout'));
  logout.addEventListener('click', async () => {
    await api(`/events/${slug}/scanner/logout`, { method: 'POST', body: {} }).catch(() => {});
    location.reload();
  });

  app.replaceChildren(...[
    h('p', { class: 'kicker' }, t('scanner.title')),
    h('h1', {}, event.title),
    h('p', { class: 'muted' }, formatEventTime(event.startsAt, event.endsAt, event.timeZone), event.location ? ` · ${event.location}` : ''),
    event.cancelled ? notice('error', t('status.cancelled')) : null,
    statsLine,
    pendingLine,
    resultArea,
    cameraSection(),
    codeForm(),
    searchSection(),
    h('div', { class: 'actions' },
      status.staff?.name ? h('span', { class: 'muted small' }, t('scanner.loggedInAs', { name: status.staff.name })) : null,
      logout),
  ].filter(Boolean));
  updateStats();
}

function updateStats() {
  statsLine.textContent = t('scanner.stats', status.stats);
  const queued = readQueue().length;
  pendingLine.textContent = queued ? `${t('scanner.offline')}: ${t('scanner.pending', { count: queued })}` : '';
}

async function refresh() {
  if (document.hidden) return;
  try {
    status = await api(`/events/${slug}/scanner`);
    cacheStatus();
    updateStats();
  } catch { /* uten nett: beholder listen vi har */ }
}

function showResult(result, note = '') {
  if (result.stats) {
    status.stats = result.stats;
    updateStats();
  }
  resultArea.replaceChildren(...resultView(result, {
    slug, timeZone: status.event.timeZone, note, onUpdate: (next) => { markOffline(next.person); showResult(next); },
  }));
  feedback(result.result === 'checked_in');
}

// ---------- Innsjekking ----------

async function checkIn(body) {
  try {
    const result = await api(`/events/${slug}/scanner/checkin`, { method: 'POST', body });
    showResult(result);
    markOffline(result.person);
  } catch (err) {
    if (err.status) return showResult(err.data?.result ? err.data : { result: 'invalid', error: err.message });
    await checkInOffline(body); // Ingen svar fra serveren: sjekk mot listen på telefonen.
  }
}

// Holder listen på telefonen i takt, så den vet hvem som er inne om nettet forsvinner.
function markOffline(person) {
  const entry = person && status.offline.find((e) => e.id === person.id);
  if (entry) entry.checkedInAt = person.checkedInAt;
}

const sha256 = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
};

async function checkInOffline(body) {
  let entry = null;
  if (body.token) {
    const hash = await sha256(body.token);
    entry = status.offline.find((e) => e.token === hash);
  } else if (body.code && doorCode(body.code)) {
    entry = status.offline.find((e) => e.door === doorCode(body.code));
  } else if (body.code) {
    const hash = await sha256(normalizeCode(body.code));
    entry = status.offline.find((e) => e.code === hash);
  } else if (body.id) {
    entry = status.offline.find((e) => e.id === body.id);
  }
  if (!entry) return showResult({ result: 'invalid' }, t('scanner.offline'));
  const person = { id: entry.id, name: entry.name, checkedInAt: entry.checkedInAt };
  if (entry.checkedInAt) return showResult({ result: 'already', person, offline: true }, t('scanner.offline'));

  entry.checkedInAt = new Date().toISOString();
  writeQueue([...readQueue(), { ...body, at: entry.checkedInAt }]);
  cacheStatus();
  status.stats = { ...status.stats, checkedIn: status.stats.checkedIn + 1 };
  showResult({ result: 'checked_in', person: { ...person, checkedInAt: entry.checkedInAt }, offline: true }, t('scanner.offlineNote'));
}

// Sender køen fra tiden uten nett. Tidspunktet det faktisk skjedde, sendes med.
let flushing = false;
async function flushQueue() {
  if (flushing || !readQueue().length) return;
  flushing = true;
  try {
    for (const item of readQueue()) {
      try {
        await api(`/events/${slug}/scanner/checkin`, { method: 'POST', body: item });
      } catch (err) {
        if (!err.status) break; // Fortsatt uten nett – prøv igjen senere.
      }
      writeQueue(readQueue().slice(1));
    }
  } finally {
    flushing = false;
    updateStats();
    refresh();
  }
}

// ---------- Lagring på telefonen ----------

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; }
}
function writeQueue(queue) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* privat modus */ }
}
function cacheStatus() {
  try { sessionStorage.setItem(`dv-status-${slug}`, JSON.stringify(status)); } catch { /* ikke viktig */ }
}
function readCachedStatus() {
  try { return JSON.parse(sessionStorage.getItem(`dv-status-${slug}`)); } catch { return null; }
}

// ---------- Kamera ----------

function cameraSection() {
  const video = h('video', { class: 'scan-video', playsInline: true, muted: true, hidden: true });
  const canvas = document.createElement('canvas');
  const button = h('button', { class: 'btn block', type: 'button' }, t('scanner.scan'));
  const error = h('div');
  let stream = null;
  let detector = null;
  let last = { value: '', at: 0 };

  async function startCamera() {
    error.replaceChildren();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      error.replaceChildren(notice('error', t('scanner.cameraError')));
      return;
    }
    // Innebygd QR-leser (Chrome, Android) er raskest; ellers jsQR.
    try {
      if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        detector = new BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch { detector = null; }
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    button.textContent = t('scanner.stopScan');
    scan();
  }

  function stopCamera() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.hidden = true;
    button.textContent = t('scanner.scan');
  }

  async function read() {
    if (detector) return (await detector.detect(video))[0]?.rawValue ?? null;
    if (!window.jsQR || video.readyState < 2) return null;
    // Mindre bilde = raskere tolking; en QR-kode på en telefonskjerm er stor nok i 640 piksler.
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  }

  async function scan() {
    if (!stream) return;
    try {
      const value = await read();
      // Samme kode rett etter hverandre (telefonen holdes foran kameraet) teller bare én gang.
      if (value && (value !== last.value || Date.now() - last.at > SAME_CODE_PAUSE_MS)) {
        last = { value, at: Date.now() };
        const body = parseScan(value);
        if (body) await checkIn(body);
        else showResult({ result: 'invalid' });
      }
    } catch { /* et enkelt bilde som ikke kunne leses */ }
    setTimeout(scan, 150);
  }

  button.addEventListener('click', () => (stream ? stopCamera() : startCamera()));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
  return h('section', { class: 'scan-camera' }, error, video, button);
}

/** Det QR-koden inneholder → { token } (lenke til en billett) eller { code } (billettnummer). */
function parseScan(value) {
  try {
    const match = /^\/t\/([A-Za-z0-9_-]+)$/.exec(new URL(value).pathname);
    if (match) return { token: match[1] };
  } catch { /* ikke en lenke */ }
  if (doorCode(value)) return { code: doorCode(value) };
  const code = normalizeCode(value);
  return code.length === 10 ? { code } : null;
}

const normalizeCode = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
// Dørkode: 5 bokstaver (uten I og O). Samme regel som på serveren (ids.js).
const doorCode = (value) => {
  const code = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Z]{5}$/.test(code) ? code : null;
};

// ---------- Billettnummer og navnesøk ----------

function codeForm() {
  // Store bokstaver uten autokorrektur. Dørkoden (5 bokstaver) sendes så snart den er skrevet – ingen
  // knapp å trykke på. Billettnummer fra eldre billetter (10 tegn med tall) sendes med Enter.
  const input = h('input', {
    id: 'ticket-code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off',
    spellcheck: false, maxLength: 20, enterKeyHint: 'go',
  });
  input.addEventListener('input', () => {
    if (doorCode(input.value) && input.value.replace(/[\s-]/g, '').length === 5) form.requestSubmit();
  });
  const form = h('form', { class: 'form-row scan-code' },
    h('label', { for: 'ticket-code' }, t('scanner.codeLabel')),
    h('div', { class: 'linkbox' }, input, h('button', { class: 'btn', type: 'submit' }, t('scanner.codeButton'))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    await checkIn({ code: input.value });
    input.value = '';
    input.focus();
  });
  return form;
}

function searchSection() {
  const input = h('input', { id: 'search', type: 'search', autocomplete: 'off', spellcheck: false });
  const results = h('ul', { class: 'search-results' });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return results.replaceChildren();
      try {
        const data = await api(`/events/${slug}/scanner/search?q=${encodeURIComponent(q)}`);
        results.replaceChildren(...(data.results.length
          ? data.results.map(searchResult)
          : [h('li', { class: 'muted' }, t('scanner.noResults'))]));
      } catch { /* uten nett: søk er ikke tilgjengelig */ }
    }, 250);
  });
  return h('section', { class: 'form-row' }, h('label', { for: 'search' }, t('scanner.searchLabel')), input, results);
}

function searchResult(person) {
  const button = person.checkedInAt
    ? h('span', { class: 'badge' }, t('scanner.checkedIn'))
    : h('button', { class: 'btn small', type: 'button' }, t('scanner.checkInButton'));
  if (!person.checkedInAt) button.addEventListener('click', () => checkIn({ id: person.id }));
  return h('li', {},
    h('span', {}, person.name, person.bookedBy ? h('span', { class: 'by' }, t('scanner.bookedBy', { name: person.bookedBy })) : null),
    button);
}

start();

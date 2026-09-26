import { api, copyToClipboard, formatEventTime, formatShort, h, notice, secretFromHash, slugFromPath } from './common.js';
import { createEventForm } from './event-form.js';

const app = document.getElementById('app');
const slug = slugFromPath();
const key = secretFromHash();
const auth = { Authorization: `Bearer ${key}` };

const STATUS_TEXT = {
  open: 'Påmeldingen er åpen',
  closed: 'Påmeldingen er stengt',
  deadline_passed: 'Påmeldingsfristen er ute',
  full: 'Arrangementet er fullt',
};

let event;
let registrations;
let flash = null; // Melding som vises øverst etter en handling.

async function load() {
  if (!key) {
    app.replaceChildren(h('h1', {}, 'Mangler nøkkel'),
      h('p', {}, 'Åpne administrasjonslenken nøyaktig slik du fikk den – den slutter med # og en lang kode.'));
    return;
  }
  try {
    ({ event, registrations } = await api(`/admin/events/${slug}`, { headers: auth }));
  } catch (err) {
    app.replaceChildren(h('h1', {}, 'Ingen tilgang'), h('p', {}, err.message));
    return;
  }
  document.title = `Admin: ${event.title}`;
  render();
}

// Alle feltene arrangementet har, i formatet PUT-endepunktet forventer.
function eventPayload(overrides = {}) {
  const { title, description, location, startsAt, endsAt, registrationDeadline, capacity, maxPerBooking, imageUrl,
    showCount, isOpen, organizerName, organizerEmail, fields } = event;
  return { title, description, location, startsAt, endsAt, registrationDeadline, capacity, maxPerBooking, imageUrl,
    showCount, isOpen, organizerName, organizerEmail, fields, ...overrides };
}

async function save(payload, message) {
  ({ event } = await api(`/admin/events/${slug}`, { method: 'PUT', body: payload, headers: auth }));
  flash = notice('success', message);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  const tz = event.timeZone;
  app.replaceChildren(...[
    flash,
    h('p', { class: 'kicker' }, 'Administrasjon'),
    h('h1', {}, event.title),
    h('p', { class: 'muted' }, formatEventTime(event.startsAt, event.endsAt, tz), event.location ? ` · ${event.location}` : ''),
    overviewCard(),
    guestsCard(),
    editCard(),
    dangerCard(),
  ].filter(Boolean));
  flash = null;
}

function overviewCard() {
  const url = event.url;
  const copy = h('button', { class: 'btn secondary small', type: 'button' }, 'Kopier');
  copy.addEventListener('click', () => copyToClipboard(url, copy));
  const field = h('input', { type: 'text', value: url, readOnly: true, 'aria-label': 'Påmeldingslenke' });
  field.addEventListener('focus', () => field.select());

  const toggle = h('button', { class: `btn small ${event.isOpen ? 'danger' : ''}`, type: 'button' },
    event.isOpen ? 'Steng påmeldingen' : 'Åpne påmeldingen');
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await save(eventPayload({ isOpen: !event.isOpen }), event.isOpen ? 'Påmeldingen er stengt.' : 'Påmeldingen er åpnet.');
    } catch (err) {
      alert(err.message);
      toggle.disabled = false;
    }
  });

  return h('section', { class: 'card' },
    h('div', { class: 'stats' },
      stat(event.count, event.count === 1 ? 'påmeldt' : 'påmeldte'),
      bookingsStat(),
      event.capacity !== null ? stat(event.spotsLeft, `ledige av ${event.capacity}`) : stat('∞', 'ubegrenset antall plasser'),
      h('div', { class: 'stat' },
        h('div', {}, h('span', { class: `badge ${event.status === 'open' ? '' : 'closed'}` }, STATUS_TEXT[event.status])),
        h('div', { class: 'name' }, event.registrationDeadline ? `Frist: ${formatShort(event.registrationDeadline, event.timeZone)}` : 'Stenger ved start')),
    ),
    h('div', { class: 'form-row' },
      h('span', { class: 'label' }, 'Påmeldingslenke', h('span', { class: 'hint' }, 'Del denne. Arrangementet kan bare nås via denne lenken.')),
      h('div', { class: 'linkbox' }, field, copy, h('a', { class: 'btn secondary small', href: url, target: '_blank', rel: 'noopener' }, 'Åpne'))),
    h('div', { class: 'actions' }, toggle,
      h('span', { class: 'muted small' }, event.showCount ? 'Antall påmeldte vises offentlig.' : 'Antall påmeldte er skjult for gjestene.')),
  );
}

// Antall påmeldinger (grupper). Én påmelding kan gjelde flere personer.
function bookingsStat() {
  const n = new Set(registrations.map((r) => r.bookingId)).size;
  return stat(n, n === 1 ? 'påmelding' : 'påmeldinger');
}

function stat(value, name) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'name' }, name));
}

function answerText(field, answers) {
  const value = answers?.[field.id];
  if (field.type === 'checkbox') return value === true ? 'Ja' : value === false ? 'Nei' : '';
  return value ?? '';
}

function guestsCard() {
  const csv = h('button', { class: 'btn secondary small', type: 'button', disabled: !registrations.length }, 'Last ned som CSV (Excel)');
  csv.addEventListener('click', downloadCsv);

  const emails = h('button', { class: 'btn secondary small', type: 'button', disabled: !registrations.length }, 'Kopier alle e-postadresser');
  // Både e-postene til den som meldte på og eventuelle e-poster til personer som ble lagt til.
  const allEmails = [...new Set(registrations.flatMap((r) => [r.contactEmail, r.email]).filter(Boolean))];
  emails.addEventListener('click', () => copyToClipboard(allEmails.join(', '), emails));

  const table = registrations.length
    ? h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, 'Navn'), h('th', {}, 'E-post'),
          event.fields.map((f) => h('th', {}, f.label)),
          h('th', {}, 'Påmeldt'), h('th', {}))),
        h('tbody', {}, registrations.map((r, i) => h('tr', { class: r.position > 0 ? 'added' : '' },
          h('td', { class: 'num' }, i + 1),
          // Personer som er lagt til av en annen, vises rett under og litt innrykket med «meldt på av».
          h('td', {}, r.name, r.position > 0
            ? h('span', { class: 'by' }, `meldt på av ${r.contactName}`) : null),
          h('td', {}, r.email ? h('a', { href: `mailto:${r.email}` }, r.email) : h('span', { class: 'muted' }, '–')),
          event.fields.map((f) => h('td', { class: 'answer' }, answerText(f, r.answers))),
          h('td', { class: 'small muted' }, formatShort(r.createdAt, event.timeZone)),
          h('td', {}, h('button', { class: 'btn danger small', type: 'button', onclick: () => removeGuest(r) }, 'Fjern')),
        )))))
    : h('p', { class: 'muted' }, 'Ingen påmeldte ennå.');

  return h('section', { class: 'card' },
    h('h2', {}, `Påmeldte (${registrations.length})`),
    h('div', { class: 'actions' }, csv, emails),
    table,
  );
}

async function removeGuest(registration) {
  if (!confirm(`Fjerne ${registration.name} fra listen? Gjesten får ingen beskjed om dette.`)) return;
  try {
    await api(`/admin/events/${slug}/registrations/${registration.id}`, { method: 'DELETE', headers: auth });
    flash = notice('success', `${registration.name} er fjernet.`);
    await load();
  } catch (err) {
    alert(err.message);
  }
}

async function downloadCsv() {
  const res = await fetch(`/api/admin/events/${slug}/registrations.csv`, { headers: auth });
  if (!res.ok) return alert('Kunne ikke laste ned filen.');
  const url = URL.createObjectURL(await res.blob());
  const link = h('a', { href: url, download: `pameldte-${slug}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function editCard() {
  const { form } = createEventForm({
    initial: event,
    timeZone: event.timeZone,
    editing: true,
    submitLabel: 'Lagre endringer',
    onSubmit: (payload) => save(payload, 'Endringene er lagret.'),
  });
  return h('details', { class: 'card section' }, h('summary', {}, 'Rediger arrangementet'), form);
}

function dangerCard() {
  const button = h('button', { class: 'btn danger', type: 'button' }, 'Slett arrangementet');
  button.addEventListener('click', async () => {
    const answer = prompt(`Dette sletter arrangementet og alle ${event.count} påmeldinger for godt.\nSkriv SLETT for å bekrefte:`);
    if (answer?.trim().toUpperCase() !== 'SLETT') return;
    try {
      await api(`/admin/events/${slug}`, { method: 'DELETE', headers: auth });
      app.replaceChildren(h('h1', {}, 'Arrangementet er slettet'), h('p', {}, 'Arrangementet og alle påmeldingene er fjernet.'));
    } catch (err) {
      alert(err.message);
    }
  });
  return h('section', { class: 'card' },
    h('h3', {}, 'Slett arrangement'),
    h('p', { class: 'muted small' }, 'Sletter arrangementet og alle påmeldinger permanent. Lenkene slutter å virke.'),
    button);
}

load();

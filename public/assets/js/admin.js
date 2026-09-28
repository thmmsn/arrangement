import {
  api, copyToClipboard, uploadImage, formatAnswer, formatEventTime, formatShort, h, notice, secretFromHash, slugFromPath, t,
} from './common.js';
import { createEventForm } from './event-form.js';

const app = document.getElementById('app');
const slug = slugFromPath();
const key = secretFromHash();
const auth = { Authorization: `Bearer ${key}` };

let event;
let registrations;
let sites = [];
let wallets = {};
let skins = [];
// /admin/<slug>/avlys (lenken i e-posten) åpner siden rett på «Avlys arrangement».
const openCancel = location.pathname.endsWith('/avlys');
let flash = null; // Melding som vises øverst etter en handling.

async function load() {
  if (!key) {
    app.replaceChildren(h('h1', {}, t('admin.missingKeyTitle')), h('p', {}, t('admin.missingKeyText')));
    return;
  }
  try {
    const [data, config] = await Promise.all([
      api(`/admin/events/${slug}`, { headers: auth }),
      api('/admin/config'),
    ]);
    ({ event, registrations } = data);
    ({ sites, wallets = {}, skins = [] } = config);
  } catch (err) {
    app.replaceChildren(h('h1', {}, t('admin.noAccess')), h('p', {}, err.message));
    return;
  }
  document.title = t('admin.eventTitle', { title: event.title });
  render();
  if (openCancel && !load.scrolled) {
    load.scrolled = true;
    const card = document.getElementById('cancel-card');
    if (card) {
      card.open = true;
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

// Alle feltene arrangementet har, i formatet PUT-endepunktet forventer.
function eventPayload(overrides = {}) {
  const { site, title, description, location, geo, startsAt, endsAt, registrationDeadline, capacity, maxPerBooking, imageUrl,
    showCount, isOpen, allowLate, organizerName, organizerEmail, fields, features, skin } = event;
  return { site, title, description, location, geo, startsAt, endsAt, registrationDeadline, capacity, maxPerBooking, imageUrl,
    showCount, isOpen, allowLate, organizerName, organizerEmail, fields, features, skin, ...overrides };
}

async function save(payload, message, image = {}) {
  ({ event } = await api(`/admin/events/${slug}`, { method: 'PUT', body: payload, headers: auth }));
  if (image.upload) event.uploadedImage = (await uploadImage(slug, key, image.upload)).uploadedImage;
  if (image.removeUpload) {
    await api(`/admin/events/${slug}/image`, { method: 'DELETE', headers: auth });
    event.uploadedImage = null;
  }
  flash = notice('success', message);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  const tz = event.timeZone;
  app.replaceChildren(...[
    flash,
    h('p', { class: 'kicker' }, t('admin.kicker')),
    h('h1', {}, event.title),
    h('p', { class: 'muted' }, formatEventTime(event.startsAt, event.endsAt, tz), event.location ? ` · ${event.location}` : ''),
    event.cancelledAt ? notice('error', t('admin.cancelledBanner', { date: formatShort(event.cancelledAt, tz) })) : null,
    overviewCard(),
    event.scannerUrl ? scannerCard() : null,
    guestsCard(),
    editCard(),
    cancelCard(),
    dangerCard(),
  ].filter(Boolean));
  flash = null;
}

function overviewCard() {
  const url = event.url;
  const copy = h('button', { class: 'btn secondary small', type: 'button' }, t('common.copy'));
  copy.addEventListener('click', () => copyToClipboard(url, copy));
  const field = h('input', { type: 'text', value: url, readOnly: true, 'aria-label': t('admin.link') });
  field.addEventListener('focus', () => field.select());

  const toggle = h('button', { class: `btn small ${event.isOpen ? 'danger' : ''}`, type: 'button' },
    event.isOpen ? t('admin.closeRegistration') : t('admin.openRegistration'));
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await save(eventPayload({ isOpen: !event.isOpen }), event.isOpen ? t('admin.closedDone') : t('admin.openedDone'));
    } catch (err) {
      alert(err.message);
      toggle.disabled = false;
    }
  });

  const site = sites.find((s) => s.id === event.site);
  return h('section', { class: 'card' },
    h('div', { class: 'stats' },
      stat(event.count, t('admin.registered', { count: event.count })),
      bookingsStat(),
      event.features.tickets ? stat(event.checkedIn, t('admin.checkedIn')) : null,
      event.capacity !== null
        ? stat(event.spotsLeft, t('admin.spotsLeftOf', { capacity: event.capacity }))
        : stat('∞', t('admin.unlimited')),
      h('div', { class: 'stat' },
        h('div', {}, h('span', { class: `badge ${event.status === 'open' ? '' : 'closed'}` }, t(`admin.state.${event.status}`))),
        h('div', { class: 'name' }, event.registrationDeadline
          ? t('admin.deadline', { date: formatShort(event.registrationDeadline, event.timeZone) })
          : t('admin.closesAtStart'))),
    ),
    sites.length > 1 && site ? h('p', { class: 'muted small' }, t('admin.site', { site: site.label })) : null,
    h('p', { class: 'muted small' },
      event.reportSentAt
        ? t('admin.reportSent', { date: formatShort(event.reportSentAt, event.timeZone) })
        : t('admin.reportPending', { date: formatShort(event.reportAt, event.timeZone) }),
      ' · ',
      t('admin.deleteDate', { date: formatShort(event.deleteAt, event.timeZone) })),
    h('div', { class: 'form-row' },
      h('span', { class: 'label' }, t('admin.link')),
      h('div', { class: 'linkbox' }, field, copy,
        h('a', { class: 'btn secondary small', href: url, target: '_blank', rel: 'noopener' }, t('common.open')))),
    h('div', { class: 'actions' }, toggle),
  );
}

// Antall påmeldinger (grupper). Én påmelding kan gjelde flere personer.
function bookingsStat() {
  const n = new Set(registrations.map((r) => r.bookingId)).size;
  return stat(n, t('admin.bookings', { count: n }));
}

function stat(value, name) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'name' }, name));
}

function guestsCard() {
  const csv = h('button', { class: 'btn secondary small', type: 'button', disabled: !registrations.length }, t('admin.csv'));
  csv.addEventListener('click', downloadCsv);

  const emails = h('button', { class: 'btn secondary small', type: 'button', disabled: !registrations.length }, t('admin.copyEmails'));
  // Både e-postene til den som meldte på og eventuelle e-poster til personer som ble lagt til.
  const allEmails = [...new Set(registrations.flatMap((r) => [r.contactEmail, r.email]).filter(Boolean))];
  emails.addEventListener('click', () => copyToClipboard(allEmails.join(', '), emails));

  const table = registrations.length
    ? h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, t('admin.columnName')), h('th', {}, t('admin.columnEmail')),
          event.fields.map((f) => h('th', {}, f.label)),
          h('th', {}, t('admin.columnRegistered')),
          event.features.tickets ? h('th', {}, t('admin.columnCheckin')) : null,
          h('th', {}))),
        h('tbody', {}, registrations.map((r, i) => h('tr', { class: r.position > 0 ? 'added' : '' },
          h('td', { class: 'num' }, i + 1),
          // Personer som er lagt til av en annen, vises rett under og litt innrykket med «meldt på av».
          h('td', {}, r.name,
            r.position > 0 ? h('span', { class: 'by' }, t('admin.addedBy', { name: r.contactName })) : null,
            r.late ? h('span', { class: 'by late' }, t('admin.lateTag')) : null,
            r.doorCode ? h('span', { class: 'by' }, t('admin.doorCode', { code: r.doorCode })) : null,
            r.ticketUrl ? h('a', { class: 'by', href: r.ticketUrl, target: '_blank', rel: 'noopener' }, t('admin.ticket')) : null),
          h('td', {}, r.email ? h('a', { href: `mailto:${r.email}` }, r.email) : h('span', { class: 'muted' }, '–')),
          event.fields.map((f) => h('td', { class: 'answer' }, formatAnswer(f, r.answers))),
          h('td', { class: 'small muted' }, formatShort(r.createdAt, event.timeZone)),
          event.features.tickets ? h('td', { class: 'small' }, checkinCell(r)) : null,
          h('td', {}, h('button', { class: 'btn danger small', type: 'button', onclick: () => removeGuest(r) }, t('common.remove'))),
        )))))
    : h('p', { class: 'muted' }, t('admin.noGuests'));

  return h('section', { class: 'card' },
    h('h2', {}, t('admin.guestsHeading', { count: registrations.length })),
    h('div', { class: 'actions' }, csv, emails),
    table,
  );
}

// Innsjekking fra listen: tidspunkt og «Angre», eller en knapp for å sjekke inn.
function checkinCell(registration) {
  const toggle = async (undo) => {
    try {
      await api(`/admin/events/${slug}/registrations/${registration.id}/checkin`, { method: undo ? 'DELETE' : 'POST', headers: auth });
      await load();
    } catch (err) {
      alert(err.message);
    }
  };
  if (!registration.checkedInAt) {
    return h('button', { class: 'btn secondary small', type: 'button', onclick: () => toggle(false) }, t('admin.checkIn'));
  }
  return [
    h('span', {}, formatShort(registration.checkedInAt, event.timeZone)),
    registration.checkedInBy ? h('span', { class: 'by' }, registration.checkedInBy) : null,
    h('button', { class: 'btn secondary small', type: 'button', onclick: () => toggle(true) }, t('admin.undoCheckIn')),
  ];
}

// Dørvaktlenken: kopier, åpne, eller lag en ny (den gamle og alle innlogginger slutter da å virke).
function scannerCard() {
  const field = h('input', { type: 'text', value: event.scannerUrl, readOnly: true, 'aria-label': t('admin.scannerHeading') });
  field.addEventListener('focus', () => field.select());
  const copy = h('button', { class: 'btn secondary small', type: 'button' }, t('common.copy'));
  copy.addEventListener('click', () => copyToClipboard(event.scannerUrl, copy));
  const rotate = h('button', { class: 'btn danger small', type: 'button' }, t('admin.scannerRotate'));
  rotate.addEventListener('click', async () => {
    if (!confirm(t('admin.scannerRotateConfirm'))) return;
    try {
      const { scannerUrl } = await api(`/admin/events/${slug}/scanner/rotate`, { method: 'POST', headers: auth });
      event.scannerUrl = scannerUrl;
      flash = notice('success', t('admin.scannerRotated'));
      render();
    } catch (err) {
      alert(err.message);
    }
  });
  return h('section', { class: 'card' },
    h('h2', {}, t('admin.scannerHeading')),
    h('div', { class: 'linkbox' }, field, copy,
      h('a', { class: 'btn secondary small', href: event.scannerUrl, target: '_blank', rel: 'noopener' }, t('common.open'))),
    h('div', { class: 'actions' }, rotate));
}

// Avlys arrangementet, med valgfri melding til de påmeldte. Kan oppheves.
function cancelCard() {
  if (event.cancelledAt) {
    const undo = h('button', { class: 'btn secondary', type: 'button' }, t('admin.uncancelButton'));
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        ({ event } = await api(`/admin/events/${slug}/cancel`, { method: 'DELETE', headers: auth }));
        flash = notice('success', t('admin.uncancelDone'));
        render();
      } catch (err) {
        undo.disabled = false;
        alert(err.message);
      }
    });
    return h('section', { class: 'card', id: 'cancel-card' },
      h('h3', {}, t('admin.cancelHeading')),
      event.cancelMessage ? h('blockquote', { class: 'cancel-message' }, event.cancelMessage) : null,
      h('div', { class: 'actions' }, undo));
  }
  const status = h('div');
  const message = h('textarea', { id: 'cancel-message', maxLength: 2000, rows: 4 });
  const notify = h('input', { type: 'checkbox', checked: registrations.length > 0 });
  const button = h('button', { class: 'btn danger', type: 'button' }, t('admin.cancelButton'));
  button.addEventListener('click', async () => {
    if (!confirm(t('admin.cancelConfirm', { title: event.title }))) return;
    button.disabled = true;
    try {
      const result = await api(`/admin/events/${slug}/cancel`, {
        method: 'POST', headers: auth, body: { notify: notify.checked, message: message.value },
      });
      event = result.event;
      flash = notice('success', result.notified ? t('admin.cancelDone', { count: result.notified }) : t('admin.cancelDoneSilent'));
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      status.replaceChildren(notice('error', err.message));
      button.disabled = false;
    }
  });
  return h('details', { class: 'card section', id: 'cancel-card' },
    h('summary', {}, t('admin.cancelHeading')),
    status,
    h('div', { class: 'form-row', 'data-error-for': 'cancelMessage' }, h('label', { for: 'cancel-message' }, t('admin.cancelMessage')), message),
    h('div', { class: 'form-row' }, h('label', { class: 'checkbox' }, notify, h('span', {}, t('admin.cancelNotify')))),
    h('div', { class: 'actions' }, button));
}

async function removeGuest(registration) {
  if (!confirm(t('admin.removeConfirm', { name: registration.name }))) return;
  try {
    await api(`/admin/events/${slug}/registrations/${registration.id}`, { method: 'DELETE', headers: auth });
    flash = notice('success', t('admin.removed', { name: registration.name }));
    await load();
  } catch (err) {
    alert(err.message);
  }
}

async function downloadCsv() {
  const res = await fetch(`/api/admin/events/${slug}/registrations.csv`, { headers: auth });
  if (!res.ok) return alert(t('admin.downloadFailed'));
  // Filnavnet kommer fra serveren (Content-Disposition), på admin-språket.
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `${slug}.csv`;
  const url = URL.createObjectURL(await res.blob());
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function editCard() {
  const { form } = createEventForm({
    initial: event,
    timeZone: event.timeZone,
    sites,
    wallets,
    skins,
    editing: true,
    submitLabel: t('admin.save'),
    onSubmit: (payload, extras) => save(payload, t('admin.saved'), extras.image),
  });
  return h('details', { class: 'card section' }, h('summary', {}, t('admin.edit')), form);
}

function dangerCard() {
  const button = h('button', { class: 'btn danger', type: 'button' }, t('admin.deleteButton'));
  button.addEventListener('click', async () => {
    const word = t('admin.deleteWord');
    const answer = prompt(t('admin.deletePrompt', { count: event.count, word }));
    if (answer?.trim().toUpperCase() !== word) return;
    try {
      await api(`/admin/events/${slug}`, { method: 'DELETE', headers: auth });
      app.replaceChildren(h('h1', {}, t('admin.deletedTitle')), h('p', {}, t('admin.deletedText')));
    } catch (err) {
      alert(err.message);
    }
  });
  return h('section', { class: 'card' },
    h('h3', {}, t('admin.deleteHeading')),
    button);
}

load();

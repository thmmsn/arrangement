import {
  api, clearFieldErrors, formatDay, formatEventTime, formatShort, h, linkify, nameList, notice, showFieldErrors, slugFromPath, t,
} from './common.js';

const app = document.getElementById('app');
const hero = document.getElementById('hero');
const slug = slugFromPath();
const REFRESH_MS = 30_000;

let event;

async function load() {
  try {
    event = await api(`/events/${slug}`);
  } catch (err) {
    app.replaceChildren(h('h1', {}, t('event.notFound')), h('p', {}, err.message));
    return;
  }
  document.title = event.title;
  render();
  // Oppdater antall påmeldte jevnlig, så siden holder seg fersk om den står åpen.
  setInterval(refreshAttendance, REFRESH_MS);
}

function render() {
  const tz = event.timeZone;
  hero.replaceChildren(...(event.imageUrl ? [heroImage(event.imageUrl)] : []));
  // replaceChildren skriver «null» som tekst, så valgfrie deler som mangler filtreres bort.
  app.replaceChildren(...[
    h('p', { class: 'kicker' }, formatDay(event.startsAt, tz)),
    h('h1', {}, event.title),
    h('dl', { class: 'meta' },
      h('dt', {}, t('event.when')), h('dd', {}, formatEventTime(event.startsAt, event.endsAt, tz)),
      event.location ? [h('dt', {}, t('event.where')), h('dd', {}, event.location, ' ', directionsLink())] : null,
      h('dt', {}, t('event.organizer')), h('dd', {}, event.organizerName),
      event.registrationDeadline
        ? [h('dt', {}, t('event.deadline')), h('dd', {}, t('event.deadlineText', { date: formatShort(event.registrationDeadline, tz) }))]
        : null,
    ),
    h('div', { id: 'attendance' }, attendance()),
    event.description ? h('div', { class: 'description' }, linkify(event.description)) : null,
    h('section', { class: 'card', id: 'registration' }, registrationSection()),
  ].filter(Boolean));
}

/**
 * Forsidebildet står over tekstkolonnen og kan være bredere enn den. Bredden regnes ut i CSS-en fra
 * bildets format (se .hero i style.css), så formatet settes som --hero-ratio når bildet er lastet.
 * Lytterne legges til før src, så de rekker å fange opp et bilde som allerede ligger i mellomlageret.
 */
function heroImage(src) {
  return h('img', {
    class: 'hero',
    alt: '',
    onload: (e) => e.target.style.setProperty('--hero-ratio', e.target.naturalWidth / e.target.naturalHeight),
    onerror: (e) => e.target.remove(),
    src,
  });
}

/** «Veibeskrivelse»: Apple Kart på iPhone/iPad/Mac, ellers Google Maps. */
function directionsLink() {
  const { directions, appleDirections } = event.links ?? {};
  const href = (/iPhone|iPad|Macintosh/.test(navigator.userAgent) && appleDirections) || directions;
  return href ? h('a', { class: 'directions', href, target: '_blank', rel: 'noopener' }, t('links.directions')) : null;
}

function attendance() {
  const open = event.status === 'open';
  // Åpen etter fristen (etteranmelding) vises som «Etteranmelding».
  const badge = h('span', { class: `badge ${open ? '' : 'closed'}` }, t(`event.badge.${open && event.late ? 'late' : event.status}`));

  if (event.count === null) return h('div', { class: 'attendance' }, badge);

  const parts = [
    h('span', { class: 'number' }, event.count),
    h('span', { class: 'label' }, t('event.registered', { count: event.count })),
  ];
  if (event.capacity !== null) {
    parts.push(h('span', { class: 'label' }, t('event.spotsLeft', { left: event.spotsLeft, capacity: event.capacity })));
  }
  parts.push(badge);
  if (event.capacity !== null) {
    const pct = Math.min(100, Math.round((event.count / event.capacity) * 100));
    const bar = h('span');
    bar.style.width = `${pct}%`; // Via CSSOM – inline style-attributter blokkeres av Content-Security-Policy.
    parts.push(h('div', { class: 'progress', role: 'presentation' }, bar));
  }
  return h('div', { class: 'attendance' }, parts);
}

async function refreshAttendance() {
  if (document.hidden) return;
  try {
    const fresh = await api(`/events/${slug}`);
    event = { ...event, count: fresh.count, spotsLeft: fresh.spotsLeft, capacity: fresh.capacity, status: fresh.status };
    updateAttendance();
  } catch {
    // Stille: neste forsøk kommer om litt.
  }
}

// ---------- Påmeldingsskjema ----------

// Settes av skjemaet, slik at «Legg til person»-knappen oppdateres når antall ledige plasser endres.
let onEventChange = () => {};

function updateAttendance() {
  document.getElementById('attendance').replaceChildren(attendance());
  onEventChange();
}

function registrationSection() {
  if (event.status !== 'open') {
    return [h('h2', {}, t('event.headingClosed')), notice('info', t(`status.${event.status}`))];
  }
  return [h('h2', {}, t('event.headingOpen')), registrationForm()];
}

function requiredMark() {
  return h('span', { class: 'required-mark', 'aria-hidden': 'true' }, '*');
}

let uid = 0; // Gir hvert felt en unik id, slik at <label for> virker for alle personene.

// En rad i skjemaet. data-key er feltets navn («name», «email», «field_abc»); data-error-for er
// nøkkelen serveren bruker for feil, og får prefiks «guests.N.» for personer som er lagt til.
function row(key, ...children) {
  return h('div', { class: 'form-row', 'data-key': key, 'data-error-for': key }, ...children);
}

function fieldInput(field) {
  const id = `f${++uid}`;
  const common = { id, required: field.required, 'data-field': field.id };

  if (field.type === 'checkbox') {
    return row(`field_${field.id}`,
      h('label', { class: 'checkbox' },
        h('input', { type: 'checkbox', ...common }),
        h('span', {}, field.label, field.required ? requiredMark() : null)));
  }

  let input;
  switch (field.type) {
    case 'textarea':
      input = h('textarea', { ...common, maxLength: 4000 });
      break;
    case 'select':
      input = h('select', common,
        h('option', { value: '' }, t('form.selectPlaceholder')),
        field.options.map((o) => h('option', { value: o }, o)));
      break;
    case 'number':
      input = h('input', { ...common, type: 'text', inputMode: 'decimal' });
      break;
    case 'tel':
      input = h('input', { ...common, type: 'tel', autocomplete: 'off' });
      break;
    default:
      input = h('input', { ...common, type: 'text', maxLength: 1000 });
  }
  return row(`field_${field.id}`,
    h('label', { for: id }, field.label, field.required ? requiredMark() : null),
    input);
}

/**
 * Skjemadelen for én person. Kontaktpersonen (den som melder på) må ha e-post og får bekreftelsen;
 * for personer som legges til er e-post valgfritt.
 */
function personBlock({ contact, onRemove }) {
  const nameId = `f${++uid}`;
  const emailId = `f${++uid}`;
  const heading = h('h3', { class: 'person-title' });
  const remove = contact ? null : h('button', { class: 'btn danger small', type: 'button', onclick: onRemove }, t('common.remove'));

  const el = h('div', { class: contact ? 'person contact' : 'person' },
    h('div', { class: 'person-head' }, heading, remove),
    row('name',
      h('label', { for: nameId }, t('form.name'), requiredMark()),
      h('input', { id: nameId, 'data-name': true, type: 'text', autocomplete: contact ? 'name' : 'off', required: true, maxLength: 200 })),
    row('email',
      contact
        ? h('label', { for: emailId }, t('form.email'), requiredMark())
        : h('label', { for: emailId }, t('form.email')),
      h('input', { id: emailId, 'data-email': true, type: 'email', autocomplete: contact ? 'email' : 'off', required: contact, maxLength: 254 })),
    event.fields.map(fieldInput),
  );

  return {
    el,
    /** Oppdaterer overskrift og feilnøkler når personer legges til eller fjernes. */
    setIndex(index, total) {
      heading.textContent = contact ? t('form.personYou') : t('form.person', { n: index + 1 });
      el.classList.toggle('solo', contact && total === 1); // Én person trenger ingen overskrift.
      const prefix = contact ? '' : `guests.${index - 1}.`;
      el.querySelectorAll('[data-key]').forEach((r) => { r.dataset.errorFor = prefix + r.dataset.key; });
    },
    read() {
      const answers = {};
      for (const input of el.querySelectorAll('[data-field]')) {
        answers[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
      }
      return {
        name: el.querySelector('[data-name]').value,
        email: el.querySelector('[data-email]').value,
        answers,
      };
    },
    focus() {
      el.querySelector('[data-name]').focus();
    },
  };
}

function registrationForm() {
  const status = h('div');
  const submit = h('button', { class: 'btn block', type: 'submit' });
  const people = h('div', { class: 'people' });
  const addButton = h('button', { class: 'btn secondary', type: 'button' }, t('form.addPerson'));
  const addHint = h('span', { class: 'muted small' });

  const contact = personBlock({ contact: true });
  const guests = [];

  function refresh() {
    const total = 1 + guests.length;
    [contact, ...guests].forEach((person, i) => person.setIndex(i, total));
    submit.textContent = total === 1 ? t('form.submitOne') : t('form.submitMany', { count: total });

    // Grensen er det minste av «maks per påmelding» og ledige plasser (hvis antallet er kjent).
    const limit = Math.min(event.maxPerBooking, event.spotsLeft ?? Infinity);
    addButton.disabled = total >= limit;
    addHint.textContent = total < limit ? ''
      : total >= event.maxPerBooking ? t('form.addHintMax', { max: event.maxPerBooking })
        : t('form.addHintNoSpots');
  }
  onEventChange = refresh;

  function addPerson() {
    const guest = personBlock({
      contact: false,
      onRemove: () => {
        guests.splice(guests.indexOf(guest), 1);
        guest.el.remove();
        refresh();
        addButton.focus();
      },
    });
    guests.push(guest);
    people.append(guest.el);
    refresh();
    guest.focus();
  }
  addButton.addEventListener('click', addPerson);

  people.append(contact.el);
  refresh();

  const canAdd = event.maxPerBooking > 1;
  const form = h('form', { novalidate: true },
    status,
    people,
    canAdd
      ? h('div', { class: 'add-person', 'data-error-for': 'guests' },
        h('div', { class: 'actions' }, addButton, addHint))
      : null,
    // Honningkrukke mot roboter – skjult for mennesker og skjermlesere.
    h('div', { class: 'hp', 'aria-hidden': 'true' },
      h('label', { for: 'website' }, t('form.honeypot')),
      h('input', { id: 'website', name: 'website', type: 'text', tabIndex: -1, autocomplete: 'off' })),
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    status.replaceChildren();

    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = t('form.submitting');
    try {
      const result = await api(`/events/${slug}/registrations`, {
        method: 'POST',
        body: { ...contact.read(), guests: guests.map((g) => g.read()), website: form.elements.website.value },
      });
      event = { ...event, ...result.event };
      updateAttendance();
      showSuccess(result);
    } catch (err) {
      status.replaceChildren(notice('error', err.message));
      showFieldErrors(form, err.errors);
      if (err.data?.status) {
        // Arrangementet ble fullt/stengt, eller det er ikke plass til alle, mens skjemaet sto åpent.
        if (err.data.status !== 'not_enough') event.status = err.data.status;
        if (err.data.spotsLeft !== undefined) event.spotsLeft = err.data.spotsLeft;
        if (err.data.status === 'full') event.spotsLeft = event.spotsLeft === null ? null : 0;
        updateAttendance();
      }
      if (!Object.keys(err.errors).length) status.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });

  return form;
}

// Alt den som meldte på trenger, med én gang – det samme som i e-posten: billettene, Wallet, PDF,
// kalender og avmelding (etter arrangementets brytere).
function showSuccess({ booking, emailSent, links }) {
  const section = document.getElementById('registration');
  const names = booking.persons.map((p) => p.name);
  const several = names.length > 1;
  const wallets = [
    links.apple && h('a', { class: 'btn wallet-btn apple', href: links.apple }, t(several ? 'links.appleWalletAll' : 'links.appleWallet')),
    links.google && h('a', { class: 'btn wallet-btn google', href: links.google, rel: 'noopener' }, t(several ? 'links.googleWalletAll' : 'links.googleWallet')),
  ].filter(Boolean);
  const extras = [
    links.pdf && h('a', { class: 'btn secondary small', href: links.pdf, target: '_blank' }, t(several ? 'links.pdfAll' : 'links.pdf')),
    links.ics && h('a', { class: 'btn secondary small', href: links.ics }, t('links.calendar')),
    links.googleCalendar && h('a', { class: 'btn secondary small', href: links.googleCalendar, target: '_blank', rel: 'noopener' }, t('links.googleCalendar')),
  ].filter(Boolean);
  section.replaceChildren(
    h('div', { class: 'success-panel' },
      h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
      h('h2', {}, t('form.thanks', { name: booking.contactName })),
      h('p', {}, several ? t('form.registeredMany', { names: nameList(names) }) : t('form.registeredOne')),
      links.tickets
        ? h('p', {}, h('a', { class: 'btn', href: links.tickets }, several ? t('form.viewTickets') : t('form.viewTicket')))
        : null,
      wallets.length ? h('div', { class: 'actions wallet-actions' }, wallets) : null,
      extras.length ? h('div', { class: 'actions' }, extras) : null,
      emailSent
        ? h('p', { class: 'muted' }, t('form.emailSent', { email: booking.contactEmail }))
        : notice('warning', t('form.emailFailed')),
      h('div', { class: 'actions' },
        event.status === 'open'
          ? h('button', { class: 'btn secondary', type: 'button', onclick: () => section.replaceChildren(...registrationSection()) },
            t('form.newBooking'))
          : null,
        links.cancel ? h('a', { class: 'btn danger small', href: links.cancel }, t('links.cancel')) : null),
    ),
  );
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

load();

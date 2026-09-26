import { api, clearFieldErrors, formatDay, formatEventTime, formatShort, h, linkify, notice, showFieldErrors, slugFromPath } from './common.js';

const app = document.getElementById('app');
const slug = slugFromPath();
const REFRESH_MS = 30_000;

const STATUS_TEXT = {
  closed: 'Påmeldingen er stengt.',
  deadline_passed: 'Påmeldingsfristen har gått ut.',
  full: 'Arrangementet er fullt.',
};

let event;

async function load() {
  try {
    event = await api(`/events/${slug}`);
  } catch (err) {
    app.replaceChildren(h('h1', {}, 'Fant ikke arrangementet'), h('p', {}, err.message));
    return;
  }
  document.title = event.title;
  render();
  // Oppdater antall påmeldte jevnlig, så siden holder seg fersk om den står åpen.
  setInterval(refreshAttendance, REFRESH_MS);
}

function render() {
  const tz = event.timeZone;
  // replaceChildren skriver «null» som tekst, så valgfrie deler som mangler filtreres bort.
  app.replaceChildren(...[
    event.imageUrl ? h('img', { class: 'hero', src: event.imageUrl, alt: '', onerror: (e) => e.target.remove() }) : null,
    h('p', { class: 'kicker' }, formatDay(event.startsAt, tz)),
    h('h1', {}, event.title),
    h('dl', { class: 'meta' },
      h('dt', {}, 'Når'), h('dd', {}, formatEventTime(event.startsAt, event.endsAt, tz)),
      event.location ? [h('dt', {}, 'Hvor'), h('dd', {}, event.location)] : null,
      h('dt', {}, 'Arrangør'), h('dd', {}, event.organizerName),
      event.registrationDeadline
        ? [h('dt', {}, 'Frist'), h('dd', {}, `Påmelding innen ${formatShort(event.registrationDeadline, tz)}`)]
        : null,
    ),
    h('div', { id: 'attendance' }, attendance()),
    event.description ? h('div', { class: 'description' }, linkify(event.description)) : null,
    h('section', { class: 'card', id: 'registration' }, registrationSection()),
  ].filter(Boolean));
}

function attendance() {
  const open = event.status === 'open';
  const badge = h('span', { class: `badge ${open ? '' : 'closed'}` }, open ? 'Påmelding åpen' : statusLabel());

  if (event.count === null) return h('div', { class: 'attendance' }, badge);

  const parts = [
    h('span', { class: 'number' }, event.count),
    h('span', { class: 'label' }, event.count === 1 ? 'påmeldt' : 'påmeldte'),
  ];
  if (event.capacity !== null) {
    parts.push(h('span', { class: 'label' }, `· ${event.spotsLeft} av ${event.capacity} plasser ledige`));
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

function statusLabel() {
  return { closed: 'Stengt', deadline_passed: 'Frist utløpt', full: 'Fullt' }[event.status] || '';
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
    return [h('h2', {}, 'Påmelding'), notice('info', STATUS_TEXT[event.status])];
  }
  return [h('h2', {}, 'Meld deg på'), registrationForm()];
}

function requiredMark() {
  return h('span', { class: 'required-mark', 'aria-hidden': 'true' }, '*');
}

function nameList(names) {
  return new Intl.ListFormat('nb', { type: 'conjunction' }).format(names);
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
        h('option', { value: '' }, 'Velg …'),
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
  const remove = contact ? null : h('button', { class: 'btn danger small', type: 'button', onclick: onRemove }, 'Fjern');

  const el = h('div', { class: contact ? 'person contact' : 'person' },
    h('div', { class: 'person-head' }, heading, remove),
    row('name',
      h('label', { for: nameId }, 'Navn', requiredMark()),
      h('input', { id: nameId, 'data-name': true, type: 'text', autocomplete: contact ? 'name' : 'off', required: true, maxLength: 200 })),
    row('email',
      contact
        ? h('label', { for: emailId }, 'E-post', requiredMark(), h('span', { class: 'hint' }, 'Bekreftelsen sendes hit.'))
        : h('label', { for: emailId }, 'E-post', h('span', { class: 'hint' }, 'Valgfritt. Bekreftelsen for alle sendes til deg.')),
      h('input', { id: emailId, 'data-email': true, type: 'email', autocomplete: contact ? 'email' : 'off', required: contact, maxLength: 254 })),
    event.fields.map(fieldInput),
  );

  return {
    el,
    /** Oppdaterer overskrift og feilnøkler når personer legges til eller fjernes. */
    setIndex(index, total) {
      heading.textContent = contact ? 'Person 1 – deg' : `Person ${index + 1}`;
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
  const addButton = h('button', { class: 'btn secondary', type: 'button' }, '+ Legg til person');
  const addHint = h('span', { class: 'muted small' });

  const contact = personBlock({ contact: true });
  const guests = [];

  function refresh() {
    const total = 1 + guests.length;
    [contact, ...guests].forEach((person, i) => person.setIndex(i, total));
    submit.textContent = total === 1 ? 'Meld meg på' : `Meld på ${total} personer`;

    // Grensen er det minste av «maks per påmelding» og ledige plasser (hvis antallet er kjent).
    const limit = Math.min(event.maxPerBooking, event.spotsLeft ?? Infinity);
    addButton.disabled = total >= limit;
    addHint.textContent = total < limit ? ''
      : total >= event.maxPerBooking ? `Maks ${event.maxPerBooking} personer per påmelding.`
        : 'Ingen flere ledige plasser.';
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
        h('div', { class: 'actions' }, addButton, addHint),
        h('p', { class: 'muted small' }, 'Skal flere være med? Legg dem til her, så får alle plass på samme påmelding.'))
      : null,
    // Honningkrukke mot roboter – skjult for mennesker og skjermlesere.
    h('div', { class: 'hp', 'aria-hidden': 'true' },
      h('label', { for: 'website' }, 'Ikke fyll ut dette feltet'),
      h('input', { id: 'website', name: 'website', type: 'text', tabIndex: -1, autocomplete: 'off' })),
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    status.replaceChildren();

    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Melder på …';
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

function showSuccess({ booking, emailSent }) {
  const section = document.getElementById('registration');
  const names = booking.persons.map((p) => p.name);
  section.replaceChildren(
    h('div', { class: 'success-panel' },
      h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
      h('h2', {}, `Takk, ${booking.contactName}!`),
      h('p', {}, names.length > 1 ? `Dere er påmeldt: ${nameList(names)}.` : 'Du er påmeldt.'),
      emailSent
        ? h('p', { class: 'muted' }, `Vi har sendt en bekreftelse til ${booking.contactEmail}. Finner du den ikke, sjekk søppelposten.`)
        : notice('warning', 'Påmeldingen er registrert, men vi fikk ikke sendt bekreftelse på e-post. Arrangøren har likevel fått beskjed.'),
      event.status === 'open'
        ? h('button', { class: 'btn secondary', type: 'button', onclick: () => section.replaceChildren(...registrationSection()) },
          'Ny påmelding')
        : null,
    ),
  );
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

load();

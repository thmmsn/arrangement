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
  app.replaceChildren(
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
  );
  document.getElementById('footer').textContent = `Påmelding til ${event.title} · ${event.organizerName}`;
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
    document.getElementById('attendance').replaceChildren(attendance());
  } catch {
    // Stille: neste forsøk kommer om litt.
  }
}

// ---------- Påmeldingsskjema ----------

function registrationSection() {
  if (event.status !== 'open') {
    return [h('h2', {}, 'Påmelding'), notice('info', STATUS_TEXT[event.status])];
  }
  return [h('h2', {}, 'Meld deg på'), registrationForm()];
}

function requiredMark() {
  return h('span', { class: 'required-mark', 'aria-hidden': 'true' }, '*');
}

function fieldInput(field) {
  const id = `field_${field.id}`;
  const common = { id, name: field.id, required: field.required };

  if (field.type === 'checkbox') {
    return h('div', { class: 'form-row', 'data-error-for': id },
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
      input = h('input', { ...common, type: 'tel', autocomplete: 'tel' });
      break;
    default:
      input = h('input', { ...common, type: 'text', maxLength: 1000 });
  }
  return h('div', { class: 'form-row', 'data-error-for': id },
    h('label', { for: id }, field.label, field.required ? requiredMark() : null),
    input);
}

function registrationForm() {
  const status = h('div');
  const submit = h('button', { class: 'btn block', type: 'submit' }, 'Meld meg på');

  const form = h('form', { novalidate: true },
    status,
    h('div', { class: 'form-row', 'data-error-for': 'name' },
      h('label', { for: 'name' }, 'Navn', requiredMark()),
      h('input', { id: 'name', name: 'name', type: 'text', autocomplete: 'name', required: true, maxLength: 200 })),
    h('div', { class: 'form-row', 'data-error-for': 'email' },
      h('label', { for: 'email' }, 'E-post', requiredMark(),
        h('span', { class: 'hint' }, 'Bekreftelsen sendes hit.')),
      h('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true, maxLength: 254 })),
    event.fields.map(fieldInput),
    // Honningkrukke mot roboter – skjult for mennesker og skjermlesere.
    h('div', { class: 'hp', 'aria-hidden': 'true' },
      h('label', { for: 'website' }, 'Ikke fyll ut dette feltet'),
      h('input', { id: 'website', name: 'website', type: 'text', tabIndex: -1, autocomplete: 'off' })),
    h('p', { class: 'muted small' }, 'Én påmelding gjelder én person. Skal flere være med, melder du på én om gangen.'),
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    status.replaceChildren();

    const data = new FormData(form);
    const answers = {};
    for (const field of event.fields) {
      answers[field.id] = field.type === 'checkbox' ? form.elements[field.id].checked : data.get(field.id) || '';
    }

    submit.disabled = true;
    submit.textContent = 'Melder på …';
    try {
      const result = await api(`/events/${slug}/registrations`, {
        method: 'POST',
        body: { name: data.get('name'), email: data.get('email'), website: data.get('website'), answers },
      });
      event = { ...event, ...result.event };
      document.getElementById('attendance').replaceChildren(attendance());
      showSuccess(result);
    } catch (err) {
      status.replaceChildren(notice('error', err.message));
      showFieldErrors(form, err.errors);
      if (err.data?.status) {
        // Arrangementet ble fullt/stengt mens skjemaet sto åpent.
        event.status = err.data.status;
        document.getElementById('attendance').replaceChildren(attendance());
      }
      if (!Object.keys(err.errors).length) status.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      submit.disabled = false;
      submit.textContent = 'Meld meg på';
    }
  });

  return form;
}

function showSuccess({ registration, emailSent }) {
  const section = document.getElementById('registration');
  section.replaceChildren(
    h('div', { class: 'success-panel' },
      h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
      h('h2', {}, `Takk, ${registration.name}!`),
      h('p', {}, 'Du er påmeldt.'),
      emailSent
        ? h('p', { class: 'muted' }, `Vi har sendt en bekreftelse til ${registration.email}. Finner du den ikke, sjekk søppelposten.`)
        : notice('warning', 'Påmeldingen er registrert, men vi fikk ikke sendt bekreftelse på e-post. Arrangøren har likevel fått beskjed.'),
      event.status === 'open'
        ? h('button', { class: 'btn secondary', type: 'button', onclick: () => section.replaceChildren(...registrationSection()) },
          'Meld på en person til')
        : null,
    ),
  );
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

load();

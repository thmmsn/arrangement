// Skjema for å opprette og redigere et arrangement, inkludert byggeren for egendefinerte felter.
// Brukes både av /ny og av admin-siden.
import { clearFieldErrors, fromLocalInput, h, notice, showFieldErrors, toLocalInput } from './common.js';

const FIELD_TYPES = {
  text: 'Kort tekst',
  textarea: 'Lang tekst',
  tel: 'Telefonnummer',
  number: 'Tall',
  select: 'Nedtrekksliste',
  checkbox: 'Avkrysning (ja/nei)',
};

const PRESETS = [
  { button: 'Telefon', label: 'Telefon', type: 'tel', required: false },
  { button: 'Allergier', label: 'Allergier / matbehov', type: 'textarea', required: false },
  { button: 'Samtykke', label: 'Jeg samtykker til at bilder fra arrangementet kan brukes', type: 'checkbox', required: false },
];

/**
 * @param {object} opts
 * @param {object} [opts.initial]      Eksisterende arrangement (ved redigering)
 * @param {string} opts.submitLabel    Tekst på lagreknappen
 * @param {string} opts.timeZone      Tidssonen tidspunktene tolkes i
 * @param {boolean} [opts.editing]     Viser «påmelding åpen»-bryteren
 * @param {Node[]} [opts.prepend]      Ekstra elementer øverst i skjemaet (f.eks. passordfelt)
 * @param {(payload: object) => Promise<void>} opts.onSubmit
 */
export function createEventForm({ initial = {}, timeZone, submitLabel, editing = false, prepend = [], onSubmit }) {
  // Kopier feltene så endringer ikke lekker ut før skjemaet lagres.
  let fields = (initial.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] }));

  const row = (name, label, input, hint) =>
    h('div', { class: 'form-row', 'data-error-for': name },
      h('label', { for: name }, label, hint ? h('span', { class: 'hint' }, hint) : null),
      input);

  const input = (name, attrs = {}) => h('input', { id: name, name, type: 'text', ...attrs });

  const description = h('textarea', { id: 'description', name: 'description', maxLength: 10000, rows: 6 });
  description.value = initial.description || '';

  const fieldList = h('div', { class: 'field-list' });
  const status = h('div');
  const submit = h('button', { class: 'btn', type: 'submit' }, submitLabel);

  const form = h('form', { novalidate: true },
    status,
    ...prepend,
    h('fieldset', {},
      h('legend', {}, 'Om arrangementet'),
      row('title', 'Tittel *', input('title', { value: initial.title || '', maxLength: 200, required: true })),
      row('description', 'Beskrivelse', description, 'Linjeskift beholdes, og nettadresser blir klikkbare.'),
      row('location', 'Sted', input('location', { value: initial.location || '', maxLength: 300 })),
      h('div', { class: 'form-grid' },
        row('startsAt', 'Starter *', input('startsAt', { type: 'datetime-local', value: toLocalInput(initial.startsAt, timeZone), required: true })),
        row('endsAt', 'Slutter', input('endsAt', { type: 'datetime-local', value: toLocalInput(initial.endsAt, timeZone) })),
      ),
      h('p', { class: 'muted small' }, `Alle tidspunkter gjelder tidssonen ${timeZone}.`),
      row('imageUrl', 'Forsidebilde (valgfritt)',
        input('imageUrl', { type: 'url', value: initial.imageUrl || '', placeholder: 'https://…' }),
        'Lenke til et bilde som ligger på nett, f.eks. på nettsiden deres.'),
    ),
    h('fieldset', {},
      h('legend', {}, 'Påmelding'),
      h('div', { class: 'form-grid' },
        row('capacity', 'Antall plasser',
          input('capacity', { type: 'number', min: 1, value: initial.capacity ?? '', placeholder: 'Ubegrenset' }),
          'La stå tomt for ubegrenset.'),
        row('maxPerBooking', 'Maks personer per påmelding',
          input('maxPerBooking', { type: 'number', min: 1, max: 50, value: initial.maxPerBooking ?? 10 }),
          'Hvor mange den som melder på kan ta med seg (inkludert seg selv). 1 = bare seg selv.'),
        row('registrationDeadline', 'Påmeldingsfrist',
          input('registrationDeadline', { type: 'datetime-local', value: toLocalInput(initial.registrationDeadline, timeZone) }),
          'Tom = påmeldingen stenger når arrangementet starter.'),
      ),
      h('div', { class: 'form-row' },
        h('label', { class: 'checkbox' },
          h('input', { type: 'checkbox', name: 'showCount', checked: initial.showCount ?? true }),
          h('span', {}, 'Vis antall påmeldte på arrangementssiden'))),
      editing
        ? h('div', { class: 'form-row' },
          h('label', { class: 'checkbox' },
            h('input', { type: 'checkbox', name: 'isOpen', checked: initial.isOpen ?? true }),
            h('span', {}, 'Påmeldingen er åpen', h('span', { class: 'hint' }, 'Fjern avkrysningen for å stenge påmeldingen manuelt.'))))
        : null,
    ),
    h('fieldset', {},
      h('legend', {}, 'Arrangør'),
      h('div', { class: 'form-grid' },
        row('organizerName', 'Navn *', input('organizerName', { value: initial.organizerName || '', maxLength: 200, required: true })),
        row('organizerEmail', 'E-post *',
          input('organizerEmail', { type: 'email', value: initial.organizerEmail || '', required: true }),
          'Får varsel om hver påmelding. Gjester som svarer på bekreftelsen, havner her.'),
      ),
    ),
    h('fieldset', { 'data-error-for': 'fields' },
      h('legend', {}, 'Påmeldingsskjema'),
      h('p', { class: 'muted small' }, 'Navn og e-post er alltid med. Legg til de feltene du trenger i tillegg.'),
      fieldList,
      h('div', { class: 'actions' },
        h('button', { class: 'btn secondary small', type: 'button', onclick: () => addField({ label: '', type: 'text', required: false }) }, '+ Nytt felt'),
        PRESETS.map(({ button, ...preset }) =>
          h('button', { class: 'btn secondary small', type: 'button', onclick: () => addField(preset) }, `+ ${button}`)),
      ),
    ),
    h('div', { class: 'actions' }, submit),
  );

  function addField(field) {
    fields.push({ options: [], ...field }); // Nye felter får id på serveren.
    renderFields();
    fieldList.lastElementChild?.querySelector('input')?.focus();
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    [fields[index], fields[target]] = [fields[target], fields[index]];
    renderFields();
  }

  function renderFields() {
    fieldList.replaceChildren(...fields.map((field, index) => {
      const label = h('input', { type: 'text', value: field.label, placeholder: 'Feltnavn, f.eks. «Allergier»', 'aria-label': 'Feltnavn', maxLength: 200 });
      label.addEventListener('input', () => { field.label = label.value; });

      const type = h('select', { 'aria-label': 'Felttype' },
        Object.entries(FIELD_TYPES).map(([value, text]) => h('option', { value }, text)));
      type.value = field.type;

      const options = h('textarea', { placeholder: 'Ett valg per linje', 'aria-label': 'Valg i listen' });
      options.value = (field.options || []).join('\n');
      options.hidden = field.type !== 'select';
      options.addEventListener('input', () => { field.options = options.value.split('\n'); });

      type.addEventListener('change', () => {
        field.type = type.value;
        options.hidden = field.type !== 'select';
      });

      const required = h('input', { type: 'checkbox', checked: field.required });
      required.addEventListener('change', () => { field.required = required.checked; });

      return h('div', { class: 'field-item' },
        h('div', { class: 'row' }, label, type),
        options,
        h('div', { class: 'controls' },
          h('label', { class: 'checkbox small' }, required, h('span', {}, 'Påkrevd')),
          h('button', { class: 'btn secondary small', type: 'button', title: 'Flytt opp', 'aria-label': 'Flytt opp', disabled: index === 0, onclick: () => move(index, -1) }, '↑'),
          h('button', { class: 'btn secondary small', type: 'button', title: 'Flytt ned', 'aria-label': 'Flytt ned', disabled: index === fields.length - 1, onclick: () => move(index, 1) }, '↓'),
          h('button', { class: 'btn danger small', type: 'button', onclick: () => { fields.splice(index, 1); renderFields(); } }, 'Fjern'),
        ),
      );
    }));
  }
  renderFields();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    status.replaceChildren();

    const el = form.elements;
    const payload = {
      title: el.title.value,
      description: description.value,
      location: el.location.value,
      startsAt: fromLocalInput(el.startsAt.value, timeZone),
      endsAt: fromLocalInput(el.endsAt.value, timeZone),
      registrationDeadline: fromLocalInput(el.registrationDeadline.value, timeZone),
      capacity: el.capacity.value === '' ? null : Number(el.capacity.value),
      maxPerBooking: el.maxPerBooking.value === '' ? null : Number(el.maxPerBooking.value),
      imageUrl: el.imageUrl.value,
      showCount: el.showCount.checked,
      isOpen: editing ? el.isOpen.checked : true,
      organizerName: el.organizerName.value,
      organizerEmail: el.organizerEmail.value,
      fields: fields.map((f) => ({ ...f, options: f.type === 'select' ? f.options.map((o) => o.trim()).filter(Boolean) : undefined })),
    };

    submit.disabled = true;
    try {
      await onSubmit(payload);
    } catch (err) {
      status.replaceChildren(notice('error', err.message));
      showFieldErrors(form, err.errors);
      if (!Object.keys(err.errors || {}).length) status.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      submit.disabled = false;
    }
  });

  return { form, status };
}

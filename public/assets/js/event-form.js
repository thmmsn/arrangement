// Skjema for å opprette og redigere et arrangement, inkludert byggeren for egendefinerte felter.
// Brukes både av /admin/ny og av admin-siden for ett arrangement.
import { translator } from '../i18n/index.js';
import { clearFieldErrors, fromLocalInput, h, notice, showFieldErrors, t, toLocalInput } from './common.js';

const FIELD_TYPES = ['text', 'textarea', 'tel', 'number', 'select', 'checkbox'];
const PRESETS = [
  { key: 'phone', type: 'tel' },
  { key: 'allergies', type: 'textarea' },
  { key: 'consent', type: 'checkbox' },
];

/**
 * @param {object} opts
 * @param {object} [opts.initial]      Eksisterende arrangement (ved redigering)
 * @param {string} opts.submitLabel    Tekst på lagreknappen
 * @param {string} opts.timeZone       Tidssonen tidspunktene tolkes i
 * @param {{id: string, label: string, lang: string}[]} opts.sites  Nettstedene som kan velges
 * @param {boolean} [opts.editing]     Viser «påmelding åpen»-bryteren
 * @param {Node[]} [opts.prepend]      Ekstra elementer øverst i skjemaet (f.eks. passordfelt)
 * @param {(payload: object) => Promise<void>} opts.onSubmit
 */
export function createEventForm({ initial = {}, timeZone, sites = [], submitLabel, editing = false, prepend = [], onSubmit }) {
  // Kopier feltene så endringer ikke lekker ut før skjemaet lagres.
  let fields = (initial.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] }));

  const row = (name, label, input, hint) =>
    h('div', { class: 'form-row', 'data-error-for': name },
      h('label', { for: name }, label, hint ? h('span', { class: 'hint' }, hint) : null),
      input);

  const required = (label) => `${label} *`;
  const input = (name, attrs = {}) => h('input', { id: name, name, type: 'text', ...attrs });

  const description = h('textarea', { id: 'description', name: 'description', maxLength: 10000, rows: 6 });
  description.value = initial.description || '';

  // Nettstedet bestemmer domene, språk og utseende. Med bare ett nettsted er det ingenting å velge.
  const site = h('select', { id: 'site', name: 'site' }, sites.map((s) => h('option', { value: s.id }, s.label)));
  site.value = sites.some((s) => s.id === initial.site) ? initial.site : sites[0]?.id ?? '';
  const siteLang = () => sites.find((s) => s.id === site.value)?.lang ?? t.lang;

  const fieldList = h('div', { class: 'field-list' });
  const status = h('div');
  const submit = h('button', { class: 'btn', type: 'submit' }, submitLabel);

  // De ferdige feltene får etikett på språket til nettstedet arrangementet hører til.
  const presetButtons = PRESETS.map((preset) => {
    const button = h('button', { class: 'btn secondary small', type: 'button' });
    button.addEventListener('click', () => {
      const text = translator(siteLang()).raw(`eventForm.presets.${preset.key}`);
      addField({ label: text.label, type: preset.type, required: false });
    });
    return { preset, button };
  });
  const updatePresetButtons = () => {
    for (const { preset, button } of presetButtons) {
      button.textContent = `+ ${translator(siteLang()).raw(`eventForm.presets.${preset.key}`).button}`;
    }
  };
  site.addEventListener('change', updatePresetButtons);
  updatePresetButtons();

  const form = h('form', { novalidate: true },
    status,
    ...prepend,
    h('fieldset', {},
      h('legend', {}, t('eventForm.legendAbout')),
      sites.length > 1 ? row('site', t('eventForm.site'), site, t('eventForm.siteHint')) : null,
      row('title', required(t('eventForm.title')), input('title', { value: initial.title || '', maxLength: 200, required: true })),
      row('description', t('eventForm.description'), description, t('eventForm.descriptionHint')),
      row('location', t('eventForm.location'), input('location', { value: initial.location || '', maxLength: 300 })),
      h('div', { class: 'form-grid' },
        row('startsAt', required(t('eventForm.startsAt')),
          input('startsAt', { type: 'datetime-local', value: toLocalInput(initial.startsAt, timeZone), required: true })),
        row('endsAt', t('eventForm.endsAt'), input('endsAt', { type: 'datetime-local', value: toLocalInput(initial.endsAt, timeZone) })),
      ),
      h('p', { class: 'muted small' }, t('eventForm.timeZoneNote', { timeZone })),
      row('imageUrl', t('eventForm.imageUrl'),
        input('imageUrl', { type: 'url', value: initial.imageUrl || '', placeholder: 'https://…' }),
        t('eventForm.imageUrlHint')),
    ),
    h('fieldset', {},
      h('legend', {}, t('eventForm.legendRegistration')),
      h('div', { class: 'form-grid' },
        row('capacity', t('eventForm.capacity'),
          input('capacity', { type: 'number', min: 1, value: initial.capacity ?? '', placeholder: t('eventForm.capacityPlaceholder') }),
          t('eventForm.capacityHint')),
        row('maxPerBooking', t('eventForm.maxPerBooking'),
          input('maxPerBooking', { type: 'number', min: 1, max: 50, value: initial.maxPerBooking ?? 10 }),
          t('eventForm.maxPerBookingHint')),
        row('registrationDeadline', t('eventForm.deadline'),
          input('registrationDeadline', { type: 'datetime-local', value: toLocalInput(initial.registrationDeadline, timeZone) }),
          t('eventForm.deadlineHint')),
      ),
      h('div', { class: 'form-row' },
        h('label', { class: 'checkbox' },
          h('input', { type: 'checkbox', name: 'showCount', checked: initial.showCount ?? true }),
          h('span', {}, t('eventForm.showCount')))),
      editing
        ? h('div', { class: 'form-row' },
          h('label', { class: 'checkbox' },
            h('input', { type: 'checkbox', name: 'isOpen', checked: initial.isOpen ?? true }),
            h('span', {}, t('eventForm.isOpen'), h('span', { class: 'hint' }, t('eventForm.isOpenHint')))))
        : null,
    ),
    h('fieldset', {},
      h('legend', {}, t('eventForm.legendOrganizer')),
      h('div', { class: 'form-grid' },
        row('organizerName', required(t('eventForm.organizerName')),
          input('organizerName', { value: initial.organizerName || '', maxLength: 200, required: true })),
        row('organizerEmail', required(t('eventForm.organizerEmail')),
          input('organizerEmail', { type: 'email', value: initial.organizerEmail || '', required: true }),
          t('eventForm.organizerEmailHint')),
      ),
    ),
    h('fieldset', { 'data-error-for': 'fields' },
      h('legend', {}, t('eventForm.legendForm')),
      h('p', { class: 'muted small' }, t('eventForm.formIntro')),
      fieldList,
      h('div', { class: 'actions' },
        h('button', { class: 'btn secondary small', type: 'button', onclick: () => addField({ label: '', type: 'text', required: false }) },
          t('eventForm.newField')),
        presetButtons.map(({ button }) => button),
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
      const label = h('input', {
        type: 'text', value: field.label, placeholder: t('eventForm.fieldLabelPlaceholder'), 'aria-label': t('eventForm.fieldLabelAria'), maxLength: 200,
      });
      label.addEventListener('input', () => { field.label = label.value; });

      const type = h('select', { 'aria-label': t('eventForm.fieldTypeAria') },
        FIELD_TYPES.map((value) => h('option', { value }, t(`eventForm.types.${value}`))));
      type.value = field.type;

      const options = h('textarea', { placeholder: t('eventForm.optionsPlaceholder'), 'aria-label': t('eventForm.optionsAria') });
      options.value = (field.options || []).join('\n');
      options.hidden = field.type !== 'select';
      options.addEventListener('input', () => { field.options = options.value.split('\n'); });

      type.addEventListener('change', () => {
        field.type = type.value;
        options.hidden = field.type !== 'select';
      });

      const requiredBox = h('input', { type: 'checkbox', checked: field.required });
      requiredBox.addEventListener('change', () => { field.required = requiredBox.checked; });

      return h('div', { class: 'field-item' },
        h('div', { class: 'row' }, label, type),
        options,
        h('div', { class: 'controls' },
          h('label', { class: 'checkbox small' }, requiredBox, h('span', {}, t('eventForm.required'))),
          h('button', {
            class: 'btn secondary small', type: 'button', title: t('eventForm.moveUp'), 'aria-label': t('eventForm.moveUp'),
            disabled: index === 0, onclick: () => move(index, -1),
          }, '↑'),
          h('button', {
            class: 'btn secondary small', type: 'button', title: t('eventForm.moveDown'), 'aria-label': t('eventForm.moveDown'),
            disabled: index === fields.length - 1, onclick: () => move(index, 1),
          }, '↓'),
          h('button', { class: 'btn danger small', type: 'button', onclick: () => { fields.splice(index, 1); renderFields(); } },
            t('common.remove')),
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
      site: site.value || undefined,
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

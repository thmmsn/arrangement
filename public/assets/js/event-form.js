// Skjema for å opprette og redigere et arrangement, inkludert byggeren for egendefinerte felter.
// Brukes både av /admin/ny og av admin-siden for ett arrangement.
import { translator } from '../i18n/index.js';
import { api, clearFieldErrors, fromLocalInput, h, notice, showFieldErrors, t, toLocalInput } from './common.js';

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
 * @param {{apple: boolean, google: boolean}} [opts.wallets]  Wallet-tjenestene som er satt opp på serveren
 * @param {{id: string, name: string, preview: string[]}[]} [opts.skins]  Utseender å velge mellom
 * @param {(payload: object) => Promise<void>} opts.onSubmit
 */
export function createEventForm({
  initial = {}, timeZone, sites = [], submitLabel, editing = false, wallets = {}, skins = [], onSubmit,
}) {
  // Kopier feltene så endringer ikke lekker ut før skjemaet lagres.
  let fields = (initial.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] }));

  const row = (name, label, input) =>
    h('div', { class: 'form-row', 'data-error-for': name },
      h('label', { for: name }, label),
      input);

  const required = (label) => `${label} *`;
  const input = (name, attrs = {}) => h('input', { id: name, name, type: 'text', ...attrs });

  const description = h('textarea', { id: 'description', name: 'description', maxLength: 10000, rows: 6 });
  description.value = initial.description || '';

  // Nettstedet bestemmer domene, språk og utseende. Med bare ett nettsted er det ingenting å velge.
  const site = h('select', { id: 'site', name: 'site' }, sites.map((s) => h('option', { value: s.id }, s.label)));
  site.value = sites.some((s) => s.id === initial.site) ? initial.site : sites[0]?.id ?? '';
  const siteLang = () => sites.find((s) => s.id === site.value)?.lang ?? t.lang;

  const place = placeField(initial);
  const image = imageField(initial);
  const features = featureToggles(initial.features ?? {}, wallets);
  const skinPicker = skinField(initial.skin ?? '', skins);

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
    h('fieldset', {},
      h('legend', {}, t('eventForm.legendAbout')),
      sites.length > 1 ? row('site', t('eventForm.site'), site) : null,
      row('title', required(t('eventForm.title')), input('title', { value: initial.title || '', maxLength: 200, required: true })),
      row('description', t('eventForm.description'), description),
      row('location', t('eventForm.location'), place.el),
      h('div', { class: 'form-grid' },
        row('startsAt', required(t('eventForm.startsAt')),
          input('startsAt', { type: 'datetime-local', value: toLocalInput(initial.startsAt, timeZone), required: true })),
        row('endsAt', t('eventForm.endsAt'), input('endsAt', { type: 'datetime-local', value: toLocalInput(initial.endsAt, timeZone) })),
      ),
      h('div', { class: 'form-row', 'data-error-for': 'imageUrl' },
        h('span', { class: 'label' }, t('eventForm.imageUrl')),
        image.el),
    ),
    h('fieldset', {},
      h('legend', {}, t('eventForm.legendRegistration')),
      h('div', { class: 'form-grid' },
        row('capacity', t('eventForm.capacity'),
          input('capacity', { type: 'number', min: 1, value: initial.capacity ?? '', placeholder: t('eventForm.capacityPlaceholder') })),
        row('maxPerBooking', t('eventForm.maxPerBooking'),
          input('maxPerBooking', { type: 'number', min: 1, max: 50, value: initial.maxPerBooking ?? 10 })),
        row('registrationDeadline', t('eventForm.deadline'),
          input('registrationDeadline', { type: 'datetime-local', value: toLocalInput(initial.registrationDeadline, timeZone) })),
      ),
      h('div', { class: 'form-row' },
        h('label', { class: 'checkbox' },
          h('input', { type: 'checkbox', name: 'showCount', checked: initial.showCount ?? true }),
          h('span', {}, t('eventForm.showCount')))),
      h('div', { class: 'form-row' },
        h('label', { class: 'checkbox' },
          h('input', { type: 'checkbox', name: 'allowLate', checked: initial.allowLate ?? false }),
          h('span', {}, t('eventForm.allowLate')))),
      features.selfCancelEl,
      editing
        ? h('div', { class: 'form-row' },
          h('label', { class: 'checkbox' },
            h('input', { type: 'checkbox', name: 'isOpen', checked: initial.isOpen ?? true }),
            h('span', {}, t('eventForm.isOpen'))))
        : null,
    ),
    h('fieldset', {},
      h('legend', {}, t('eventForm.legendTickets')),
      features.el,
    ),
    skins.length
      ? h('fieldset', { 'data-error-for': 'skin' },
        h('legend', {}, t('eventForm.legendSkin')),
        skinPicker.el)
      : null,
    h('fieldset', {},
      h('legend', {}, t('eventForm.legendOrganizer')),
      h('div', { class: 'form-grid' },
        row('organizerName', required(t('eventForm.organizerName')),
          input('organizerName', { value: initial.organizerName || '', maxLength: 200, required: true })),
        row('organizerEmail', required(t('eventForm.organizerEmail')),
          input('organizerEmail', { type: 'email', value: initial.organizerEmail || '', required: true })),
      ),
    ),
    h('fieldset', { 'data-error-for': 'fields' },
      h('legend', {}, t('eventForm.legendForm')),
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
      location: place.input.value,
      geo: place.input.value.trim() ? place.geo() : null,
      startsAt: fromLocalInput(el.startsAt.value, timeZone),
      endsAt: fromLocalInput(el.endsAt.value, timeZone),
      registrationDeadline: fromLocalInput(el.registrationDeadline.value, timeZone),
      capacity: el.capacity.value === '' ? null : Number(el.capacity.value),
      maxPerBooking: el.maxPerBooking.value === '' ? null : Number(el.maxPerBooking.value),
      imageUrl: image.url(),
      showCount: el.showCount.checked,
      isOpen: editing ? el.isOpen.checked : true,
      allowLate: el.allowLate.checked,
      features: features.read(),
      skin: skinPicker.read(),
      organizerName: el.organizerName.value,
      organizerEmail: el.organizerEmail.value,
      fields: fields.map((f) => ({ ...f, options: f.type === 'select' ? f.options.map((o) => o.trim()).filter(Boolean) : undefined })),
    };

    submit.disabled = true;
    try {
      // Bildet lastes opp for seg etter at arrangementet er lagret (det trenger arrangementets nøkkel).
      await onSubmit(payload, { image: image.read() });
      image.saved();
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

// ---------- Sted med oppslag hos Kartverket ----------

/**
 * Stedsfeltet: fritekst, eller et treff fra Kartverket (adresse, stedsnavn eller gnr/bnr). Et treff
 * gir kartpunkt, som brukes til veibeskrivelse, kalenderen og Wallet (kortet dukker opp på
 * låseskjermen nær stedet). Teksten kan endres etterpå uten at kartpunktet forsvinner.
 */
function placeField(initial) {
  let geo = initial.geo ?? null;
  let results = [];
  let active = -1;
  const input = h('input', {
    id: 'location', name: 'location', type: 'text', value: initial.location || '', maxLength: 300, autocomplete: 'off',
    placeholder: t('eventForm.locationPlaceholder'), role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
    'aria-controls': 'place-results',
  });
  const list = h('ul', { class: 'place-results', id: 'place-results', role: 'listbox', hidden: true });
  const chip = h('div', { class: 'geo-chip small' });
  const message = h('div', { class: 'small muted' });

  const renderChip = () => {
    if (!geo) return chip.replaceChildren();
    const remove = h('button', { class: 'btn secondary small', type: 'button' }, t('eventForm.geoRemove'));
    remove.addEventListener('click', () => { geo = null; renderChip(); });
    chip.replaceChildren(h('span', {}, '📍 ', t('eventForm.geoSet', { lat: geo.lat, lon: geo.lon })), remove);
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const choose = (hit) => {
    input.value = hit.label;
    geo = { lat: hit.lat, lon: hit.lon };
    close();
    renderChip();
  };
  const renderList = () => {
    list.replaceChildren(...results.map((hit, i) => {
      const item = h('li', { role: 'option', class: i === active ? 'active' : '', 'aria-selected': String(i === active) },
        h('span', {}, hit.label), hit.detail ? h('span', { class: 'muted small' }, hit.detail) : null);
      // mousedown (ikke click), så valget skjer før feltet mister fokus og listen lukkes.
      item.addEventListener('mousedown', (e) => { e.preventDefault(); choose(hit); });
      return item;
    }));
    list.hidden = !results.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };

  let timer;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    message.replaceChildren();
    const q = input.value.trim();
    if (!q) {
      geo = null;
      renderChip();
    }
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const data = await api(`/admin/places?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return; // Et nyere søk er på vei.
        results = data.results;
        active = -1;
        renderList();
        if (!results.length) message.textContent = t('eventForm.placesNone');
      } catch (err) {
        if (mine === seq) message.textContent = err.message;
      }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderList();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  renderChip();

  return { el: h('div', { class: 'place-field' }, input, list, message, chip), input, geo: () => geo };
}

// ---------- Forsidebilde: opplasting eller lenke ----------

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 2000;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Et bilde fra mobilen kan være 12 MB og 4000 piksler bredt. Er det større enn nødvendig, skaleres
 * det ned i nettleseren før opplasting (maks 2000 piksler på den lengste siden). Da forsvinner også
 * metadata som GPS-posisjon, og bildet roteres riktig. Serveren sjekker og renser uansett selv.
 */
async function prepareImage(file) {
  if (!TYPES.includes(file.type)) throw new Error(t('eventForm.imageType'));
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { /* nettleseren kan ikke lese bildet – la serveren avgjøre */ }
  if (bitmap) {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale < 1 || file.size > 1.5 * 1024 * 1024) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // JPEG forblir JPEG; PNG og WebP kan ha gjennomsiktighet og blir WebP.
      const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
      if (blob && TYPES.includes(blob.type) && blob.size < file.size) file = blob;
    }
    bitmap.close?.();
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(t('eventForm.imageTooLarge', { max: MAX_UPLOAD_BYTES / 1024 / 1024 }));
  return file;
}

/** Forhåndsvisning, «Last opp bilde», «eller lenke» og «Fjern bildet». Et opplastet bilde går foran lenken. */
function imageField(initial) {
  let upload = null; // Blob som skal lastes opp
  let removeUpload = false;
  let uploaded = initial.uploadedImage || null;
  let objectUrl = null;

  const preview = h('img', { class: 'image-preview', alt: '', hidden: true });
  preview.addEventListener('error', () => { preview.hidden = true; });
  const error = h('div');
  const file = h('input', {
    id: 'imageFile', type: 'file', accept: TYPES.join(','), class: 'visually-hidden', 'aria-describedby': 'imageHint',
  });
  const pick = h('label', { class: 'btn secondary small', for: 'imageFile' }, t('eventForm.imageUpload'));
  const url = h('input', {
    id: 'imageUrl', name: 'imageUrl', type: 'url', value: initial.imageUrl || '', placeholder: 'https://…', 'aria-describedby': 'imageHint',
  });
  // Hele bildet vises på arrangementssiden (se .hero i style.css), så arrangøren får vite hvilket format som passer.
  const hint = h('p', { id: 'imageHint', class: 'muted small image-hint' }, t('eventForm.imageHint'));
  const remove = h('button', { class: 'btn danger small', type: 'button' }, t('eventForm.imageRemove'));

  const show = () => {
    const src = upload ? objectUrl : uploaded || url.value.trim();
    preview.hidden = !src;
    if (src) preview.src = src;
    remove.hidden = !(upload || uploaded);
  };

  file.addEventListener('change', async () => {
    error.replaceChildren();
    const [chosen] = file.files;
    file.value = '';
    if (!chosen) return;
    try {
      upload = await prepareImage(chosen);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(upload);
      removeUpload = false;
      show();
    } catch (err) {
      error.replaceChildren(notice('error', err.message));
    }
  });
  remove.addEventListener('click', () => {
    if (upload) upload = null;
    else if (uploaded) {
      uploaded = null;
      removeUpload = true;
    }
    show();
  });
  url.addEventListener('input', show);
  show();

  return {
    el: h('div', { class: 'image-field' },
      preview, error,
      h('div', { class: 'actions' }, file, pick, remove),
      h('div', { class: 'image-link' }, h('span', { class: 'muted small' }, t('eventForm.imageOrLink')), url),
      hint),
    url: () => url.value,
    read: () => ({ upload, removeUpload }),
    /** Etter lagring: det som ble lastet opp, er nå det lagrede bildet. */
    saved() {
      if (upload) uploaded = objectUrl;
      upload = null;
      removeUpload = false;
    },
  };
}

// ---------- Billetter: brytere per arrangement ----------

// Alt er på som standard. PDF og Wallet er billetter, så de kan bare være på når billetter er på.
// Wallet-bryterne vises alltid, men er grået ut med en forklaring når tjenesten ikke er satt opp på
// serveren – da vet arrangøren hvorfor Wallet mangler. Den lagrede verdien beholdes.
// «Deltakerne kan melde seg av selv» hører til påmeldingen og har sin egen plass i skjemaet (selfCancelEl).
function featureToggles(initial, wallets) {
  const value = (key) => initial[key] ?? true;
  // Ikke satt opp: vises uten hake (den er ikke i bruk), men den lagrede verdien sendes uendret.
  const box = (key, label, { configured = true } = {}) => {
    const input = h('input', { type: 'checkbox', name: `feature-${key}`, checked: configured && value(key) });
    const note = configured ? null : h('span', { class: 'muted small' }, ` – ${t('eventForm.walletNotConfigured')}`);
    const el = h('div', { class: 'form-row' }, h('label', { class: 'checkbox' }, input, h('span', {}, label, note)));
    return { key, input, el, configured, read: () => (configured ? input.checked : value(key)) };
  };
  const tickets = box('tickets', t('eventForm.tickets'));
  const dependent = [
    box('pdf', t('eventForm.pdf')),
    box('appleWallet', t('eventForm.appleWallet'), { configured: Boolean(wallets.apple) }),
    box('googleWallet', t('eventForm.googleWallet'), { configured: Boolean(wallets.google) }),
  ];
  const calendar = box('calendar', t('eventForm.calendar'));
  const selfCancel = box('selfCancel', t('eventForm.selfCancel'));
  const sync = () => dependent.forEach((d) => { d.input.disabled = !d.configured || !tickets.input.checked; });
  tickets.input.addEventListener('change', sync);
  sync();
  const all = [tickets, ...dependent, calendar, selfCancel];
  return {
    el: h('div', { class: 'feature-list' }, [tickets, ...dependent, calendar].map((b) => b.el)),
    selfCancelEl: selfCancel.el,
    read: () => Object.fromEntries(all.map((b) => [b.key, b.read()])),
  };
}

// ---------- Utseende (skin) ----------

/** Et kort per skin med fargeprøver; «Standard» er nettstedets eget tema. */
function skinField(selected, skins) {
  let value = skins.some((s) => s.id === selected) ? selected : '';
  const options = [{ id: '', name: t('eventForm.skinDefault'), preview: [] }, ...skins];
  const cards = options.map((skin) => {
    const radio = h('input', { type: 'radio', name: 'skin', value: skin.id, checked: skin.id === value });
    radio.addEventListener('change', () => { value = skin.id; });
    const swatches = h('span', { class: 'skin-swatches', 'aria-hidden': 'true' },
      (skin.preview.length ? skin.preview : ['var(--bg)', 'var(--surface)', 'var(--ink)', 'var(--accent)']).map((color) => {
        const dot = h('span');
        dot.style.background = color; // Via CSSOM – style-attributter blokkeres av Content-Security-Policy.
        return dot;
      }));
    return h('label', { class: 'skin-card' }, radio, swatches, h('span', { class: 'skin-name' }, skin.name));
  });
  return { el: h('div', { class: 'skin-grid', role: 'radiogroup' }, cards), read: () => value || null };
}

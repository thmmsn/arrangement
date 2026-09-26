import { newFieldId } from './ids.js';

// Validering skjer alltid på serveren. Frontend validerer også, men det er bare for brukervennlighet –
// alt som kommer inn over nettet må regnes som upålitelig.

export const FIELD_TYPES = ['text', 'textarea', 'tel', 'number', 'select', 'checkbox'];
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;
const TEL_PATTERN = /^\+?[0-9 ()-]{5,20}$/;

export class ValidationError extends Error {
  constructor(errors) {
    super('Noen felter er ikke fylt ut riktig');
    this.errors = errors; // { feltnavn: 'melding' }
  }
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value);
}

function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------- Arrangement ----------

export function validateEvent(input) {
  const errors = {};
  const body = input && typeof input === 'object' ? input : {};

  const title = str(body.title);
  if (!title) errors.title = 'Tittel må fylles ut';
  else if (title.length > 200) errors.title = 'Tittelen kan være maks 200 tegn';

  const description = str(body.description);
  if (description.length > 10_000) errors.description = 'Beskrivelsen kan være maks 10 000 tegn';

  const location = str(body.location);
  if (location.length > 300) errors.location = 'Stedet kan være maks 300 tegn';

  const startsAt = parseDate(body.startsAt);
  if (!startsAt) errors.startsAt = 'Starttidspunkt må fylles ut';

  let endsAt = null;
  if (body.endsAt) {
    endsAt = parseDate(body.endsAt);
    if (!endsAt) errors.endsAt = 'Ugyldig sluttidspunkt';
    else if (startsAt && endsAt < startsAt) errors.endsAt = 'Sluttidspunkt kan ikke være før start';
  }

  let registrationDeadline = null;
  if (body.registrationDeadline) {
    registrationDeadline = parseDate(body.registrationDeadline);
    if (!registrationDeadline) errors.registrationDeadline = 'Ugyldig påmeldingsfrist';
  }

  let capacity = null;
  if (body.capacity !== undefined && body.capacity !== null && body.capacity !== '') {
    capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
      errors.capacity = 'Antall plasser må være et helt tall større enn 0 (eller tomt for ubegrenset)';
    }
  }

  const organizerName = str(body.organizerName);
  if (!organizerName) errors.organizerName = 'Arrangør må fylles ut';
  else if (organizerName.length > 200) errors.organizerName = 'Maks 200 tegn';

  const organizerEmail = str(body.organizerEmail);
  if (!isEmail(organizerEmail)) errors.organizerEmail = 'Gyldig e-postadresse for arrangør må fylles ut';

  let imageUrl = null;
  if (str(body.imageUrl)) {
    imageUrl = str(body.imageUrl);
    let parsed;
    try { parsed = new URL(imageUrl); } catch { /* håndteres under */ }
    if (!parsed || parsed.protocol !== 'https:' || imageUrl.length > 2000) {
      errors.imageUrl = 'Bildelenken må være en https://-adresse';
    }
  }

  const { fields, errors: fieldErrors } = validateFieldDefinitions(body.fields);
  if (fieldErrors) errors.fields = fieldErrors;

  if (Object.keys(errors).length) throw new ValidationError(errors);

  return {
    title,
    description,
    location,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt ? endsAt.toISOString() : null,
    registrationDeadline: registrationDeadline ? registrationDeadline.toISOString() : null,
    capacity,
    // Standardverdier: vis antall påmeldte, og påmeldingen er åpen.
    showCount: body.showCount === undefined ? true : Boolean(body.showCount),
    isOpen: body.isOpen === undefined ? true : Boolean(body.isOpen),
    organizerName,
    organizerEmail,
    imageUrl,
    fields,
  };
}

function validateFieldDefinitions(input) {
  if (input === undefined || input === null) return { fields: [] };
  if (!Array.isArray(input)) return { fields: [], errors: 'Feltene må være en liste' };
  if (input.length > MAX_FIELDS) return { fields: [], errors: `Maks ${MAX_FIELDS} egendefinerte felter` };

  const fields = [];
  const seenIds = new Set();

  for (const [index, raw] of input.entries()) {
    const n = index + 1;
    const field = raw && typeof raw === 'object' ? raw : {};
    const label = str(field.label);
    if (!label) return { fields: [], errors: `Felt ${n} mangler navn` };
    if (label.length > 200) return { fields: [], errors: `Navnet på felt ${n} er for langt (maks 200 tegn)` };
    if (!FIELD_TYPES.includes(field.type)) return { fields: [], errors: `Felt ${n} har ukjent type` };

    // Beholder eksisterende id ved redigering, slik at svar som allerede er gitt fortsatt hører til feltet.
    let id = typeof field.id === 'string' && FIELD_ID_PATTERN.test(field.id) ? field.id : newFieldId();
    if (seenIds.has(id)) id = newFieldId();
    seenIds.add(id);

    const clean = { id, label, type: field.type, required: Boolean(field.required) };

    if (field.type === 'select') {
      const options = (Array.isArray(field.options) ? field.options : [])
        .map(str)
        .filter(Boolean);
      const unique = [...new Set(options)];
      if (unique.length === 0) return { fields: [], errors: `Nedtrekkslisten «${label}» trenger minst ett valg` };
      if (unique.length > MAX_OPTIONS) return { fields: [], errors: `«${label}» kan ha maks ${MAX_OPTIONS} valg` };
      if (unique.some((o) => o.length > 200)) return { fields: [], errors: `Et valg i «${label}» er for langt` };
      clean.options = unique;
    }

    fields.push(clean);
  }

  return { fields };
}

// ---------- Påmelding ----------

export function validateRegistration(input, fields) {
  const errors = {};
  const body = input && typeof input === 'object' ? input : {};

  const name = str(body.name);
  if (!name) errors.name = 'Navn må fylles ut';
  else if (name.length > 200) errors.name = 'Navnet kan være maks 200 tegn';

  const email = str(body.email);
  if (!isEmail(email)) errors.email = 'Skriv inn en gyldig e-postadresse';

  const rawAnswers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const answers = {};

  // Bare felter som faktisk finnes på arrangementet tas vare på – ukjente nøkler ignoreres.
  for (const field of fields) {
    const key = `field_${field.id}`;
    const value = rawAnswers[field.id];

    if (field.type === 'checkbox') {
      const checked = value === true || value === 'true' || value === 'on';
      if (field.required && !checked) errors[key] = 'Du må krysse av her';
      answers[field.id] = checked;
      continue;
    }

    const text = typeof value === 'number' ? String(value) : str(value);
    if (!text) {
      if (field.required) errors[key] = 'Må fylles ut';
      continue;
    }

    switch (field.type) {
      case 'select':
        if (!field.options.includes(text)) errors[key] = 'Velg et av alternativene';
        break;
      case 'number':
        if (!/^-?\d+([.,]\d+)?$/.test(text)) errors[key] = 'Må være et tall';
        break;
      case 'tel':
        if (!TEL_PATTERN.test(text)) errors[key] = 'Ugyldig telefonnummer';
        break;
      case 'textarea':
        if (text.length > 4000) errors[key] = 'Maks 4000 tegn';
        break;
      default:
        if (text.length > 1000) errors[key] = 'Maks 1000 tegn';
    }
    answers[field.id] = text;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { name, email, answers };
}

// ---------- Status ----------

// Én kilde til sannhet for om påmeldingen er åpen. Brukes både av API-et og av påmeldingen selv.
export function registrationStatus(event, count, now = new Date()) {
  if (!event.isOpen) return 'closed';
  const deadline = new Date(event.registrationDeadline || event.startsAt);
  if (now >= deadline) return 'deadline_passed';
  if (event.capacity != null && count >= event.capacity) return 'full';
  return 'open';
}

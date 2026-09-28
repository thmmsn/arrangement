import { FEATURES } from './db.js';
import { newFieldId } from './ids.js';

// Validering skjer alltid på serveren. Frontend validerer også, men det er bare for brukervennlighet –
// alt som kommer inn over nettet må regnes som upålitelig.

export const FIELD_TYPES = ['text', 'textarea', 'tel', 'number', 'select', 'checkbox'];
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;
const MAX_PER_BOOKING = 50;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;
const TEL_PATTERN = /^\+?[0-9 ()-]{5,20}$/;

// Feilmeldinger er ordboksnøkler med verdier ({ key, vars }), ikke ferdig tekst. De oversettes
// først når svaret sendes, til språket for nettstedet (gjester) eller hovednettstedet (admin).
const msg = (key, vars) => ({ key, vars });

export class ValidationError extends Error {
  constructor(errors) {
    super('validation.summary');
    this.errors = errors; // { feltnavn: { key, vars } }
  }
}

/** { felt: { key, vars } } → { felt: 'oversatt tekst' } */
export function translateErrors(errors, t) {
  return Object.fromEntries(Object.entries(errors).map(([field, e]) => [field, t(`validation.${e.key}`, e.vars)]));
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

/**
 * @param {object} input
 * @param {object} [opts]
 * @param {string[]} [opts.siteIds]  Gyldige nettsteder; det første er standard når «site» mangler.
 */
export function validateEvent(input, { siteIds = ['main'], skinIds = [] } = {}) {
  const errors = {};
  const body = input && typeof input === 'object' ? input : {};

  const title = str(body.title);
  if (!title) errors.title = msg('titleRequired');
  else if (title.length > 200) errors.title = msg('titleTooLong', { max: 200 });

  const description = str(body.description);
  if (description.length > 10_000) errors.description = msg('descriptionTooLong', { max: 10_000 });

  const location = str(body.location);
  if (location.length > 300) errors.location = msg('locationTooLong', { max: 300 });

  const startsAt = parseDate(body.startsAt);
  if (!startsAt) errors.startsAt = msg('startsAtRequired');

  let endsAt = null;
  if (body.endsAt) {
    endsAt = parseDate(body.endsAt);
    if (!endsAt) errors.endsAt = msg('endsAtInvalid');
    else if (startsAt && endsAt < startsAt) errors.endsAt = msg('endsBeforeStart');
  }

  let registrationDeadline = null;
  if (body.registrationDeadline) {
    registrationDeadline = parseDate(body.registrationDeadline);
    if (!registrationDeadline) errors.registrationDeadline = msg('deadlineInvalid');
  }

  let capacity = null;
  if (body.capacity !== undefined && body.capacity !== null && body.capacity !== '') {
    capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
      errors.capacity = msg('capacityInvalid');
    }
  }

  let maxPerBooking = 10;
  if (body.maxPerBooking !== undefined && body.maxPerBooking !== null && body.maxPerBooking !== '') {
    maxPerBooking = Number(body.maxPerBooking);
    if (!Number.isInteger(maxPerBooking) || maxPerBooking < 1 || maxPerBooking > MAX_PER_BOOKING) {
      errors.maxPerBooking = msg('maxPerBookingInvalid', { max: MAX_PER_BOOKING });
    }
  }

  // Nettstedet bestemmer domene, språk og utseende for arrangementet.
  const site = str(body.site) || siteIds[0];
  if (!siteIds.includes(site)) errors.site = msg('siteUnknown');

  const organizerName = str(body.organizerName);
  if (!organizerName) errors.organizerName = msg('organizerNameRequired');
  else if (organizerName.length > 200) errors.organizerName = msg('maxChars', { max: 200 });

  const organizerEmail = str(body.organizerEmail);
  if (!isEmail(organizerEmail)) errors.organizerEmail = msg('organizerEmailRequired');

  let imageUrl = null;
  if (str(body.imageUrl)) {
    imageUrl = str(body.imageUrl);
    let parsed;
    try { parsed = new URL(imageUrl); } catch { /* håndteres under */ }
    if (!parsed || parsed.protocol !== 'https:' || imageUrl.length > 2000) {
      errors.imageUrl = msg('imageUrlHttps');
    }
  }

  const { fields, errors: fieldErrors } = validateFieldDefinitions(body.fields);
  if (fieldErrors) errors.fields = fieldErrors;

  // Kartpunkt for stedet (fra Kartverket-søket i skjemaet), eller null.
  let geo = null;
  if (body.geo !== undefined && body.geo !== null) {
    const lat = Number(body.geo?.lat);
    const lon = Number(body.geo?.lon);
    if (typeof body.geo !== 'object' || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      errors.location = msg('geoInvalid');
    } else {
      // Seks desimaler ≈ 10 cm – mer enn nok, og holder tallene korte i lenker og Wallet-kort.
      geo = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
    }
  }

  // Utseende: en av skinnene som finnes (se skins.js), eller tomt for nettstedets eget tema.
  const skin = str(body.skin) || null;
  if (skin && !skinIds.includes(skin)) errors.skin = msg('skinUnknown');

  // Brytere for billett, kalenderfil, PDF og Wallet. Alt er på når ingenting er sagt.
  const rawFeatures = body.features && typeof body.features === 'object' ? body.features : {};
  const features = Object.fromEntries(FEATURES.map((key) =>
    [key, rawFeatures[key] === undefined ? true : Boolean(rawFeatures[key])]));

  if (Object.keys(errors).length) throw new ValidationError(errors);

  return {
    title,
    description,
    location,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt ? endsAt.toISOString() : null,
    registrationDeadline: registrationDeadline ? registrationDeadline.toISOString() : null,
    capacity,
    maxPerBooking,
    site,
    // Standardverdier: vis antall påmeldte, og påmeldingen er åpen.
    showCount: body.showCount === undefined ? true : Boolean(body.showCount),
    isOpen: body.isOpen === undefined ? true : Boolean(body.isOpen),
    // Påmelding etter fristen (etteranmelding). Av som standard.
    allowLate: Boolean(body.allowLate),
    organizerName,
    organizerEmail,
    imageUrl,
    fields,
    geo,
    features,
    skin,
  };
}

function validateFieldDefinitions(input) {
  if (input === undefined || input === null) return { fields: [] };
  if (!Array.isArray(input)) return { fields: [], errors: msg('fieldsNotList') };
  if (input.length > MAX_FIELDS) return { fields: [], errors: msg('tooManyFields', { max: MAX_FIELDS }) };

  const fields = [];
  const seenIds = new Set();

  for (const [index, raw] of input.entries()) {
    const n = index + 1;
    const field = raw && typeof raw === 'object' ? raw : {};
    const label = str(field.label);
    if (!label) return { fields: [], errors: msg('fieldMissingLabel', { n }) };
    if (label.length > 200) return { fields: [], errors: msg('fieldLabelTooLong', { n, max: 200 }) };
    if (!FIELD_TYPES.includes(field.type)) return { fields: [], errors: msg('fieldUnknownType', { n }) };

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
      if (unique.length === 0) return { fields: [], errors: msg('selectNeedsOption', { label }) };
      if (unique.length > MAX_OPTIONS) return { fields: [], errors: msg('tooManyOptions', { label, max: MAX_OPTIONS }) };
      if (unique.some((o) => o.length > 200)) return { fields: [], errors: msg('optionTooLong', { label }) };
      clean.options = unique;
    }

    fields.push(clean);
  }

  return { fields };
}

// ---------- Påmelding ----------

// Validerer én person. Feilene legges i `errors` med `prefix` foran nøkkelen, slik at frontend
// kan vise dem under riktig felt: «name», «field_abc» for kontaktpersonen og «guests.0.name» osv.
// for personer som er lagt til.
function validatePerson(input, fields, errors, prefix, { emailRequired }) {
  const body = input && typeof input === 'object' ? input : {};

  const name = str(body.name);
  if (!name) errors[`${prefix}name`] = msg('nameRequired');
  else if (name.length > 200) errors[`${prefix}name`] = msg('nameTooLong', { max: 200 });

  const email = str(body.email);
  if (emailRequired ? !isEmail(email) : email && !isEmail(email)) {
    errors[`${prefix}email`] = msg('emailInvalid');
  }

  const rawAnswers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const answers = {};

  // Bare felter som faktisk finnes på arrangementet tas vare på – ukjente nøkler ignoreres.
  for (const field of fields) {
    const key = `${prefix}field_${field.id}`;
    const value = rawAnswers[field.id];

    if (field.type === 'checkbox') {
      const checked = value === true || value === 'true' || value === 'on';
      if (field.required && !checked) errors[key] = msg('mustCheck');
      answers[field.id] = checked;
      continue;
    }

    const text = typeof value === 'number' ? String(value) : str(value);
    if (!text) {
      if (field.required) errors[key] = msg('required');
      continue;
    }

    switch (field.type) {
      case 'select':
        if (!field.options.includes(text)) errors[key] = msg('chooseOption');
        break;
      case 'number':
        if (!/^-?\d+([.,]\d+)?$/.test(text)) errors[key] = msg('mustBeNumber');
        break;
      case 'tel':
        if (!TEL_PATTERN.test(text)) errors[key] = msg('invalidPhone');
        break;
      case 'textarea':
        if (text.length > 4000) errors[key] = msg('maxChars', { max: 4000 });
        break;
      default:
        if (text.length > 1000) errors[key] = msg('maxChars', { max: 1000 });
    }
    answers[field.id] = text;
  }

  return { name, email, answers };
}

/**
 * Validerer en påmelding: kontaktpersonen (name, email, answers øverst i body) pluss eventuelle
 * personer som er lagt til i `guests`. Hver person blir én gjest. Kontaktpersonen må ha e-post,
 * de andre kan ha det.
 */
export function validateBooking(input, fields, maxPerBooking = 1) {
  const errors = {};
  const body = input && typeof input === 'object' ? input : {};
  const rawGuests = Array.isArray(body.guests) ? body.guests : [];

  if (rawGuests.length + 1 > maxPerBooking) {
    errors.guests = maxPerBooking === 1
      ? msg('onlyYourself')
      : msg('maxPersons', { max: maxPerBooking });
    throw new ValidationError(errors);
  }

  const contact = validatePerson(body, fields, errors, '', { emailRequired: true });
  const guests = rawGuests.map((guest, i) => validatePerson(guest, fields, errors, `guests.${i}.`, { emailRequired: false }));

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { contact, persons: [contact, ...guests] };
}

// ---------- Status ----------

/** Påmeldingsfristen: den som er satt, ellers når arrangementet starter. */
export function deadlineOf(event) {
  return new Date(event.registrationDeadline || event.startsAt);
}

/** Er fristen passert? Da er en påmelding en etteranmelding (hvis arrangøren tillater det). */
export function isLate(event, now = new Date()) {
  return now >= deadlineOf(event);
}

// Én kilde til sannhet for om påmeldingen er åpen. Brukes både av API-et og av påmeldingen selv.
// Med etteranmelding holder påmeldingen seg åpen etter fristen, fram til arrangementet er over
// (slutttidspunktet, eller starten hvis det ikke har noe slutttidspunkt).
export function registrationStatus(event, count, now = new Date()) {
  if (event.cancelledAt) return 'cancelled';
  if (!event.isOpen) return 'closed';
  if (isLate(event, now)) {
    if (!event.allowLate || now >= new Date(event.endsAt || event.startsAt)) return 'deadline_passed';
  }
  if (event.capacity != null && count >= event.capacity) return 'full';
  return 'open';
}

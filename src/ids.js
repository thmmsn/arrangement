import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Små bokstaver og tall, uten tegn som lett forveksles (0/o, 1/l/i).
// Lenken skal kunne leses av en plakat og tastes inn uten å skille store og små bokstaver.
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SLUG_LENGTH = 12;
export const SLUG_PATTERN = /^[a-z0-9]{8,32}$/;

function randomCode(length) {
  let code = '';
  // randomInt bruker rejection sampling, så hvert tegn er uniformt fordelt (ingen modulo-skjevhet).
  for (let i = 0; i < length; i++) code += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return code;
}

export function newSlug() {
  return randomCode(SLUG_LENGTH);
}

// Billettnummer (én per person) og påmeldingsnummer: 10 tegn fra samme alfabet, 31^10 ≈ 2^49
// muligheter. Nummeret alene gir ingen tilgang – lenken til billetten har i tillegg en signatur
// (se tickets.js). Nummeret vises på billetten, så døra kan taste det inn om QR-koden ikke virker.
export const CODE_LENGTH = 10;
export const CODE_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${CODE_LENGTH}}$`);

export function newCode() {
  return randomCode(CODE_LENGTH);
}

/** «k7hq2mxpr9» → «K7HQ-2MXP-R9», lettere å lese opp og taste inn. */
export function formatCode(code) {
  return code.toUpperCase().replace(/^(.{4})(.{4})(.+)$/, '$1-$2-$3');
}

// Dørkode: 5 store bokstaver, unik innenfor arrangementet. Står stort på billetten, så dørvakten kan
// taste den inn uten å bytte mellom bokstaver og tall på tastaturet. I og O er utelatt (ligner 1 og 0).
// 24^5 ≈ 7,96 millioner koder: med 500 gjester treffer en gjettet kode en gyldig billett med
// sannsynlighet 500 / 24^5 ≈ 0,006 %, og dørvakten ser uansett navnet på skjermen.
export const DOOR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const DOOR_CODE_LENGTH = 5;
const DOOR_CODE_PATTERN = new RegExp(`^[${DOOR_ALPHABET}]{${DOOR_CODE_LENGTH}}$`);

export function newDoorCode() {
  let code = '';
  for (let i = 0; i < DOOR_CODE_LENGTH; i++) code += DOOR_ALPHABET[randomInt(DOOR_ALPHABET.length)];
  return code;
}

/**
 * «abc de» → «ABCDE», eller null hvis det ikke kan være en dørkode. Bare mellomrom og bindestrek
 * fjernes: et billettnummer med tall («K7HQ-2MXP-R9») skal aldri tolkes som en dørkode.
 */
export function parseDoorCode(input) {
  const code = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  return DOOR_CODE_PATTERN.test(code) ? code : null;
}

/** Det dørvakten taster inn («k7hq 2mxp-r9») → «k7hq2mxpr9», eller null hvis det ikke kan være et nummer. */
export function parseCode(input) {
  const code = String(input ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

// Hemmelige nøkler (admin-nøkkel og avmeldingsnøkkel). Bare SHA-256-hashen lagres i databasen,
// så en lekket databasefil gir ikke tilgang til admin-sidene.
export function newSecret(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

// Sammenligning i konstant tid, slik at svartiden ikke avslører hvor mange tegn som var riktige.
export function secretMatches(secret, expectedHash) {
  if (typeof secret !== 'string' || !secret || typeof expectedHash !== 'string') return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newFieldId() {
  return 'f' + randomBytes(4).toString('hex');
}

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

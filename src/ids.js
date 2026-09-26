import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Små bokstaver og tall, uten tegn som lett forveksles (0/o, 1/l/i).
// Lenken skal kunne leses av en plakat og tastes inn uten å skille store og små bokstaver.
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SLUG_LENGTH = 12;
export const SLUG_PATTERN = /^[a-z0-9]{8,32}$/;

export function newSlug() {
  let slug = '';
  // randomInt bruker rejection sampling, så hvert tegn er uniformt fordelt (ingen modulo-skjevhet).
  for (let i = 0; i < SLUG_LENGTH; i++) slug += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return slug;
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

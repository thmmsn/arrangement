// Versjonsnummeret til appen, vist nederst til høyre på sidene.
//
// Format: år.måned.dag.løpenummer, f.eks. 2026.9.28.1 og 2026.9.28.2 for to versjoner samme dag.
// Datoen er dagen versjonen ble laget (norsk tid), og løpenummeret starter på 1 hver dag. Tallene har
// ikke ledende nuller, så hver del sammenlignes som et tall: 2026.10.1.1 kommer etter 2026.9.30.4.
//
// Nummeret står i filen VERSION i roten av prosjektet og økes med `npm run bump` før en ny versjon
// legges på main. Det ligger i en fil – ikke i git – fordi Docker-bildet bygges uten .git-mappen.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VERSION');
export const VERSION_PATTERN = /^(\d{4})\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])\.([1-9]\d*)$/;

/** Versjonsnummeret fra VERSION, eller null hvis filen mangler eller har feil format. */
export function readVersion(file = VERSION_FILE) {
  let text;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  return VERSION_PATTERN.test(text) ? text : null;
}

/** [år, måned, dag] for `date` i tidssonen `timeZone`. */
function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(date);
  return ['year', 'month', 'day'].map((type) => Number(parts.find((p) => p.type === type).value));
}

/**
 * Neste versjonsnummer: samme dag som `current` gir løpenummeret + 1, en ny dag gir løpenummer 1.
 * `current` kan være null (første versjon).
 */
export function nextVersion(current, { now = new Date(), timeZone = 'Europe/Oslo' } = {}) {
  const today = dateParts(now, timeZone).join('.');
  const match = VERSION_PATTERN.exec(current || '');
  const sameDay = match && `${match[1]}.${match[2]}.${match[3]}` === today;
  return `${today}.${sameDay ? Number(match[4]) + 1 : 1}`;
}

import { formatAnswer, formatDateTime } from './format.js';
import { translator } from '../public/assets/i18n/index.js';

// Semikolon som skilletegn og UTF-8 BOM gjør at norsk Excel åpner filen riktig (inkludert æøå).
const SEPARATOR = ';';

function cell(value) {
  let text = String(value ?? '');
  // Hindrer «CSV injection»: celler som starter med = + - @ tolkes som formler i Excel.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV med alle påmeldte. Overskrifter og ja/nei på språket `lang` (admin-språket). */
export function registrationsToCsv(event, registrations, timeZone, lang = 'nb') {
  const t = translator(lang);
  // «Påmeldt av» er kontaktpersonen for påmeldingen, slik at personer som ble meldt på sammen
  // kan grupperes/filtreres i Excel. For kontaktpersonen selv er det samme navn som i «Navn».
  const header = [
    '#', t('csv.registeredAt'), t('csv.name'), t('csv.email'), t('csv.bookedBy'), t('csv.contactEmail'),
    ...event.fields.map((f) => f.label),
    t('csv.late'), t('csv.checkedIn'),
  ];
  const rows = registrations.map((r, i) => [
    i + 1,
    formatDateTime(r.createdAt, timeZone, lang),
    r.name,
    r.email,
    r.contactName,
    r.contactEmail,
    ...event.fields.map((f) => formatAnswer(f, r.answers, lang)),
    r.late ? t('answer.yes') : '',
    r.checkedInAt ? formatDateTime(r.checkedInAt, timeZone, lang) : '',
  ]);
  return '\uFEFF' + [header, ...rows].map((row) => row.map(cell).join(SEPARATOR)).join('\r\n') + '\r\n';
}

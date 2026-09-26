import { formatAnswer, formatDateTime } from './format.js';

// Semikolon som skilletegn og UTF-8 BOM gjør at norsk Excel åpner filen riktig (inkludert æøå).
const SEPARATOR = ';';

function cell(value) {
  let text = String(value ?? '');
  // Hindrer «CSV injection»: celler som starter med = + - @ tolkes som formler i Excel.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function registrationsToCsv(event, registrations, timeZone) {
  // «Påmeldt av» er kontaktpersonen for påmeldingen, slik at personer som ble meldt på sammen
  // kan grupperes/filtreres i Excel. For kontaktpersonen selv er det samme navn som i «Navn».
  const header = ['#', 'Påmeldt', 'Navn', 'E-post', 'Påmeldt av', 'Kontakt-e-post', ...event.fields.map((f) => f.label)];
  const rows = registrations.map((r, i) => [
    i + 1,
    formatDateTime(r.createdAt, timeZone),
    r.name,
    r.email,
    r.contactName,
    r.contactEmail,
    ...event.fields.map((f) => formatAnswer(f, r.answers)),
  ]);
  return '\uFEFF' + [header, ...rows].map((row) => row.map(cell).join(SEPARATOR)).join('\r\n') + '\r\n';
}

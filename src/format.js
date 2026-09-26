// Formatering av datoer og svar, brukt i e-poster og CSV-eksport.

function formatter(timeZone, options) {
  return new Intl.DateTimeFormat('nb-NO', { timeZone, ...options });
}

// «lørdag 12. oktober 2026 kl. 18:00–21:00» eller, over flere dager,
// «lørdag 12. oktober 2026 kl. 18:00 – søndag 13. oktober 2026 kl. 14:00».
export function formatEventTime(startsAt, endsAt, timeZone) {
  const day = formatter(timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = formatter(timeZone, { hour: '2-digit', minute: '2-digit' });
  const start = new Date(startsAt);
  const startText = `${day.format(start)} kl. ${time.format(start)}`;
  if (!endsAt) return startText;

  const end = new Date(endsAt);
  if (day.format(start) === day.format(end)) return `${startText}–${time.format(end)}`;
  return `${startText} – ${day.format(end)} kl. ${time.format(end)}`;
}

export function formatDateTime(iso, timeZone) {
  return formatter(timeZone, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

// Gjør et lagret svar om til lesbar tekst. Felter som er lagt til etter påmeldingen gir tom tekst.
export function formatAnswer(field, answers) {
  const value = answers?.[field.id];
  if (field.type === 'checkbox') return value === true ? 'Ja' : value === false ? 'Nei' : '';
  return value === undefined || value === null ? '' : String(value);
}

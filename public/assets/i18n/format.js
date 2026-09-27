// Formatering av datoer, svar og navnelister på nettstedets språk. Delt mellom nettleser og server.
// `t` er en oversetter fra index.js; t.locale bestemmer datoformatet (nb-NO, en-GB …).

function formatter(t, timeZone, options) {
  return new Intl.DateTimeFormat(t.locale, { timeZone, ...options });
}

/** «lørdag 12. oktober 2026» / «Saturday 12 October 2026» */
export function formatDay(iso, timeZone, t) {
  return formatter(t, timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** «18:00» */
export function formatTime(iso, timeZone, t) {
  return formatter(t, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/**
 * «lørdag 12. oktober 2026 kl. 18:00–21:00», eller over flere dager
 * «lørdag 12. oktober 2026 kl. 18:00 – søndag 13. oktober 2026 kl. 14:00».
 */
export function formatEventTime(startsAt, endsAt, timeZone, t) {
  const at = (iso) => t('date.at', { day: formatDay(iso, timeZone, t), time: formatTime(iso, timeZone, t) });
  const start = at(startsAt);
  if (!endsAt) return start;
  if (formatDay(startsAt, timeZone, t) === formatDay(endsAt, timeZone, t)) {
    return t('date.sameDay', { start, endTime: formatTime(endsAt, timeZone, t) });
  }
  return t('date.multiDay', { start, end: at(endsAt) });
}

/** Kort dato og tid, f.eks. «26.09.2026, 22:39» / «26/09/2026, 22:39». */
export function formatShort(iso, timeZone, t) {
  return formatter(t, timeZone, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(iso));
}

/** Et lagret svar som lesbar tekst. Felter som er lagt til etter påmeldingen gir tom tekst. */
export function formatAnswer(field, answers, t) {
  const value = answers?.[field.id];
  if (field.type === 'checkbox') return value === true ? t('answer.yes') : value === false ? t('answer.no') : '';
  return value === undefined || value === null ? '' : String(value);
}

/** «Ola», «Ola og Kari», «Ola, Kari og Per» / «Ola, Kari and Per». */
export function nameList(names, t) {
  return new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(names);
}

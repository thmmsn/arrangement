// Kalenderfil (iCalendar, RFC 5545) og «Legg til i Google Kalender»-lenke for et arrangement.
//
// Filen er den samme for alle deltakerne og inneholder BARE offentlig informasjon: tittel, tid, sted,
// beskrivelse og lenken til arrangementssiden. Aldri billett- eller avmeldingslenker – kalendere
// deles ofte med familie og kolleger, og da skal ingen andre kunne melde deg av.
//
// Tidene skrives i UTC (…Z). Da trengs ingen VTIMEZONE-blokk, og alle kalenderprogrammer viser
// riktig lokal tid, også når arrangementet går over et sommertidsskifte.
// UID er fast for arrangementet og SEQUENCE øker når det endres, så en fil som importeres på nytt
// oppdaterer avtalen i stedet for å lage en kopi.

/** 2030-10-26T16:00:00.000Z → 20301026T160000Z */
function icsTime(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Tekstverdier: \ ; , og linjeskift må escapes (RFC 5545, 3.3.11). */
export function icsText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Parameterverdier i anførselstegn kan ikke inneholde " eller linjeskift (RFC 5545, 3.2). */
function paramText(value) {
  return String(value ?? '').replace(/["\r\n]+/g, ' ').trim();
}

/**
 * Linjer lengre enn 75 byte brettes: resten fortsetter på neste linje etter ett mellomrom
 * (RFC 5545, 3.1). Telles i UTF-8-byte, og et tegn deles aldri midt i (æ, ø og å er 2 byte).
 */
export function foldLine(line) {
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    // Første linje kan ha 75 byte; fortsettelseslinjene 74 pluss mellomrommet foran.
    if (bytes + size > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/**
 * @param {object} opts
 * @param {object} opts.event      Arrangementet
 * @param {string} opts.eventUrl   Offentlig lenke til arrangementssiden
 * @param {string} opts.host       Nettstedets vertsnavn – gjør UID unik på tvers av installasjoner
 * @param {string} [opts.lang]     Språket i kalenderen
 * @param {Date}   [opts.now]
 */
export function eventIcs({ event, eventUrl, host, lang = 'nb', now = new Date(), cancelledPrefix = '[X]' }) {
  const description = [event.description, eventUrl].filter(Boolean).join('\n\n');
  // Antall sekunder siden arrangementet ble opprettet – øker for hver endring, og holder seg
  // godt innenfor et 32-bits heltall.
  const sequence = Math.max(0, Math.floor((Date.parse(event.updatedAt) - Date.parse(event.createdAt)) / 1000)) || 0;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//arrangement//NONSGML Arrangement//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.slug}@${host || 'arrangement'}`,
    `DTSTAMP:${icsTime(now)}`,
    `LAST-MODIFIED:${icsTime(event.updatedAt)}`,
    `SEQUENCE:${sequence}`,
    `DTSTART:${icsTime(event.startsAt)}`,
    // Uten sluttid slutter avtalen når den starter (RFC 5545, 3.6.1) – vi dikter ikke opp en varighet.
    event.endsAt ? `DTEND:${icsTime(event.endsAt)}` : null,
    `SUMMARY;LANGUAGE=${lang}:${icsText(event.cancelledAt ? `${cancelledPrefix} ${event.title}` : event.title)}`,
    event.location ? `LOCATION;LANGUAGE=${lang}:${icsText(event.location)}` : null,
    // Kartpunktet: GEO er standarden; Apple Kalender bruker sin egen variant for kart og reisetid.
    event.geo ? `GEO:${event.geo.lat};${event.geo.lon}` : null,
    event.geo
      ? `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-TITLE="${paramText(event.location || event.title)}":geo:${event.geo.lat},${event.geo.lon}`
      : null,
    description ? `DESCRIPTION;LANGUAGE=${lang}:${icsText(description)}` : null,
    `URL:${eventUrl}`,
    // Et avlyst arrangement blir strøket over / fjernet i kalenderen når filen importeres på nytt.
    event.cancelledAt ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Lenke som åpner Google Kalender med avtalen ferdig utfylt (Android har ingen innebygd .ics-import). */
export function googleCalendarUrl({ event, eventUrl }) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${icsTime(event.startsAt)}/${icsTime(event.endsAt || event.startsAt)}`,
    details: [event.description, eventUrl].filter(Boolean).join('\n\n').slice(0, 1500),
    location: event.location || '',
  });
  if (!event.location) params.delete('location');
  return `https://calendar.google.com/calendar/render?${params}`;
}

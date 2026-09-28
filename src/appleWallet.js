// Apple Wallet: ett .pkpass-kort per billett, eller en .pkpasses-fil med alle billettene i en påmelding.
//
// Et .pkpass er en ZIP med pass.json (innholdet), bilder, manifest.json (SHA-1 av hver fil) og
// «signature»: en PKCS#7-signatur av manifestet, laget med kortsertifikatet fra Apple og Apples
// mellomsertifikat (WWDR). Uten gyldig signatur nekter iPhone å legge kortet til.
// https://developer.apple.com/documentation/walletpasses
//
// Tid og sted gjør at kortet dukker opp av seg selv:
// - relevantDates/relevantDate: kortet vises på låseskjermen når arrangementet nærmer seg.
// - locations: kortet vises når telefonen er i nærheten av stedet (krever kartpunkt).
// - semantics: forteller Wallet hva slags arrangement det er, hvor og når – brukes av iOS til
//   forslag, kart og veibeskrivelse.
// På baksiden ligger i tillegg en «Veibeskrivelse»-lenke til kartet.
import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { formatEventTime } from './format.js';
import { formatCode } from './ids.js';
import { appleDirectionsUrl } from './places.js';
import { hexToRgb, ticketIcon } from './png.js';
import { zip } from './zip.js';

const DEFAULT_ACCENT = [139, 46, 42];
const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const HOUR = 3_600_000;

// Relativ luminans (WCAG): avgjør om teksten på kortet skal være lys eller mørk.
function luminance([r, g, b]) {
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** pass.json for én billett. Eksportert for testene. */
export function passJson({ config, event, site, timeZone, eventUrl, ticket }) {
  const { t, theme } = site;
  const background = hexToRgb(theme.colors.accent) ?? DEFAULT_ACCENT;
  const light = luminance(background) < 0.4;
  const foreground = light ? [255, 255, 255] : [30, 30, 30];
  const label = light ? [235, 235, 235] : [70, 70, 70];
  const code = formatCode(ticket.code);
  const directions = appleDirectionsUrl(event);
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : null;
  const link = (key, labelText, url, text) => ({ key, label: labelText, value: url, attributedValue: `<a href="${url}">${text}</a>` });

  return {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeId,
    teamIdentifier: config.teamId,
    // Billettnummeret er unikt, så et nytt kort for samme billett erstatter det gamle i Wallet.
    serialNumber: ticket.code,
    organizationName: theme.siteName || event.organizerName,
    description: t('wallet.description', { title: event.title }),
    ...(theme.siteName && { logoText: theme.siteName }),
    backgroundColor: rgb(background),
    foregroundColor: rgb(foreground),
    labelColor: rgb(label),
    // Eldre iOS bruker relevantDate; iOS 18+ bruker relevantDates (et tidsrom).
    relevantDate: start.toISOString(),
    relevantDates: [{
      startDate: new Date(start.getTime() - 3 * HOUR).toISOString(),
      endDate: (end ?? new Date(start.getTime() + 3 * HOUR)).toISOString(),
    }],
    ...(event.geo && {
      locations: [{ latitude: event.geo.lat, longitude: event.geo.lon, relevantText: event.title }],
    }),
    barcodes: [{ format: 'PKBarcodeFormatQR', message: ticket.url, messageEncoding: 'iso-8859-1', altText: code }],
    semantics: {
      eventType: 'PKEventTypeGeneric',
      eventName: event.title,
      eventStartDate: start.toISOString(),
      ...(end && { eventEndDate: end.toISOString() }),
      ...(event.location && { venueName: event.location }),
      ...(event.geo && { venueLocation: { latitude: event.geo.lat, longitude: event.geo.lon } }),
      attendeeName: ticket.name,
    },
    eventTicket: {
      headerFields: [{
        key: 'date', label: t('wallet.date'), value: start.toISOString(),
        dateStyle: 'PKDateStyleShort', timeStyle: 'PKDateStyleShort',
      }],
      primaryFields: [{ key: 'event', label: t('wallet.event'), value: event.title }],
      secondaryFields: [{ key: 'name', label: t('ticket.holder'), value: ticket.name }],
      auxiliaryFields: [
        event.location ? { key: 'location', label: t('email.where'), value: event.location } : null,
        ticket.total > 1 ? { key: 'position', label: t('wallet.ticket'), value: `${ticket.index} / ${ticket.total}` } : null,
      ].filter(Boolean),
      backFields: [
        { key: 'when', label: t('email.when'), value: formatEventTime(event.startsAt, event.endsAt, timeZone, site.lang) },
        event.location ? { key: 'where', label: t('email.where'), value: event.location } : null,
        directions ? link('directions', t('ticket.directions'), directions, t('ticket.directions')) : null,
        { key: 'code', label: t('ticket.number'), value: code },
        link('ticket', t('wallet.showTicket'), ticket.url, t('wallet.showTicket')),
        link('eventPage', t('wallet.eventPage'), eventUrl, eventUrl),
        { key: 'organizer', label: t('email.organizer'), value: event.organizerName },
      ].filter(Boolean),
    },
  };
}

// PKCS#7-signatur (detached) av manifestet, med kortsertifikatet og Apples mellomsertifikat.
function sign(manifest, config) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString('binary'));
  p7.addCertificate(config.cert);
  p7.addCertificate(config.wwdr);
  p7.addSigner({
    key: config.key,
    certificate: config.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

// Ikonene er de samme for alle kortene på et nettsted, så de lages én gang.
const iconCache = new Map();
function icons(accent) {
  const color = hexToRgb(accent) ?? DEFAULT_ACCENT;
  const key = color.join(',');
  if (!iconCache.has(key)) {
    iconCache.set(key, { 'icon.png': ticketIcon(29, color), 'icon@2x.png': ticketIcon(58, color), 'icon@3x.png': ticketIcon(87, color) });
  }
  return iconCache.get(key);
}

/** Ett signert .pkpass (Buffer) for én billett. */
export function applePass(opts) {
  const files = {
    'pass.json': Buffer.from(JSON.stringify(passJson(opts)), 'utf8'),
    ...icons(opts.site.theme.colors.accent),
  };
  const manifest = Buffer.from(JSON.stringify(Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, createHash('sha1').update(data).digest('hex')]),
  )), 'utf8');
  return zip([
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
    { name: 'manifest.json', data: manifest },
    { name: 'signature', data: sign(manifest, opts.config) },
  ]);
}

/**
 * Kortene for alle billettene. Én billett gir et vanlig .pkpass; flere gir en .pkpasses-samling
 * (iOS 15+), slik at hele familien legges til med ett trykk.
 */
export function applePasses({ tickets, ...opts }) {
  if (tickets.length === 1) {
    return { type: 'application/vnd.apple.pkpass', ext: 'pkpass', data: applePass({ ...opts, ticket: tickets[0] }) };
  }
  const data = zip(tickets.map((ticket, i) => ({ name: `${String(i + 1).padStart(2, '0')}-${ticket.code}.pkpass`, data: applePass({ ...opts, ticket }) })));
  return { type: 'application/vnd.apple.pkpasses', ext: 'pkpasses', data };
}

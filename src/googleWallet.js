// Google Wallet: «Lagre i Google Wallet»-lenke med en signert JWT.
//
// Lenken er https://pay.google.com/gp/v/save/<JWT>. JWT-en er signert (RS256) med nøkkelen til en
// tjenestekonto i Google Cloud og inneholder både arrangementet (klassen) og billettene (objektene).
// Google oppretter dem første gang noen lagrer, så det trengs ingen egne kall mot Google sitt API.
// https://developers.google.com/wallet/tickets/events
//
// Tid og sted: dateTime gjør at Google Wallet varsler når arrangementet nærmer seg, og venue viser
// stedet. Google har sluttet å bruke kartpunkter til varsler, så veibeskrivelsen legges som lenke.
import { sign } from 'node:crypto';
import { formatCode } from './ids.js';
import { directionsUrl } from './places.js';

const SAVE_URL = 'https://pay.google.com/gp/v/save/';

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
// Id-er hos Google: «<issuerId>.<tegn>», der bare bokstaver, tall, . _ og - er lov.
const safeId = (value) => String(value).replace(/[^\w.-]/g, '_');

/** JWT-ens innhold (før signering). Eksportert for testene. */
export function googleClaims({ config, event, site, eventUrl, tickets, heroImage = null, now = new Date() }) {
  const { t, theme, lang } = site;
  const text = (value) => ({ defaultValue: { language: lang, value } });
  const classId = `${config.issuerId}.${safeId(`event-${event.slug}`)}`;
  const directions = directionsUrl(event);
  const color = /^#[0-9a-f]{6}$/i.test(theme.colors.accent) ? theme.colors.accent : undefined;
  const logo = /^https:\/\/.+\.(png|jpe?g)$/i.test(theme.logoAbsoluteUrl || '') ? theme.logoAbsoluteUrl : null;

  const eventClass = {
    id: classId,
    issuerName: theme.siteName || event.organizerName,
    reviewStatus: 'UNDER_REVIEW',
    eventName: text(event.title),
    dateTime: { start: event.startsAt, ...(event.endsAt && { end: event.endsAt }) },
    ...(event.location && { venue: { name: text(event.location), address: text(event.location) } }),
    ...(logo && { logo: { sourceUri: { uri: logo } } }),
    // Forsidebildet øverst på kortet (Google henter det, så det må være en https-adresse).
    ...(/^https:\/\//.test(heroImage || '') && { heroImage: { sourceUri: { uri: heroImage } } }),
    ...(color && { hexBackgroundColor: color }),
    linksModuleData: {
      uris: [
        directions ? { id: 'directions', uri: directions, description: t('ticket.directions') } : null,
        { id: 'event', uri: eventUrl, description: t('wallet.eventPage') },
      ].filter(Boolean),
    },
  };

  const objects = tickets.map((ticket) => ({
    id: `${config.issuerId}.${safeId(`ticket-${ticket.code}`)}`,
    classId,
    state: 'ACTIVE',
    ticketHolderName: ticket.name,
    // Dørkoden er det som tastes inn i døra; den står under QR-koden.
    ticketNumber: ticket.doorCode || formatCode(ticket.code),
    barcode: { type: 'QR_CODE', value: ticket.url, alternateText: ticket.doorCode || formatCode(ticket.code) },
    ...(color && { hexBackgroundColor: color }),
    linksModuleData: { uris: [{ id: 'ticket', uri: ticket.url, description: t('wallet.showTicket') }] },
  }));

  return {
    iss: config.clientEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(now.getTime() / 1000),
    origins: [new URL(eventUrl).origin],
    payload: { eventTicketClasses: [eventClass], eventTicketObjects: objects },
  };
}

/** Lenken som legger billettene i Google Wallet. */
export function googleSaveUrl(opts) {
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const body = b64url(googleClaims(opts));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), opts.config.privateKey).toString('base64url');
  return `${SAVE_URL}${header}.${body}.${signature}`;
}

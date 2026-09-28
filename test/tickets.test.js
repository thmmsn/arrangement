import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { eventIcs, foldLine, googleCalendarUrl, icsText } from '../src/calendar.js';
import { fileSlug } from '../src/filename.js';
import { formatCode, parseCode } from '../src/ids.js';
import { pdfSafe } from '../src/pdf.js';
import { qrSvg } from '../src/qr.js';
import { createTokens } from '../src/tokens.js';
import { createEvent, register, startApp } from './helpers.js';

// Billetter: nøkler, sidene /t og /b, kalenderfil, PDF og vedleggene i bekreftelsen.

const SECRET = 'a'.repeat(64);
const pathOf = (url) => new URL(url).pathname;

describe('billettnøkler', () => {
  const tokens = createTokens(SECRET);

  test('en billettnøkkel er nummer + signatur, og bare en ekte nøkkel godtas', () => {
    const token = tokens.ticket('k7hq2mxpr9');
    assert.equal(token.length, 32);
    assert.equal(tokens.parseTicket(token), 'k7hq2mxpr9');
    // Én endret bokstav i signaturen, eller i nummeret, gjør nøkkelen ugyldig.
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    assert.equal(tokens.parseTicket(token.slice(0, -1) + last), null);
    assert.equal(tokens.parseTicket(`k7hq2mxpr8${token.slice(10)}`), null);
    assert.equal(tokens.parseTicket('tull'), null);
    assert.equal(tokens.parseTicket(undefined), null);
  });

  test('en påmeldingsnøkkel kan ikke brukes som billettnøkkel, og motsatt', () => {
    const booking = tokens.booking('k7hq2mxpr9');
    assert.equal(tokens.parseBooking(booking), 'k7hq2mxpr9');
    assert.equal(tokens.parseTicket(booking), null);
    assert.equal(tokens.parseBooking(tokens.ticket('k7hq2mxpr9')), null);
  });

  test('en annen hemmelighet gir andre nøkler', () => {
    const other = createTokens('b'.repeat(64));
    assert.equal(other.parseTicket(tokens.ticket('k7hq2mxpr9')), null);
  });

  test('dørvaktnøkkelen avhenger av arrangementet og versjonen', () => {
    const key = tokens.scanner(1, 1);
    assert.ok(tokens.scannerMatches(key, 1, 1));
    assert.ok(!tokens.scannerMatches(key, 1, 2), 'ny versjon = gammel nøkkel virker ikke');
    assert.ok(!tokens.scannerMatches(key, 2, 1), 'gjelder bare sitt eget arrangement');
    assert.ok(!tokens.scannerMatches(undefined, 1, 1));
  });

  test('billettnummeret vises gruppert og kan tastes inn slik det står', () => {
    assert.equal(formatCode('k7hq2mxpr9'), 'K7HQ-2MXP-R9');
    assert.equal(parseCode('K7HQ-2MXP-R9'), 'k7hq2mxpr9');
    assert.equal(parseCode(' k7hq 2mxp r9 '), 'k7hq2mxpr9');
    assert.equal(parseCode('K7HQ-2MXP'), null);
    assert.equal(parseCode('0000000000'), null, 'tegn som ikke finnes i alfabetet');
  });

  test('QR-koden er et SVG-bilde med hvit bakgrunn', () => {
    const svg = qrSvg('https://booking.example.com/t/abc');
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
    assert.match(svg, /<path fill="#000" d="M\d/);
  });
});

describe('kalenderfil', () => {
  const event = {
    slug: 'abcdefghjkmn',
    title: 'Fest; med, komma\\ og «norske» tegn',
    description: 'Første linje\nAndre linje',
    location: 'Grendehuset, Nordbygda',
    geo: { lat: 63.1, lon: 9.8 },
    startsAt: '2030-10-26T16:00:00.000Z',
    endsAt: '2030-10-26T20:00:00.000Z',
    createdAt: '2030-01-01T10:00:00.000Z',
    updatedAt: '2030-01-01T10:00:30.000Z',
  };
  const ics = eventIcs({ event, eventUrl: 'https://booking.example.com/abcdefghjkmn', host: 'booking.example.com', now: new Date('2030-02-01T00:00:00Z') });

  test('gyldig iCalendar: CRLF, UTC-tider, fast UID og SEQUENCE som øker', () => {
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/[^\r]\n/.test(ics), 'alle linjeskift er CRLF');
    assert.match(ics, /\r\nUID:abcdefghjkmn@booking\.example\.com\r\n/);
    assert.match(ics, /\r\nDTSTART:20301026T160000Z\r\n/);
    assert.match(ics, /\r\nDTEND:20301026T200000Z\r\n/);
    assert.match(ics, /\r\nSEQUENCE:30\r\n/);
    assert.match(ics, /\r\nSTATUS:CONFIRMED\r\n/);
    assert.match(ics, /\r\nGEO:63\.1;9\.8\r\n/);
  });

  test('tekst escapes og lange linjer brettes ved 75 byte uten å dele tegn', () => {
    assert.equal(icsText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');
    const unfolded = ics.replace(/\r\n /g, '');
    assert.match(unfolded, /SUMMARY;LANGUAGE=nb:Fest\\; med\\, komma\\\\ og «norske» tegn/);
    assert.match(unfolded, /DESCRIPTION;LANGUAGE=nb:Første linje\\nAndre linje\\n\\nhttps:\/\/booking\.example\.com\/abcdefghjkmn/);
    for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `for lang linje: ${line}`);
    const folded = foldLine(`X:${'ø'.repeat(100)}`);
    for (const line of folded.split('\r\n')) {
      assert.ok(Buffer.byteLength(line) <= 75);
      assert.ok(!line.includes('�'));
    }
  });

  test('uten sluttid dikter filen ikke opp en varighet, og avlyst gir STATUS:CANCELLED', () => {
    const noEnd = eventIcs({ event: { ...event, endsAt: null }, eventUrl: 'https://x.example', host: 'x.example' });
    assert.ok(!noEnd.includes('DTEND'));
    const cancelled = eventIcs({ event: { ...event, cancelledAt: '2030-02-01T00:00:00Z' }, eventUrl: 'https://x.example', host: 'x.example', cancelledPrefix: 'AVLYST:' });
    assert.match(cancelled, /STATUS:CANCELLED/);
    assert.match(cancelled.replace(/\r\n /g, ''), /SUMMARY;LANGUAGE=nb:AVLYST: Fest/);
  });

  test('Google Kalender-lenken har tittel, tider og sted', () => {
    const url = new URL(googleCalendarUrl({ event, eventUrl: 'https://booking.example.com/abcdefghjkmn' }));
    assert.equal(url.searchParams.get('action'), 'TEMPLATE');
    assert.equal(url.searchParams.get('dates'), '20301026T160000Z/20301026T200000Z');
    assert.equal(url.searchParams.get('location'), 'Grendehuset, Nordbygda');
  });

  test('filnavn uten spesialtegn', () => {
    assert.equal(fileSlug('Sommerfest på Østli!'), 'sommerfest-pa-ostli');
    assert.equal(fileSlug('!!!'), 'arrangement');
  });
});

describe('PDF', () => {
  test('tegn utenfor PDF-fontenes tegnsett byttes mot nærmeste bokstav', () => {
    assert.equal(pdfSafe('Ærlig Ødegård Åse'), 'Ærlig Ødegård Åse');
    // á finnes i tegnsettet og beholdes; ř gjør ikke det og blir r.
    assert.equal(pdfSafe('Łukasz Dvořák'), 'Lukasz Dvorák');
    assert.equal(pdfSafe('Emoji 🎉'), 'Emoji ?');
  });
});

describe('billettene etter påmelding', () => {
  test('bekreftelsen har billettlenke, kalenderfil og PDF – og siden viser billettene', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const { slug } = await createEvent(app, { location: 'Grendehuset', geo: { lat: 63.1, lon: 9.8 } });
    const res = await register(app, slug, { guests: ['Kari Nordmann'] });
    assert.equal(res.status, 201);
    assert.match(res.json.ticketsUrl, /^http:\/\/localhost:3000\/b\/[a-z0-9]{10}[\w-]{22}$/);

    const mail = app.sent.find((m) => m.to === 'ola@example.com');
    assert.deepEqual(mail.attachments.map((a) => a.contentType), ['text/calendar; charset=utf-8; method=PUBLISH', 'application/pdf']);
    assert.equal(mail.attachments[1].filename, 'billetter-testarrangement.pdf');
    assert.equal(mail.attachments[1].content.subarray(0, 5).toString(), '%PDF-');
    // Én side per person.
    assert.equal(mail.attachments[1].content.toString('latin1').match(/\/Type \/Page\b/g).length, 2);
    // Kalenderfilen har aldri billett- eller avmeldingslenker.
    const ics = mail.attachments[0].content.toString();
    assert.ok(!ics.includes('/t/') && !ics.includes('/b/') && !ics.includes('avmelding'));
    assert.match(mail.text, /Vis billettene: http:\/\/localhost:3000\/b\//);
    assert.match(mail.text, /Veibeskrivelse: https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=63\.1%2C9\.8/);

    const bookingPath = pathOf(res.json.ticketsUrl);
    const page = await app.request({ path: bookingPath });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    const data = await app.request({ path: bookingPath.replace('/b/', '/api/bookings/') });
    assert.deepEqual(data.json.tickets.map((t) => [t.name, t.index, t.total]), [['Ola Nordmann', 1, 2], ['Kari Nordmann', 2, 2]]);
    assert.equal(data.json.staff, null);
    assert.ok(!('id' in data.json.tickets[0]), 'gjester får ikke interne id-er');
    assert.match(data.json.tickets[0].code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/);

    const ticketPath = data.json.tickets[1].path;
    const ticket = await app.request({ path: ticketPath.replace('/t/', '/api/tickets/') });
    assert.equal(ticket.json.tickets[0].name, 'Kari Nordmann');
    assert.equal(ticket.json.tickets[0].index, 2);

    for (const [path, type] of [
      [`${ticketPath}/qr.svg`, /image\/svg\+xml/],
      [`${ticketPath}/pdf`, /application\/pdf/],
      [`${bookingPath}/pdf`, /application\/pdf/],
      [`/${slug}/kalender.ics`, /text\/calendar/],
    ]) {
      const r = await app.request({ path });
      assert.equal(r.status, 200, path);
      assert.match(r.headers['content-type'], type, path);
    }
    // Wallet er ikke satt opp: lenkene finnes ikke.
    assert.equal(data.json.links.apple, null);
    assert.equal((await app.request({ path: `${ticketPath}/apple` })).status, 404);
  });

  test('uten gyldig nøkkel: det samme nakne svaret som resten av domenet', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const { slug } = await createEvent(app);
    const res = await register(app, slug);
    const bookingPath = pathOf(res.json.ticketsUrl);
    const tampered = bookingPath.slice(0, -1) + (bookingPath.at(-1) === 'A' ? 'B' : 'A');
    for (const path of [
      tampered, `${tampered}/pdf`, bookingPath.replace('/b/', '/t/'), '/t/abc', '/b/', '/t/abcdefghjkXXXXXXXXXXXXXXXXXXXXXX/qr.svg',
      tampered.replace('/b/', '/api/bookings/'), '/api/tickets/abc', `/nesten${slug}/kalender.ics`, '/abcdefghjkmn/skanner',
    ]) {
      const r = await app.request({ path });
      assert.equal(r.status, 404, path);
      assert.equal(r.text, 'Not Found', path);
      assert.match(r.headers['content-type'], /text\/plain/, path);
    }
  });

  test('billettene sendes til riktig domene (301)', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: 'booking.example.no', SITE_COM_DOMAIN: 'booking.example.com', SITE_COM_LANG: 'en' });
    const { slug } = await createEvent(app, { site: 'com' }, { host: 'booking.example.no' });
    const res = await register(app, slug, { headers: { host: 'booking.example.com' } });
    assert.match(res.json.ticketsUrl, /^https:\/\/booking\.example\.com\/b\//);
    const path = pathOf(res.json.ticketsUrl);
    const wrong = await app.request({ path, headers: { host: 'booking.example.no' } });
    assert.equal(wrong.status, 301);
    assert.equal(wrong.headers.location, `https://booking.example.com${path}`);
    const ics = await app.request({ path: `/${slug}/kalender.ics`, headers: { host: 'booking.example.no' } });
    assert.equal(ics.status, 301);
    // Engelsk nettsted: engelske filnavn og tekster.
    const mail = app.sent.find((m) => m.to === 'ola@example.com');
    assert.equal(mail.attachments[1].filename, 'ticket-testarrangement.pdf');
    assert.match(mail.text, /Show ticket: https:\/\/booking\.example\.com\/b\//);
  });

  test('brytere per arrangement: alt er på som standard, og kan slås av', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const on = await createEvent(app);
    assert.deepEqual(app.repo.findEvent(on.slug).features, { tickets: true, calendar: true, pdf: true, googleWallet: true, appleWallet: true });

    const off = await createEvent(app, { features: { tickets: false, calendar: false } });
    const res = await register(app, off.slug, { email: 'uten@example.com' });
    assert.equal(res.json.ticketsUrl, null);
    assert.equal(res.json.event.links.ics, null);
    const mail = app.sent.find((m) => m.to === 'uten@example.com');
    assert.deepEqual(mail.attachments, []);
    assert.doesNotMatch(mail.text, /Vis billett/);
    assert.equal((await app.request({ path: `/${off.slug}/kalender.ics` })).status, 404);
    assert.equal((await app.request({ path: `/${off.slug}/skanner` })).status, 404);

    // Uten PDF: kalenderfil, men ingen PDF.
    const noPdf = await createEvent(app, { features: { pdf: false } });
    await register(app, noPdf.slug, { email: 'nopdf@example.com' });
    const m2 = app.sent.find((m) => m.to === 'nopdf@example.com');
    assert.deepEqual(m2.attachments.map((a) => a.filename), ['testarrangement.ics']);
  });

  test('en avmeldt person har ingen billett lenger', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const { slug, adminKey } = await createEvent(app);
    const res = await register(app, slug);
    const data = await app.request({ path: pathOf(res.json.ticketsUrl).replace('/b/', '/api/bookings/') });
    const ticketPath = data.json.tickets[0].path;
    const list = await app.request({ path: `/api/admin/events/${slug}`, headers: { authorization: `Bearer ${adminKey}` } });
    await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}/registrations/${list.json.registrations[0].id}`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal((await app.request({ path: ticketPath })).status, 404);
    assert.equal((await app.request({ path: pathOf(res.json.ticketsUrl) })).status, 404);
  });
});

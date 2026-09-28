import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { AccessError } from '../src/cfAccess.js';
import { loadConfig } from '../src/config.js';
import { createRepository, openDatabase } from '../src/db.js';
import { request } from './helpers.js';

// Den betrodde LAN-porten (LAN_PORT): samme app og database som PORT, men det er porten forespørselen
// kom inn på som gir tillit – aldri noe klienten sender.
//
// Oppsettet er verste tilfelle i produksjon: to nettsteder, eget admin-vertsnavn, Cloudflare Access,
// TRUST_PROXY=true og CLIENT_IP_HEADER=cf-connecting-ip – alt som kunne fristet til å stole på headere.

const MAIN = 'arrangement.example.no';
const COM = 'events.example.com';
const ADMIN = 'arrangement-admin.example.no';
const ENV = {
  DOMAIN: MAIN,
  SITE_COM_DOMAIN: COM,
  SITE_COM_LANG: 'en',
  ADMIN_HOST: ADMIN,
  TRUST_PROXY: 'true',
  CLIENT_IP_HEADER: 'cf-connecting-ip',
  LAN_PORT: '3001',
};

const servers = [];
after(() => servers.forEach((s) => s.close()));

const listen = async (server) => {
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return server.address().port;
};

/** Starter appen som server.js gjør: én lytter for PORT og én for LAN-porten, samme app og database. */
async function start({ rateLimits = {}, env = {} } = {}) {
  const config = {
    ...loadConfig({ ...ENV, ...env }),
    rateLimits: {
      register: { windowMs: 60_000, max: 1000 }, cancel: { windowMs: 60_000, max: 1000 },
      create: { windowMs: 60_000, max: 1000 }, scanner: { windowMs: 60_000, max: 1000 }, ...rateLimits,
    },
  };
  const sent = [];
  let accessChecks = 0;
  // Access er slått på og avviser alt – uten gyldig token kommer ingen forbi på PORT.
  const accessVerifier = async () => {
    accessChecks += 1;
    throw new AccessError('mangler token');
  };
  const app = createApp({
    repo: createRepository(openDatabase(':memory:')),
    mailer: { send: async (m) => { sent.push(m); return { id: 'test' }; } },
    config, accessVerifier, logger: { log() {}, error() {}, warn() {} },
  });
  const port = await listen(http.createServer(app));
  const lanPort = await listen(http.createServer(app.lanHandler));
  return {
    pub: (options) => request(port, options),
    lan: (options) => request(lanPort, options),
    sent,
    accessChecks: () => accessChecks,
  };
}

// Teksten i en PDF fra PDFKit: innholdet er komprimert (Flate), og teksten står som hex-kodede tegn
// (<6874…>), gjerne delt opp av kerning. Pakk ut strømmene og sett tegnene sammen igjen.
function pdfText(pdf) {
  const raw = pdf.toString('latin1');
  let text = '';
  for (const [, body] of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content;
    try { content = inflateSync(Buffer.from(body, 'latin1')).toString('latin1'); } catch { continue; }
    for (const [, array] of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      text += [...array.matchAll(/<([0-9a-f]+)>/gi)].map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')).join('');
      text += '\n';
    }
  }
  return text;
}

const eventBody = (overrides = {}) => ({
  title: 'Julebord',
  startsAt: '2030-12-06T17:00:00.000Z',
  organizerName: 'Kari',
  organizerEmail: 'kari@example.com',
  fields: [],
  ...overrides,
});

// Alt en klient kan sende for å late som den er på LAN, kommer fra tunnelen, eller er admin-vertsnavnet.
const SPOOFED = {
  'x-forwarded-for': '192.168.1.20',
  'x-forwarded-host': ADMIN,
  'x-forwarded-port': '3001',
  'x-forwarded-proto': 'https',
  'x-forwarded-server': 'lan',
  'x-real-ip': '192.168.1.20',
  forwarded: 'for=192.168.1.20;host=arrangement-admin.example.no;proto=https',
  'cf-connecting-ip': '192.168.1.20',
  'true-client-ip': '192.168.1.20',
};
// Host-verdier en angriper kan prøve: LAN-adresser, localhost, LAN-porten og admin-vertsnavnet.
const HOSTS = ['192.168.1.10:3001', 'localhost:3001', '127.0.0.1', `${MAIN}:3001`, 'lan', ADMIN];
const QUERIES = ['', '?lan=1', '?site=main', '?trusted=true&port=3001'];

describe('LAN_PORT i konfigurasjonen', () => {
  test('valgfri, et gyldig portnummer, og ikke den samme som PORT', () => {
    assert.equal(loadConfig({}).lanPort, null);
    assert.equal(loadConfig({ LAN_PORT: '3001' }).lanPort, 3001);
    for (const value of ['abc', '0', '70000', '30.5', '-1']) {
      const config = loadConfig({ LAN_PORT: value });
      assert.equal(config.lanPort, null, value);
      assert.ok(config.warnings.some((w) => w.startsWith(`LAN_PORT=${JSON.stringify(value)} ignoreres`)), value);
    }
    const same = loadConfig({ PORT: '3000', LAN_PORT: '3000' });
    assert.equal(same.lanPort, null);
    assert.ok(same.warnings.some((w) => /kan ikke være den samme som PORT/.test(w)));
  });
});

describe('PORT kan ikke lures til å bli betrodd', () => {
  test('Host, X-Forwarded-*, cf-connecting-ip og query gir aldri admin på PORT', async () => {
    const app = await start();
    for (const host of HOSTS) {
      for (const query of QUERIES) {
        const headers = { ...SPOOFED, host };
        const label = `Host: ${host} ${query}`;
        // Uten gyldig Access-token: 403 på admin-vertsnavnet, og admin finnes ikke (404) på andre vertsnavn.
        const expected = host === ADMIN ? 403 : 404;
        const page = await app.pub({ path: `/admin/ny${query}`, headers });
        assert.equal(page.status, expected, `side, ${label}`);
        const config = await app.pub({ path: `/api/admin/config${query}`, headers });
        assert.equal(config.status, expected, `API, ${label}`);
        const create = await app.pub({ method: 'POST', path: `/api/admin/events${query}`, headers, body: eventBody() });
        assert.equal(create.status, expected, `opprett, ${label}`);
      }
    }
    // På admin-vertsnavnet ble Access faktisk spurt hver gang – og sa nei.
    assert.equal(app.accessChecks(), QUERIES.length * 3);
  });

  test('rate limiting gjelder fortsatt på PORT, men ikke på LAN', async () => {
    const app = await start({ rateLimits: { register: { windowMs: 60_000, max: 2 } } });
    const created = await app.lan({ method: 'POST', path: '/api/admin/events', body: eventBody() });
    const register = (send, i, headers = {}) => send({
      method: 'POST', path: `/api/events/${created.json.slug}/registrations`, headers: { host: MAIN, ...headers },
      body: { name: `Gjest ${i}`, email: `gjest${i}@example.com` },
    });
    // På PORT: tredje forsøk fra samme IP stoppes. Forfalskede LAN-headere hjelper ikke.
    assert.equal((await register(app.pub, 1, { 'cf-connecting-ip': '203.0.113.9' })).status, 201);
    assert.equal((await register(app.pub, 2, { 'cf-connecting-ip': '203.0.113.9' })).status, 201);
    const blocked = await register(app.pub, 3, { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-port': '3001', host: 'localhost:3001' });
    assert.equal(blocked.status, 429);
    // På LAN: ingen grense – og cf-connecting-ip betyr ingenting (IP-en leses fra socketen).
    for (let i = 10; i < 16; i++) {
      assert.equal((await register(app.lan, i, { 'cf-connecting-ip': '203.0.113.9' })).status, 201, `LAN nr. ${i}`);
    }
  });
});

describe('LAN-porten er betrodd', () => {
  test('admin virker uten Access-token og uten ADMIN_HOST, med hvilket som helst vertsnavn', async () => {
    const app = await start();
    for (const host of ['192.168.1.10:9067', MAIN, COM, 'server.lan']) {
      assert.equal((await app.lan({ path: '/admin/ny', headers: { host } })).status, 200, host);
      assert.equal((await app.lan({ path: '/api/admin/config', headers: { host } })).status, 200, host);
    }
    const create = await app.lan({ method: 'POST', path: '/api/admin/events', headers: { host: '192.168.1.10:9067' }, body: eventBody() });
    assert.equal(create.status, 201);
    assert.equal(app.accessChecks(), 0, 'Access spørres aldri på LAN');

    // Admin-nøkkelen for arrangementet kreves fortsatt – LAN erstatter Access, ikke nøkkelen.
    const { slug, adminKey } = create.json;
    assert.equal((await app.lan({ path: `/api/admin/events/${slug}` })).status, 401);
    const admin = await app.lan({ path: `/api/admin/events/${slug}`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(admin.status, 200);
    assert.equal((await app.lan({ path: `/admin/${slug}` })).status, 200);

    // Den samme admin-siden er fortsatt stengt på PORT uten Access.
    assert.equal((await app.pub({ path: `/api/admin/events/${slug}`, headers: { host: ADMIN, authorization: `Bearer ${adminKey}` } })).status, 403);
  });

  test('alle lenker er de offentlige – også når handlingen skjedde på LAN', async () => {
    const app = await start();
    const create = await app.lan({ method: 'POST', path: '/api/admin/events', headers: { host: '192.168.1.10:9067' }, body: eventBody({ site: 'com' }) });
    const { slug, adminKey } = create.json;
    assert.equal(create.json.eventUrl, `https://${COM}/${slug}`);
    assert.equal(create.json.adminUrl, `https://${ADMIN}/admin/${slug}#${adminKey}`);
    assert.match(create.json.scannerUrl, new RegExp(`^https://${COM}/${slug}/skanner#`));
    const created = app.sent.find((m) => m.to === 'kari@example.com');
    assert.ok(created.text.includes(`https://${COM}/${slug}`));
    assert.ok(created.text.includes(`https://${ADMIN}/admin/${slug}#${adminKey}`));
    assert.doesNotMatch(created.text + created.html, /192\.168|9067|3001/);

    // Admin-siden viser de offentlige lenkene, som er dem som deles videre.
    const admin = await app.lan({ path: `/api/admin/events/${slug}`, headers: { host: '192.168.1.10:9067', authorization: `Bearer ${adminKey}` } });
    assert.equal(admin.json.event.url, `https://${COM}/${slug}`);
    assert.match(admin.json.event.scannerUrl, new RegExp(`^https://${COM}/`));

    // Påmelding på LAN: e-post, svar og vedlegg har bare offentlige lenker.
    const reg = await app.lan({
      method: 'POST', path: `/api/events/${slug}/registrations`, headers: { host: '192.168.1.10:9067' },
      body: { name: 'Ola', email: 'ola@example.com', guests: [{ name: 'Kari' }] },
    });
    assert.equal(reg.status, 201);
    for (const url of Object.values(reg.json.links).filter(Boolean)) {
      assert.ok(url.startsWith(`https://${COM}/`) || url.startsWith('https://calendar.google.com/'), url);
    }
    const confirmation = app.sent.find((m) => m.to === 'ola@example.com');
    assert.doesNotMatch(confirmation.text + confirmation.html, /192\.168|9067|3001|localhost/);
    const ics = confirmation.attachments.find((a) => a.filename.endsWith('.ics')).content.toString();
    assert.match(ics, new RegExp(`https://${COM}/${slug}`));
    const pdf = pdfText(confirmation.attachments.find((a) => a.filename.endsWith('.pdf')).content);
    assert.ok(pdf.includes(`https://${COM}/${slug}`), pdf);
    assert.doesNotMatch(pdf, /192\.168|9067|3001|localhost/);

    // Siden med alle billettene: «Del billetten» får den offentlige lenken.
    const bookingPath = new URL(reg.json.links.tickets).pathname;
    const booking = await app.lan({ path: `${bookingPath.replace('/b/', '/api/bookings/')}`, headers: { host: '192.168.1.10:9067' } });
    for (const ticket of booking.json.tickets) assert.match(ticket.url, new RegExp(`^https://${COM}/t/`));
  });

  test('nettstedet velges fra Host, eller med ?site= – men ?site= virker bare på LAN', async () => {
    const app = await start();
    const lang = (res) => /<html lang="(\w+)"/.exec(res.text)?.[1];
    const { slug } = (await app.lan({ method: 'POST', path: '/api/admin/events', body: eventBody({ site: 'com' }) })).json;

    // Host velger nettstedet også på LAN; et ukjent vertsnavn gir hovednettstedet.
    assert.equal(lang(await app.lan({ path: `/${slug}`, headers: { host: COM } })), 'en');
    assert.equal(lang(await app.lan({ path: `/${slug}?site=com`, headers: { host: '192.168.1.10:9067' } })), 'en');
    const noSite = await app.lan({ path: '/admin/ny?site=finnes-ikke', headers: { host: '192.168.1.10:9067' } });
    assert.equal(lang(noSite), 'nb');

    // Et .com-arrangement på LAN med et LAN-vertsnavn: 302 til samme adresse med ?site=com – aldri ut på
    // internett. Andre query-parametere beholdes.
    const lanRedirect = await app.lan({ path: `/${slug}/avmelding?x=1`, headers: { host: '192.168.1.10:9067' } });
    assert.equal(lanRedirect.status, 302);
    assert.equal(lanRedirect.headers.location, `/${slug}/avmelding?x=1&site=com`);

    // Videresendingen er alltid en sti på samme vertsnavn – aldri til et annet domene.
    for (const path of [`/${slug}?next=//evil.example`, `/${slug}/avmelding?site=//evil.example`]) {
      const res = await app.lan({ path, headers: { host: 'evil.example' } });
      assert.equal(res.status, 302, path);
      assert.match(res.headers.location, new RegExp(`^/${slug}(/avmelding)?\\?`), path);
      assert.ok(res.headers.location.endsWith('site=com'), path);
    }

    // På PORT har ?site= ingen virkning: feil domene gir 301 til det offentlige domenet, som i dag.
    const pubRedirect = await app.pub({ path: `/${slug}?site=com`, headers: { host: MAIN } });
    assert.equal(pubRedirect.status, 301);
    assert.equal(pubRedirect.headers.location, `https://${COM}/${slug}?site=com`);
  });

  test('dørvakt-informasjonskapselen virker på LAN (http), og er Secure på PORT (https)', async () => {
    const app = await start();
    const create = await app.lan({ method: 'POST', path: '/api/admin/events', body: eventBody() });
    const key = new URL(create.json.scannerUrl).hash.slice(1);
    const login = (send, host) => send({
      method: 'POST', path: `/api/events/${create.json.slug}/scanner/login`, headers: { host }, body: { key },
    });
    const lanCookie = (await login(app.lan, '192.168.1.10:9067')).headers['set-cookie'][0];
    assert.doesNotMatch(lanCookie, /Secure/i);
    assert.match(lanCookie, /HttpOnly/);
    const pubCookie = (await login(app.pub, MAIN)).headers['set-cookie'][0];
    assert.match(pubCookie, /Secure/);
  });
});

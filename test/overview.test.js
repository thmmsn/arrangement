import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessError } from '../src/cfAccess.js';
import { loadConfig } from '../src/config.js';
import { createRepository, openDatabase } from '../src/db.js';
import { createEvent, register, request, startApp } from './helpers.js';

// Oversikten over alle arrangementer: /admin#<OVERVIEW_KEY> (siden) og GET /api/admin/overview (dataene).
// Nøkkelen kreves alltid – også på LAN-porten og med Cloudflare Access. Med ADMIN_HOST finnes oversikten
// bare der (og på LAN-porten). Uten OVERVIEW_KEY finnes den ikke.

const MAIN = 'arrangement.example.no';
const COM = 'events.example.com';
const ADMIN = 'arrangement-admin.example.no';
const KEY = 'o'.repeat(20) + 'Oversikt_Nokkel-1234';
const CREATE_KEY = 'k'.repeat(20) + 'Opprett_Nokkel-123';
const onHost = (host) => ({ host });
const bearer = (key) => ({ authorization: `Bearer ${key}` });
const overview = (app, headers = {}) => app.request({ path: '/api/admin/overview', headers });

const expectNaked404 = (res, label) => {
  assert.equal(res.status, 404, label);
  assert.equal(res.text, 'Not Found', label);
};

// Et arrangement rett i databasen, så tidspunktet kan ligge i fortiden (skjemaet godtar ikke det).
function insertEvent(repo, overrides = {}) {
  return repo.createEvent({
    slug: overrides.slug, adminKeyHash: 'x', title: 'Arrangement', description: '', location: '',
    startsAt: '2030-10-26T16:00:00.000Z', endsAt: null, registrationDeadline: null, capacity: null, maxPerBooking: 10,
    showCount: true, isOpen: true, organizerName: 'Kari', organizerEmail: 'kari@example.com', imageUrl: null, fields: [],
    site: 'main', ...overrides,
  });
}

describe('uten OVERVIEW_KEY', () => {
  test('finnes oversikten ikke: /admin sender videre til /admin/ny som før, og API-et gir naken 404', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN });
    const page = await app.request({ path: '/admin', headers: onHost(MAIN) });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/admin/ny');
    expectNaked404(await overview(app, { ...onHost(MAIN), ...bearer(KEY) }), 'API-et');
  });

  test('en for kort nøkkel ignoreres med en advarsel, og oversikten er stengt', async () => {
    const config = loadConfig({ DOMAIN: MAIN, OVERVIEW_KEY: 'for-kort' });
    assert.equal(config.overviewKey, null);
    assert.ok(config.warnings.some((w) => w.startsWith('OVERVIEW_KEY ignoreres')), config.warnings.join('\n'));
    const app = await startApp({ DOMAIN: MAIN, OVERVIEW_KEY: 'for-kort' });
    expectNaked404(await overview(app, bearer('for-kort')), 'for kort nøkkel');
  });
});

describe('med OVERVIEW_KEY', () => {
  test('/admin viser oversiktssiden – uten data, de hentes med nøkkelen', async () => {
    const app = await startApp({ DOMAIN: MAIN, OVERVIEW_KEY: KEY });
    await insertEvent(app.repo, { slug: 'abcdefghjkmn', title: 'Hemmelig tittel' });
    const page = await app.request({ path: '/admin', headers: onHost(MAIN) });
    assert.equal(page.status, 200);
    assert.match(page.text, /\/assets\/js\/overview\.js\?v=/);
    assert.doesNotMatch(page.text, /Hemmelig tittel/, 'siden selv har ingen data');
    // /admin/ny er uendret.
    assert.equal((await app.request({ path: '/admin/ny', headers: onHost(MAIN) })).status, 200);
  });

  test('API-et krever nøkkelen: 401 uten, med feil nøkkel og med en annen nøkkel', async () => {
    const app = await startApp({ DOMAIN: MAIN, OVERVIEW_KEY: KEY, CREATE_KEY });
    const event = await createEvent(app, {}, bearer(CREATE_KEY));
    for (const [headers, label] of [
      [{}, 'uten nøkkel'],
      [bearer('feil'), 'feil nøkkel'],
      [bearer(KEY.slice(0, -1)), 'nesten riktig'],
      [bearer(CREATE_KEY), 'opprettingsnøkkelen'],
      [bearer(event.adminKey), 'admin-nøkkelen til et arrangement'],
    ]) {
      const res = await overview(app, headers);
      assert.equal(res.status, 401, label);
      assert.match(res.json.error, /OVERVIEW_KEY/, label);
      assert.equal(res.headers['cache-control'], 'no-store', label);
    }
    const ok = await overview(app, bearer(KEY));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    // Med skråstrek til slutt: samme port og samme svar.
    assert.equal((await app.request({ path: '/api/admin/overview/' })).status, 401);
    assert.equal((await app.request({ path: '/api/admin/overview/', headers: bearer(KEY) })).status, 200);
  });

  test('viser alle arrangementene med tall, aliaser og status – men ingen opplysninger om gjestene', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, OVERVIEW_KEY: KEY });
    const party = await createEvent(app, { title: 'Julebord', location: 'Kontoret', capacity: 40 });
    const quiz = await createEvent(app, { title: 'Quiz', startsAt: '2030-11-01T17:00:00.000Z' });
    await register(app, party.slug, { name: 'Ola Gjest', email: 'ola.gjest@example.com', guests: ['Per Gjest'] });
    await register(app, party.slug, { name: 'Kari Gjest', email: 'kari.gjest@example.com' });
    await app.request({
      method: 'POST', path: `/api/admin/events/${party.slug}/aliases`, headers: bearer(party.adminKey), body: { alias: 'julebord' },
    });
    const partyId = app.repo.findEvent(party.slug).id;
    const [first] = app.repo.listRegistrations(partyId);
    app.repo.checkIn(partyId, first.id);

    assert.equal((await overview(app)).status, 401, 'ADMIN_NO_AUTH (lokal utvikling) gir ikke tilgang uten nøkkelen');
    const res = await overview(app, bearer(KEY));
    assert.equal(res.status, 200);
    assert.equal(res.json.timeZone, 'Europe/Oslo');
    assert.equal(res.json.deleteAfterDays, 30);
    assert.deepEqual(res.json.events.map((e) => e.title), ['Julebord', 'Quiz'], 'tidligste start først');
    const [p, q] = res.json.events;
    assert.equal(p.url, `https://${MAIN}/${party.slug}`);
    assert.deepEqual(p.aliases, [`https://${MAIN}/julebord`]);
    assert.equal(p.location, 'Kontoret');
    assert.equal(p.count, 3, 'personer');
    assert.equal(p.bookings, 2, 'påmeldinger');
    assert.equal(p.checkedIn, 1);
    assert.equal(p.capacity, 40);
    assert.equal(p.status, 'open');
    assert.equal(p.ended, false);
    assert.equal(p.organizerEmail, 'arrangor@example.com');
    assert.equal(q.count, 0);
    assert.deepEqual(q.aliases, []);

    // Ingen navn, e-poster, billetter, dørkoder eller nøkler fra gjestene eller arrangøren.
    for (const secret of ['Ola Gjest', 'Per Gjest', 'ola.gjest@', 'kari.gjest@', first.code, first.doorCode, party.adminKey]) {
      assert.ok(!res.text.includes(secret), `lekker ${secret}`);
    }
    assert.ok(!('adminKeyHash' in p) && !('adminUrl' in p) && !('scannerUrl' in p));
  });

  test('avsluttede, avlyste og fulle arrangementer får riktig status, og avsluttede får slettedato', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, OVERVIEW_KEY: KEY });
    insertEvent(app.repo, { slug: 'gammeltarrng', title: 'Gammelt', startsAt: '2020-01-01T10:00:00.000Z', endsAt: '2020-01-01T12:00:00.000Z' });
    const cancelled = insertEvent(app.repo, { slug: 'avlystarrang', title: 'Avlyst' });
    app.repo.setCancelled(cancelled.id, new Date().toISOString());
    const full = await createEvent(app, { title: 'Fullt', capacity: 1 });
    await register(app, full.slug);

    const { events } = (await overview(app, bearer(KEY))).json;
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
    assert.equal(byTitle.Gammelt.ended, true);
    assert.equal(byTitle.Gammelt.status, 'deadline_passed');
    assert.equal(byTitle.Gammelt.deleteAt, '2020-01-31T12:00:00.000Z', '30 dager etter slutt');
    assert.equal(byTitle.Avlyst.status, 'cancelled');
    assert.ok(byTitle.Avlyst.cancelledAt);
    assert.equal(byTitle.Fullt.status, 'full');
  });

  test('flere nettsteder: hvert arrangement har sitt nettsted, og lenkene bygges derfra', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, SITE_COM_DOMAIN: COM, SITE_COM_LANG: 'en', OVERVIEW_KEY: KEY });
    const en = await createEvent(app, { title: 'Party', site: 'com' });
    const res = await overview(app, bearer(KEY));
    assert.deepEqual(res.json.sites.map((s) => s.id), ['main', 'com']);
    assert.equal(res.json.events[0].site, 'com');
    assert.equal(res.json.events[0].url, `https://${COM}/${en.slug}`);
  });

  test('uten billetter er innsjekking ikke med (null)', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, OVERVIEW_KEY: KEY });
    await createEvent(app, { features: { tickets: false } });
    assert.equal((await overview(app, bearer(KEY))).json.events[0].checkedIn, null);
  });
});

// Som i produksjon: eget admin-vertsnavn, LAN-port og Cloudflare Access som avviser alle.
describe('med ADMIN_HOST, LAN-port og Cloudflare Access', () => {
  const servers = [];
  after(() => servers.forEach((s) => s.close()));
  const listen = async (server) => {
    server.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    servers.push(server);
    return server.address().port;
  };

  async function start(verifier) {
    const config = loadConfig({ DOMAIN: MAIN, ADMIN_HOST: ADMIN, LAN_PORT: '3001', OVERVIEW_KEY: KEY });
    const repo = createRepository(openDatabase(':memory:'));
    insertEvent(repo, { slug: 'abcdefghjkmn', title: 'Sommerfest' });
    const app = createApp({
      repo, config, mailer: { send: async () => ({ id: 'test' }) }, logger: { log() {}, error() {}, warn() {} },
      accessVerifier: verifier ?? (async () => { throw new AccessError('mangler token'); }),
    });
    const port = await listen(http.createServer(app));
    const lanPort = await listen(http.createServer(app.lanHandler));
    return { pub: (o) => request(port, o), lan: (o) => request(lanPort, o) };
  }

  test('på de offentlige domenene finnes oversikten ikke – heller ikke med riktig nøkkel', async () => {
    const { pub } = await start();
    expectNaked404(await pub({ path: '/admin', headers: onHost(MAIN) }), 'siden');
    expectNaked404(await pub({ path: '/api/admin/overview', headers: { ...onHost(MAIN), ...bearer(KEY) } }), 'API-et');
  });

  test('på admin-vertsnavnet virker den med nøkkelen – Access er ikke nok alene, og trengs ikke', async () => {
    const { pub } = await start();
    assert.equal((await pub({ path: '/admin', headers: onHost(ADMIN) })).status, 200);
    const ok = await pub({ path: '/api/admin/overview', headers: { ...onHost(ADMIN), ...bearer(KEY) } });
    assert.equal(ok.status, 200, 'Access avviser alle, men oversikten styres av nøkkelen');
    assert.equal(ok.json.events[0].title, 'Sommerfest');
    assert.equal((await pub({ path: '/api/admin/overview', headers: onHost(ADMIN) })).status, 401);
  });

  test('et gyldig Access-token gir ikke tilgang uten nøkkelen', async () => {
    const { pub } = await start(async () => ({ email: 'drift@example.no' }));
    const res = await pub({ path: '/api/admin/overview', headers: { ...onHost(ADMIN), 'cf-access-jwt-assertion': 'gyldig' } });
    assert.equal(res.status, 401);
  });

  test('på LAN-porten kreves også nøkkelen', async () => {
    const { lan } = await start();
    assert.equal((await lan({ path: '/admin' })).status, 200);
    assert.equal((await lan({ path: '/api/admin/overview' })).status, 401, 'LAN gir ikke tilgang alene');
    assert.equal((await lan({ path: '/api/admin/overview', headers: bearer(KEY) })).status, 200);
  });
});

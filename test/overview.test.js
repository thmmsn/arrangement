import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessError } from '../src/cfAccess.js';
import { loadConfig } from '../src/config.js';
import { createRepository, openDatabase } from '../src/db.js';
import { createEvent, register, request, startApp } from './helpers.js';

// Oversikten over alle arrangementer: /admin (siden) og GET /api/admin/overview (dataene). Eieren velger
// hvordan den beskyttes (OVERVIEW_AUTH): key, password, access, lan eller none – én av dem holder. Uten
// OVERVIEW_AUTH brukes det som er satt opp (OVERVIEW_KEY og/eller OVERVIEW_PASSWORD). Med ADMIN_HOST finnes
// oversikten bare der (og på LAN-porten). Uten noen valgt måte finnes den ikke.

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

  test('en kort nøkkel er eierens valg: den virker, og loggen gir bare et råd', async () => {
    const config = loadConfig({ DOMAIN: MAIN, OVERVIEW_KEY: 'kort' });
    assert.deepEqual(config.overview.methods, ['key']);
    assert.ok(config.warnings.some((w) => w.startsWith('OVERVIEW_KEY er bare 4 tegn')), config.warnings.join('\n'));
    const app = await startApp({ DOMAIN: MAIN, OVERVIEW_KEY: 'kort' });
    assert.equal((await overview(app, bearer('kort'))).status, 200);
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
      assert.equal(res.json.error, 'Ingen tilgang til oversikten.', label);
      // Siden får vite hvilke måter som finnes, så den kan vise riktig innlogging.
      assert.deepEqual(res.json.login, { key: true, password: false, user: false, access: false, lan: false }, label);
      assert.equal(res.headers['cache-control'], 'no-store', label);
    }
    const ok = await overview(app, bearer(KEY));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.via, 'key');
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

  async function start(verifier, env = {}) {
    const config = loadConfig({ DOMAIN: MAIN, ADMIN_HOST: ADMIN, LAN_PORT: '3001', OVERVIEW_KEY: KEY, ...env });
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

  test('OVERVIEW_AUTH=none gjelder bare der oversikten finnes: de offentlige domenene gir fortsatt 404', async () => {
    const { pub } = await start(null, { OVERVIEW_AUTH: 'none' });
    expectNaked404(await pub({ path: '/api/admin/overview', headers: onHost(MAIN) }), 'offentlig domene');
    const open = await pub({ path: '/api/admin/overview', headers: onHost(ADMIN) });
    assert.equal(open.status, 200);
    assert.equal(open.json.via, 'none');
  });

  test('OVERVIEW_AUTH=lan: LAN-porten slipper inn uten nøkkel, PORT gjør det ikke', async () => {
    const { pub, lan } = await start(null, { OVERVIEW_AUTH: 'lan' });
    const viaLan = await lan({ path: '/api/admin/overview' });
    assert.equal(viaLan.status, 200);
    assert.equal(viaLan.json.via, 'lan');
    const viaPort = await pub({ path: '/api/admin/overview', headers: { ...onHost(ADMIN), ...bearer(KEY) } });
    assert.equal(viaPort.status, 401, 'nøkkelen er ikke valgt, så den gir ikke tilgang');
    assert.deepEqual(viaPort.json.login, { key: false, password: false, user: false, access: false, lan: true });
  });

  test('OVERVIEW_AUTH=access: et gyldig Access-token slipper inn, uten nøkkel', async () => {
    const env = { OVERVIEW_AUTH: 'access', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud' };
    const { pub } = await start(async (token) => {
      if (token !== 'gyldig') throw new AccessError('ugyldig');
      return { email: 'drift@example.no' };
    }, env);
    const ok = await pub({ path: '/api/admin/overview', headers: { ...onHost(ADMIN), 'cf-access-jwt-assertion': 'gyldig' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.via, 'access');
    const bad = await pub({ path: '/api/admin/overview', headers: { ...onHost(ADMIN), 'cf-access-jwt-assertion': 'falsk' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.login.access, true);
  });

  test('på LAN-porten kreves også nøkkelen', async () => {
    const { lan } = await start();
    assert.equal((await lan({ path: '/admin' })).status, 200);
    assert.equal((await lan({ path: '/api/admin/overview' })).status, 401, 'LAN gir ikke tilgang alene');
    assert.equal((await lan({ path: '/api/admin/overview', headers: bearer(KEY) })).status, 200);
  });
});

describe('brukernavn og passord (OVERVIEW_AUTH=password)', () => {
  const PASSWORD = 'riktig hest batteri stift';
  const ENV = { DOMAIN: MAIN, OVERVIEW_USER: 'drift', OVERVIEW_PASSWORD: PASSWORD };
  const login = (app, body, headers = {}) => app.request({ method: 'POST', path: '/api/admin/overview/login', headers, body });
  const cookieOf = (res) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ov='));

  test('uten OVERVIEW_AUTH velges passord fordi OVERVIEW_PASSWORD er satt', () => {
    assert.deepEqual(loadConfig(ENV).overview.methods, ['password']);
    assert.deepEqual(loadConfig({ ...ENV, OVERVIEW_KEY: KEY }).overview.methods, ['key', 'password']);
  });

  test('innlogging gir en informasjonskapsel som bare sendes til admin-API-et', async () => {
    const app = await startApp(ENV);
    const denied = await overview(app);
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.json.login, { key: false, password: true, user: true, access: false, lan: false });

    const wrong = await login(app, { username: 'drift', password: 'feil' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'Feil brukernavn eller passord.');
    assert.equal(cookieOf(wrong), undefined);
    assert.equal((await login(app, { username: 'annen', password: PASSWORD })).status, 401, 'feil brukernavn');

    const ok = await login(app, { username: ' drift ', password: PASSWORD });
    assert.equal(ok.status, 200);
    const cookie = cookieOf(ok);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/admin;/, 'oversikten og arrangementenes admin-API – ikke sidene');
    assert.match(cookie, /Max-Age=2592000/, '30 dager');
    assert.match(cookie, /Secure/, 'hovednettstedet er på https');
    assert.ok(!cookie.includes(PASSWORD) && !cookie.includes(encodeURIComponent(PASSWORD)), 'passordet står ikke i informasjonskapselen');

    const session = { cookie: cookie.split(';')[0] };
    const res = await overview(app, session);
    assert.equal(res.status, 200);
    assert.equal(res.json.via, 'password');
    assert.equal((await overview(app, { cookie: 'ov=forfalsket' })).status, 401);

    const out = await app.request({ method: 'POST', path: '/api/admin/overview/logout' });
    assert.equal(out.status, 200);
    // Begge stiene slettes: /api/admin, og /api/admin/overview fra før 2026.10.8.5.
    const cleared = out.headers['set-cookie'].filter((c) => c.startsWith('ov=;'));
    assert.deepEqual(cleared.map((c) => /Path=([^;]+)/.exec(c)[1]).sort(), ['/api/admin', '/api/admin/overview']);
    assert.ok(cleared.every((c) => /Expires=Thu, 01 Jan 1970/.test(c)));
  });

  test('uten OVERVIEW_USER spørres det bare om passordet', async () => {
    const app = await startApp({ DOMAIN: MAIN, OVERVIEW_PASSWORD: PASSWORD });
    assert.equal((await overview(app)).json.login.user, false);
    const wrong = await login(app, { password: 'feil' });
    assert.equal(wrong.json.error, 'Feil passord.');
    assert.equal((await login(app, { username: 'hva som helst', password: PASSWORD })).status, 200, 'brukernavnet ignoreres');
  });

  test('nytt passord logger ut alle: den gamle informasjonskapselen virker ikke lenger', async () => {
    const repo = createRepository(openDatabase(':memory:'));
    const quiet = { log() {}, error() {}, warn() {} };
    const appWith = async (password) => {
      const app = createApp({ repo, config: loadConfig({ ...ENV, OVERVIEW_PASSWORD: password }), mailer: { send: async () => ({}) }, logger: quiet });
      const server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      after(() => server.close());
      return { request: (o) => request(server.address().port, o) };
    };
    const before = await appWith(PASSWORD);
    const cookie = cookieOf(await login(before, { username: 'drift', password: PASSWORD })).split(';')[0];
    assert.equal((await overview(before, { cookie })).status, 200);
    const changed = await appWith('et helt nytt passord');
    assert.equal((await overview(changed, { cookie })).status, 401);
  });

  test('innloggingen må komme fra samme nettsted (Origin)', async () => {
    const app = await startApp(ENV);
    const res = await login(app, { username: 'drift', password: PASSWORD }, { origin: 'https://ond.example.com' });
    assert.equal(res.status, 403);
    assert.equal(cookieOf(res), undefined);
  });

  test('passordet kan ikke prøves i det uendelige: maks 10 forsøk per 15 minutter per IP-adresse', async () => {
    const app = await startApp(ENV);
    for (let i = 1; i <= 10; i++) assert.equal((await login(app, { username: 'drift', password: `feil-${i}` })).status, 401, `forsøk ${i}`);
    assert.equal((await login(app, { username: 'drift', password: PASSWORD })).status, 429, 'også riktig passord stoppes nå');
  });

  test('innlogging og utlogging finnes bare når passord er valgt', async () => {
    const app = await startApp({ DOMAIN: MAIN, OVERVIEW_KEY: KEY, OVERVIEW_PASSWORD: PASSWORD, OVERVIEW_AUTH: 'key' });
    expectNaked404(await login(app, { password: PASSWORD }), 'login');
    expectNaked404(await app.request({ method: 'POST', path: '/api/admin/overview/logout' }), 'logout');
  });

  test('flere valgte måter: nøkkelen og passordet virker hver for seg', async () => {
    const app = await startApp({ ...ENV, OVERVIEW_KEY: KEY });
    assert.equal((await overview(app, bearer(KEY))).json.via, 'key');
    const cookie = cookieOf(await login(app, { username: 'drift', password: PASSWORD })).split(';')[0];
    assert.equal((await overview(app, { cookie })).json.via, 'password');
  });
});

describe('OVERVIEW_AUTH i konfigurasjonen', () => {
  test('det som ikke kan virke, ignoreres med en advarsel som sier hvorfor', () => {
    const config = loadConfig({ DOMAIN: MAIN, OVERVIEW_AUTH: 'key, password, access, lan, foo' });
    assert.deepEqual(config.overview.methods, []);
    for (const start of [
      'OVERVIEW_AUTH: «key» ignoreres – OVERVIEW_KEY er ikke satt.',
      'OVERVIEW_AUTH: «password» ignoreres – OVERVIEW_PASSWORD er ikke satt.',
      'OVERVIEW_AUTH: «access» ignoreres – CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD er ikke satt.',
      'OVERVIEW_AUTH: «lan» ignoreres – LAN_PORT er ikke satt.',
      'OVERVIEW_AUTH: «foo» er ukjent',
    ]) assert.ok(config.warnings.some((w) => w.startsWith(start)), start);
  });

  test('none er lovlig, men loggen sier tydelig hva det betyr', () => {
    const config = loadConfig({ DOMAIN: MAIN, OVERVIEW_AUTH: 'none' });
    assert.deepEqual(config.overview.methods, ['none']);
    assert.ok(config.warnings.some((w) => w.includes('uten innlogging')));
  });

  test('et kort passord gir et råd, ikke en avvisning', () => {
    const config = loadConfig({ DOMAIN: MAIN, OVERVIEW_PASSWORD: 'abc' });
    assert.deepEqual(config.overview.methods, ['password']);
    assert.ok(config.warnings.some((w) => w.startsWith('OVERVIEW_PASSWORD er bare 3 tegn')));
  });
});

// «Administrer» i oversikten: tilgangen til oversikten gir også tilgang til hvert arrangements admin-side,
// fordi admin-nøklene bare lagres som hash og lenkene ikke kan lages på nytt.
describe('«Administrer»: oversikts-tilgangen åpner admin-siden for hvert arrangement', () => {
  const PASSWORD = 'riktig hest batteri stift';

  test('med oversiktsnøkkelen: hele admin-API-et for alle arrangementene', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, OVERVIEW_KEY: KEY });
    const event = await createEvent(app, { title: 'Julebord' });
    await register(app, event.slug, { name: 'Ola Gjest', email: 'ola.gjest@example.com' });

    const view = await app.request({ path: `/api/admin/events/${event.slug}`, headers: bearer(KEY) });
    assert.equal(view.status, 200);
    assert.equal(view.json.access, 'overview');
    assert.equal(view.json.registrations[0].name, 'Ola Gjest');
    // Med arrangementets egen nøkkel som før – og siden vet forskjellen.
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}`, headers: bearer(event.adminKey) })).json.access, 'event');

    // Rutene under (requireEventAdmin) godtar også oversikts-tilgangen: CSV, oppsett og sletting.
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}/registrations.csv`, headers: bearer(KEY) })).status, 200);
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}/config`, headers: bearer(KEY) })).status, 200);
    const id = view.json.registrations[0].id;
    assert.equal((await app.request({ method: 'POST', path: `/api/admin/events/${event.slug}/registrations/${id}/checkin`, headers: bearer(KEY) })).status, 200);
    assert.equal((await app.request({ method: 'DELETE', path: `/api/admin/events/${event.slug}`, headers: bearer(KEY) })).status, 200);
    expectNaked404(await app.request({ path: `/api/admin/events/${event.slug}`, headers: bearer(KEY) }), 'slettet');
  });

  test('uten tilgang: 401 som før', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, OVERVIEW_KEY: KEY });
    const event = await createEvent(app);
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}` })).status, 401);
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}`, headers: bearer('feil') })).status, 401);
  });

  test('uten oversikt (ingen OVERVIEW_AUTH) gir ingenting annet enn arrangementets nøkkel tilgang', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN });
    const event = await createEvent(app);
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}`, headers: bearer(KEY) })).status, 401);
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}`, headers: bearer(event.adminKey) })).status, 200);
  });

  test('med passord: informasjonskapselen fra innloggingen virker også på admin-siden', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, OVERVIEW_PASSWORD: PASSWORD });
    const event = await createEvent(app);
    const loggedIn = await app.request({ method: 'POST', path: '/api/admin/overview/login', body: { password: PASSWORD } });
    const cookie = loggedIn.headers['set-cookie'].find((c) => c.startsWith('ov=')).split(';')[0];
    const res = await app.request({ path: `/api/admin/events/${event.slug}`, headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.json.access, 'overview');
  });

  test('bare der oversikten finnes: med ADMIN_HOST gir oversikts-tilgangen ingenting på de offentlige domenene', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, ADMIN_HOST: ADMIN, OVERVIEW_KEY: KEY });
    const event = await createEvent(app, {}, onHost(ADMIN));
    const onAdmin = await app.request({ path: `/api/admin/events/${event.slug}`, headers: { ...onHost(ADMIN), ...bearer(KEY) } });
    assert.equal(onAdmin.status, 200);
    const onPublic = await app.request({ path: `/api/admin/events/${event.slug}`, headers: { ...onHost(MAIN), ...bearer(KEY) } });
    assert.equal(onPublic.status, 401, 'arrangementets egen nøkkel kreves der');
    // Arrangørens egen lenke virker som før, også på det offentlige domenet.
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}`, headers: { ...onHost(MAIN), ...bearer(event.adminKey) } })).status, 200);
  });

  test('OVERVIEW_AUTH=none: admin-sidene er åpne der oversikten finnes – eierens valg', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, ADMIN_HOST: ADMIN, OVERVIEW_AUTH: 'none' });
    const event = await createEvent(app, {}, onHost(ADMIN));
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}`, headers: onHost(ADMIN) })).status, 200);
    assert.equal((await app.request({ path: `/api/admin/events/${event.slug}`, headers: onHost(MAIN) })).status, 401);
  });
});

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { after, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createAccessVerifier } from '../src/cfAccess.js';
import { createRepository, openDatabase } from '../src/db.js';

// Tester admin-porten: eget admin-vertsnavn (ADMIN_HOST) og verifisering av Cloudflare Access-tokenet.

const TEAM = 'mittteam.cloudflareaccess.com';
const AUD = 'aud-tag-for-admin-appen';
const servers = [];
after(() => servers.forEach((s) => s.close()));

async function start(configOverrides = {}, deps = {}) {
  const config = {
    baseUrl: 'https://events.example.com',
    adminNoAuth: false,
    timeZone: 'Europe/Oslo',
    trustProxy: true, // Verste tilfelle: X-Forwarded-Host skal likevel ikke kunne lure admin-porten.
    rateLimits: { create: { windowMs: 60_000, max: 1000 } },
    ...configOverrides,
  };
  const app = createApp({ repo: createRepository(openDatabase(':memory:')), mailer: { send: async () => ({}) }, config, logger: { log() {}, error() {} }, ...deps });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return server.address().port;
}

// Node sin fetch lar oss ikke sette Host-headeren, så vi bruker http.request direkte.
function request(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      port, method, path,
      headers: { ...(data && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* HTML */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const eventBody = {
  title: 'Admin-test',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  organizerName: 'Kari',
  organizerEmail: 'kari@example.com',
};

// ---------- Falske Cloudflare Access-nøkler og -token ----------

function keyPair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function makeToken(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: `https://${TEAM}`, aud: [AUD], email: 'admin@example.com', iat: now, nbf: now, exp: now + 3600, ...claims,
  })).toString('base64url');
  const signature = header.alg === 'none' ? '' : sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url');
  return `${h}.${p}.${signature}`;
}

function fakeCerts(...keys) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }));
  };
  return { fetchImpl, calls: () => calls };
}

// ---------- Eget admin-vertsnavn ----------

describe('ADMIN_HOST: admin bare på eget vertsnavn', () => {
  const ADMIN = 'arrangement-admin.example.com';

  test('admin-sider og admin-API finnes ikke på det offentlige domenet', async () => {
    const port = await start({ adminHost: ADMIN, adminNoAuth: true });
    const pub = { host: 'events.example.com' };

    assert.equal((await request(port, { path: '/admin/ny', headers: pub })).status, 404);
    assert.equal((await request(port, { path: '/api/admin/config', headers: pub })).status, 404);
    const create = await request(port, { method: 'POST', path: '/api/admin/events', headers: pub, body: eventBody });
    assert.equal(create.status, 404);

    // X-Forwarded-Host kan klienten sette selv – det skal ikke åpne admin på det offentlige domenet.
    const spoof = await request(port, { path: '/api/admin/config', headers: { ...pub, 'x-forwarded-host': ADMIN } });
    assert.equal(spoof.status, 404);
  });

  test('oppretting på admin-vertsnavnet; admin-lenken peker til arrangementets eget domene', async () => {
    const port = await start({ adminHost: ADMIN, adminNoAuth: true });
    const adm = { host: ADMIN };
    const pub = { host: 'events.example.com' };

    assert.equal((await request(port, { path: '/admin/ny', headers: adm })).status, 200);
    const create = await request(port, { method: 'POST', path: '/api/admin/events', headers: adm, body: eventBody });
    assert.equal(create.status, 201);
    const { slug, adminKey } = create.json;
    // Samme hash overalt: /<hash>, /admin/<hash>#<nøkkel> og /dorvakt/<hash>#<nøkkel> på samme domene.
    assert.equal(create.json.adminUrl, `https://events.example.com/admin/${slug}#${adminKey}`);
    assert.equal(create.json.eventUrl, `https://events.example.com/${slug}`);
    assert.match(create.json.scannerUrl, new RegExp(`^https://events\\.example\\.com/dorvakt/${slug}#[\\w-]{22}$`));

    // Den offentlige siden og admin-siden virker på det offentlige domenet – admin med nøkkelen.
    assert.equal((await request(port, { path: `/${slug}`, headers: pub })).status, 200);
    assert.equal((await request(port, { path: `/admin/${slug}`, headers: pub })).status, 200);
    const auth = { authorization: `Bearer ${adminKey}` };
    assert.equal((await request(port, { path: `/api/admin/events/${slug}`, headers: { ...pub, ...auth } })).status, 200);
    assert.equal((await request(port, { path: `/api/admin/events/${slug}`, headers: pub })).status, 401);

    // Admin-lenker sendt ut før endringen (til admin-vertsnavnet) virker fortsatt.
    assert.equal((await request(port, { path: `/admin/${slug}`, headers: adm })).status, 200);
    assert.equal((await request(port, { path: `/api/admin/events/${slug}`, headers: { ...adm, ...auth } })).status, 200);

    // Gamle admin-lenker (/<hash>/admin) sendes videre til /admin/<hash> på samme domene.
    const legacy = await request(port, { path: `/${slug}/admin`, headers: pub });
    assert.equal(legacy.status, 301);
    assert.equal(legacy.headers.location, `/admin/${slug}`);
  });

  test('admin kan ikke nås med store bokstaver (forbi en Access-regel på stien «admin»)', async () => {
    const port = await start({ adminNoAuth: true });
    assert.equal((await request(port, { path: '/admin/ny' })).status, 200);
    for (const path of ['/ADMIN/ny', '/Admin/ny', '/API/ADMIN/config', '/api/Admin/config', '/Api/admin/config']) {
      assert.equal((await request(port, { path })).status, 404, path);
    }
    const create = await request(port, { method: 'POST', path: '/api/ADMIN/events', body: eventBody });
    assert.equal(create.status, 404);
  });

  test('uten ADMIN_HOST sendes gamle admin-lenker til /admin på samme domene – bare for arrangementer som finnes', async () => {
    const port = await start({ adminNoAuth: true });
    const created = await request(port, { method: 'POST', path: '/api/admin/events', body: eventBody });
    const legacy = await request(port, { path: `/${created.json.slug}/admin` });
    assert.equal(legacy.status, 301);
    assert.equal(legacy.headers.location, `/admin/${created.json.slug}`);

    // Ukjente arrangementer og den gamle /ny-adressen avslører ingenting.
    for (const path of ['/abcdefghjkmn/admin', '/ny']) {
      const res = await request(port, { path });
      assert.equal(res.status, 404, path);
      assert.equal(res.text, 'Not Found', path);
    }
  });
});

// ---------- Cloudflare Access ----------

describe('Cloudflare Access-verifisering', () => {
  const key = keyPair('nokkel-1');

  async function startWithAccess(overrides = {}) {
    const certs = fakeCerts(key);
    const accessVerifier = createAccessVerifier({ teamDomain: TEAM, audiences: [AUD], fetchImpl: certs.fetchImpl });
    return start(overrides, { accessVerifier });
  }

  test('admin uten gyldig token avvises – både sider og API', async () => {
    // ADMIN_NO_AUTH skal ikke kunne åpne noe når Access er satt opp.
    const port = await startWithAccess({ adminNoAuth: true });
    assert.equal((await request(port, { path: '/api/admin/config' })).status, 403);
    const page = await request(port, { path: '/admin/ny' });
    assert.equal(page.status, 403);
    assert.match(page.text, /Ingen tilgang/);
    const create = await request(port, { method: 'POST', path: '/api/admin/events', body: eventBody });
    assert.equal(create.status, 403, 'ingen oppretting uten Access-token');
  });

  test('gyldig token slipper gjennom – fra header eller cookie', async () => {
    const port = await startWithAccess();
    const token = makeToken(key);
    const viaHeader = await request(port, { path: '/api/admin/config', headers: { 'cf-access-jwt-assertion': token } });
    assert.equal(viaHeader.status, 200);
    assert.equal(viaHeader.json.accessEmail, 'admin@example.com');
    const viaCookie = await request(port, { path: '/admin/ny', headers: { cookie: `annet=1; CF_Authorization=${token}` } });
    assert.equal(viaCookie.status, 200);
  });

  test('med gyldig Access-token kan arrangementer opprettes', async () => {
    const port = await startWithAccess();
    const headers = { 'cf-access-jwt-assertion': makeToken(key) };
    const res = await request(port, { method: 'POST', path: '/api/admin/events', headers, body: eventBody });
    assert.equal(res.status, 201);
    // Admin-nøkkelen per arrangement kreves fortsatt i tillegg.
    assert.equal((await request(port, { path: `/api/admin/events/${res.json.slug}`, headers })).status, 401);
    const withKey = await request(port, { path: `/api/admin/events/${res.json.slug}`, headers: { ...headers, authorization: `Bearer ${res.json.adminKey}` } });
    assert.equal(withKey.status, 200);
  });

  test('ugyldige token avvises', async () => {
    const port = await startWithAccess();
    const forged = keyPair('nokkel-1'); // Samme kid, men en annen privatnøkkel.
    const now = Math.floor(Date.now() / 1000);
    const cases = {
      'utløpt': makeToken(key, { exp: now - 3600 }),
      'feil applikasjon (aud)': makeToken(key, { aud: ['en-annen-app'] }),
      'feil utsteder': makeToken(key, { iss: 'https://annet.cloudflareaccess.com' }),
      'ikke gyldig ennå': makeToken(key, { nbf: now + 3600 }),
      'forfalsket signatur': makeToken(forged),
      'alg none': makeToken(key, {}, { alg: 'none' }),
      'søppel': 'ikke.et.token',
    };
    for (const [name, token] of Object.entries(cases)) {
      const res = await request(port, { path: '/api/admin/config', headers: { 'cf-access-jwt-assertion': token } });
      assert.equal(res.status, 403, name);
    }
  });

  test('offentlige sider og påmelding krever ikke Access', async () => {
    const port = await startWithAccess();
    const created = await request(port, { method: 'POST', path: '/api/admin/events', headers: { 'cf-access-jwt-assertion': makeToken(key) }, body: eventBody });
    const { slug } = created.json;
    assert.equal((await request(port, { path: `/${slug}` })).status, 200);
    assert.equal((await request(port, { path: `/api/events/${slug}` })).status, 200);
    const reg = await request(port, { method: 'POST', path: `/api/events/${slug}/registrations`, body: { name: 'Ola', email: 'ola@example.com' } });
    assert.equal(reg.status, 201);
  });

  test('bare ett av CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD gir feil ved oppstart', () => {
    const base = { baseUrl: 'https://x', timeZone: 'Europe/Oslo' };
    const repo = createRepository(openDatabase(':memory:'));
    assert.throws(() => createApp({ repo, mailer: {}, config: { ...base, cfAccessTeamDomain: TEAM, cfAccessAudiences: [] } }), /må settes sammen/);
    assert.throws(() => createApp({ repo, mailer: {}, config: { ...base, cfAccessTeamDomain: '', cfAccessAudiences: [AUD] } }), /må settes sammen/);
  });
});

describe('nøkkelhåndtering i Access-verifiseringen', () => {
  test('nøklene mellomlagres, og en ny nøkkel-id hentes når Cloudflare roterer', async () => {
    const oldKey = keyPair('gammel');
    const newKey = keyPair('ny');
    let published = [oldKey];
    let calls = 0;
    let clock = Date.now();
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ keys: published.map((k) => k.jwk) }));
    };
    const verify = createAccessVerifier({ teamDomain: TEAM, audiences: [AUD], fetchImpl, now: () => clock });

    await verify(makeToken(oldKey));
    await verify(makeToken(oldKey));
    assert.equal(calls, 1, 'nøklene hentes bare én gang');

    // Cloudflare roterer: den nye nøkkelen er ukjent, så nøklene hentes på nytt (etter minst ett minutt).
    published = [oldKey, newKey];
    clock += 2 * 60_000;
    const payload = await verify(makeToken(newKey));
    assert.equal(payload.email, 'admin@example.com');
    assert.equal(calls, 2);

    // En ukjent nøkkel-id kan ikke brukes til å hamre løs på Cloudflare: maks én ny henting i minuttet.
    await assert.rejects(verify(makeToken(keyPair('ukjent'))));
    assert.equal(calls, 2);
  });
});

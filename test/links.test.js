import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AccessError } from '../src/cfAccess.js';
import { loadConfig } from '../src/config.js';
import { readVersion } from '../src/version.js';
import { cookieHeader, createEvent, register, startApp } from './helpers.js';

// Samme hash overalt, på arrangementets eget domene:
//   /<hash>                   påmelding
//   /admin/<hash>#<nøkkel>    administrasjon – bare admin-nøkkelen kreves (ikke Cloudflare Access)
//   /dorvakt/<hash>#<nøkkel>  dørvakt
// og /admin/ny#<nøkkel> (CREATE_KEY) for å opprette arrangementer uten Cloudflare Access.
//
// Lenker som ble sendt ut før endringen – /<hash>/skanner#<nøkkel> og admin-lenker til ADMIN_HOST – skal
// virke som før, så arrangementer som allerede er i gang ikke merker noe.

const MAIN = 'arrangement.example.no';
const COM = 'events.example.com';
const ADMIN = 'arrangement-admin.example.no';
const SITES = { DOMAIN: MAIN, SITE_COM_DOMAIN: COM, SITE_COM_LANG: 'en' };
const CREATE_KEY = 'k'.repeat(20) + 'Opprett_Nokkel-123';
const onHost = (host) => ({ host });
const bearer = (key) => ({ authorization: `Bearer ${key}` });

// Som i produksjon: Access er satt opp og slipper bare inn tokenet «gyldig». Teller hvor ofte Access spørres.
function fakeAccess() {
  let calls = 0;
  const verifier = async (token) => {
    calls += 1;
    if (token !== 'gyldig') throw new AccessError('ugyldig');
    return { email: 'drift@example.no' };
  };
  return { verifier, calls: () => calls };
}
const viaAccess = { 'cf-access-jwt-assertion': 'gyldig' };

const expectNaked404 = (res, label) => {
  assert.equal(res.status, 404, label);
  assert.equal(res.text, 'Not Found', label);
};

describe('dørvaktlenken: /dorvakt/<hash>#<nøkkel>', () => {
  test('nye lenker har formen /dorvakt/<hash>#<nøkkel>, og siden er skannersiden', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const { slug, scannerUrl } = await createEvent(app);
    const url = new URL(scannerUrl);
    assert.equal(url.pathname, `/dorvakt/${slug}`);
    assert.match(url.hash, /^#[\w-]{22}$/);

    const page = await app.request({ path: `/dorvakt/${slug}` });
    assert.equal(page.status, 200);
    assert.match(page.text, /<script type="module" src="\/assets\/js\/scanner\.js\?v=/);
    assert.equal(page.headers['cache-control'], 'no-store');
    // Store bokstaver i hashen går også (som for /<hash>).
    assert.equal((await app.request({ path: `/dorvakt/${slug.toUpperCase()}` })).status, 200);
  });

  test('gamle lenker (/<hash>/skanner) gir den samme siden direkte, og nøkkelen er den samme', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const { slug, scannerUrl } = await createEvent(app);
    const key = new URL(scannerUrl).hash.slice(1);

    // Ingen videresending: en dørvakt som laster den gamle siden på nytt midt i arrangementet, blir der.
    const old = await app.request({ path: `/${slug}/skanner` });
    assert.equal(old.status, 200);
    assert.equal(old.text, (await app.request({ path: `/dorvakt/${slug}` })).text);

    // Nøkkelen i den nye lenken er den samme som i en gammel lenke: den er avledet av arrangementet,
    // ikke av adressen. Innlogging og informasjonskapsel virker uansett hvilken adresse siden har.
    await register(app, slug);
    const login = await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/login`, body: { key, name: 'Per' } });
    assert.equal(login.status, 200);
    const cookie = cookieHeader(login);
    const status = await app.request({ path: `/api/events/${slug}/scanner`, headers: { cookie } });
    assert.equal(status.status, 200);
    assert.equal(status.json.stats.total, 1);
  });

  test('ukjente arrangementer, arrangementer uten billetter og feil domene', async () => {
    const app = await startApp({ ...SITES, ADMIN_NO_AUTH: 'true' });
    expectNaked404(await app.request({ path: '/dorvakt/abcdefghjkmn', headers: onHost(MAIN) }), 'ukjent');
    expectNaked404(await app.request({ path: '/dorvakt', headers: onHost(MAIN) }), 'uten hash');
    expectNaked404(await app.request({ path: '/dorvakt/', headers: onHost(MAIN) }), 'tom hash');

    const off = await createEvent(app, { features: { tickets: false } });
    assert.equal(off.scannerUrl, null);
    expectNaked404(await app.request({ path: `/dorvakt/${off.slug}`, headers: onHost(MAIN) }), 'uten billetter');

    // Et .com-arrangement åpnet på .no: 301 til .com, med samme sti (nettleseren tar med #nøkkelen).
    const en = await createEvent(app, { site: 'com' });
    assert.match(en.scannerUrl, new RegExp(`^https://${COM}/dorvakt/${en.slug}#`));
    const wrong = await app.request({ path: `/dorvakt/${en.slug}`, headers: onHost(MAIN) });
    assert.equal(wrong.status, 301);
    assert.equal(wrong.headers.location, `https://${COM}/dorvakt/${en.slug}`);
  });

  test('ny dørvaktlenke har også den nye formen, og den gamle nøkkelen slutter å virke', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const { slug, adminKey, scannerUrl } = await createEvent(app);
    const rotated = await app.request({ method: 'POST', path: `/api/admin/events/${slug}/scanner/rotate`, headers: bearer(adminKey) });
    assert.match(rotated.json.scannerUrl, new RegExp(`/dorvakt/${slug}#[\\w-]{22}$`));
    assert.notEqual(rotated.json.scannerUrl, scannerUrl);
    const oldKey = new URL(scannerUrl).hash.slice(1);
    const login = await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/login`, body: { key: oldKey } });
    assert.equal(login.status, 401);
  });
});

describe('administrasjon av ett arrangement: bare admin-nøkkelen', () => {
  // Produksjonsoppsett: to nettsteder, eget admin-vertsnavn og Cloudflare Access.
  async function production() {
    const access = fakeAccess();
    const app = await startApp({ ...SITES, ADMIN_HOST: ADMIN }, { accessVerifier: access.verifier, placeSearch: { search: async () => [] } });
    const event = await createEvent(app, { site: 'com' }, { ...onHost(ADMIN), ...viaAccess });
    return { app, access, event };
  }

  test('admin-lenken ligger på arrangementets domene og virker uten Cloudflare Access', async () => {
    const { app, access, event } = await production();
    const { slug, adminKey } = event;
    assert.equal(event.adminUrl, `https://${COM}/admin/${slug}#${adminKey}`);
    const before = access.calls();

    const com = onHost(COM);
    assert.equal((await app.request({ path: `/admin/${slug}`, headers: com })).status, 200);
    assert.equal((await app.request({ path: `/admin/${slug}/avlys`, headers: com })).status, 200);
    const data = await app.request({ path: `/api/admin/events/${slug}`, headers: { ...com, ...bearer(adminKey) } });
    assert.equal(data.status, 200);
    assert.equal(data.json.event.scannerUrl.startsWith(`https://${COM}/dorvakt/${slug}#`), true);

    // Skjemaet på admin-siden: oppsett og stedsoppslag med admin-nøkkelen, uten opprettingstilgang.
    const config = await app.request({ path: `/api/admin/events/${slug}/config`, headers: { ...com, ...bearer(adminKey) } });
    assert.equal(config.status, 200);
    assert.deepEqual(config.json.sites.map((s) => s.id), ['main', 'com']);
    const places = await app.request({ path: `/api/admin/events/${slug}/places?q=Oslo`, headers: { ...com, ...bearer(adminKey) } });
    assert.equal(places.status, 200);

    // Endringer, CSV og innsjekking virker også.
    const update = await app.request({
      method: 'PUT', path: `/api/admin/events/${slug}`, headers: { ...com, ...bearer(adminKey) },
      body: { ...data.json.event, title: 'Nytt navn' },
    });
    assert.equal(update.status, 200, update.text);
    assert.equal(update.json.event.title, 'Nytt navn');
    const csv = await app.request({ path: `/api/admin/events/${slug}/registrations.csv`, headers: { ...com, ...bearer(adminKey) } });
    assert.equal(csv.status, 200);

    assert.equal(access.calls(), before, 'Access spørres ikke når det ikke er noe token');
  });

  test('uten riktig nøkkel: 401 – og et ukjent arrangement røper ingenting', async () => {
    const { app, event } = await production();
    const { slug, adminKey } = event;
    for (const headers of [{}, bearer('feil'), bearer(`${adminKey}x`), { authorization: adminKey }, viaAccess]) {
      for (const path of [`/api/admin/events/${slug}`, `/api/admin/events/${slug}/config`, `/api/admin/events/${slug}/places?q=Oslo`]) {
        const res = await app.request({ path, headers: { ...onHost(COM), ...headers } });
        assert.equal(res.status, 401, `${path} ${JSON.stringify(headers)}`);
      }
    }
    const del = await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}`, headers: { ...onHost(COM), ...viaAccess } });
    assert.equal(del.status, 401, 'Access alene gir ikke tilgang til et arrangement');
    // Nøkkelen sjekkes før rutene, så heller ikke en ukjent adresse under arrangementet svarer uten den.
    const unknown = await app.request({ path: `/api/admin/events/${slug}/finnes-ikke`, headers: onHost(COM) });
    assert.equal(unknown.status, 401);

    // Ukjent arrangement: det samme nakne svaret som alt annet – også med en gyldig nøkkel til et annet.
    for (const path of ['/admin/abcdefghjkmn', '/admin/abcdefghjkmn/avlys', '/api/admin/events/abcdefghjkmn',
      '/api/admin/events/abcdefghjkmn/config', '/api/admin/events/abcdefghjkmn/registrations.csv']) {
      expectNaked404(await app.request({ path, headers: { ...onHost(COM), ...bearer(adminKey) } }), path);
    }
    // Ugyldig JSON til et ukjent arrangement gir heller ikke en JSON-feil.
    const invalid = await app.request({ method: 'PUT', path: '/api/admin/events/abcdefghjkmn', raw: '{ugyldig', headers: onHost(COM) });
    expectNaked404(invalid, 'ugyldig JSON');
  });

  test('admin-lenker sendt ut før endringen (til ADMIN_HOST) virker fortsatt', async () => {
    const { app, event } = await production();
    const { slug, adminKey } = event;
    const adm = onHost(ADMIN);
    assert.equal((await app.request({ path: `/admin/${slug}`, headers: adm })).status, 200);
    assert.equal((await app.request({ path: `/admin/${slug}/avlys`, headers: adm })).status, 200);
    assert.equal((await app.request({ path: `/api/admin/events/${slug}`, headers: { ...adm, ...bearer(adminKey) } })).status, 200);
    // Også med Access-tokenet som Cloudflare legger på der – det skader ikke.
    assert.equal((await app.request({ path: `/api/admin/events/${slug}`, headers: { ...adm, ...viaAccess, ...bearer(adminKey) } })).status, 200);
  });

  test('innsjekking fra admin: «av» er e-postadressen fra Access når den finnes, ellers tom', async () => {
    const { app, event } = await production();
    const { slug, adminKey } = event;
    await register(app, slug, { guests: ['Kari'], headers: onHost(COM) });
    const { json } = await app.request({ path: `/api/admin/events/${slug}`, headers: { ...onHost(COM), ...bearer(adminKey) } });
    const [ola, kari] = json.registrations;
    const checkin = (id, headers) => app.request({
      method: 'POST', path: `/api/admin/events/${slug}/registrations/${id}/checkin`, headers: { ...onHost(COM), ...bearer(adminKey), ...headers },
    });
    assert.equal((await checkin(ola.id, {})).json.registration.checkedInBy, null);
    assert.equal((await checkin(kari.id, viaAccess)).json.registration.checkedInBy, 'drift@example.no');
    // Et ugyldig Access-token stopper ikke den som har nøkkelen.
    await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}/registrations/${ola.id}/checkin`, headers: { ...onHost(COM), ...bearer(adminKey) } });
    assert.equal((await checkin(ola.id, { 'cf-access-jwt-assertion': 'utlopt' })).status, 200);
  });

  test('oppretting finnes fortsatt bare på ADMIN_HOST – en admin-nøkkel gir ikke rett til å opprette', async () => {
    const { app, event } = await production();
    for (const host of [MAIN, COM]) {
      for (const probe of [
        { path: '/admin' }, { path: '/admin/ny' }, { path: '/api/admin/config' }, { path: '/api/admin/places?q=Oslo' },
        { method: 'POST', path: '/api/admin/events', body: { title: 'x' } },
      ]) {
        const res = await app.request({ ...probe, headers: { ...onHost(host), ...bearer(event.adminKey), ...viaAccess } });
        expectNaked404(res, `${host}${probe.path}`);
      }
    }
    // På admin-vertsnavnet: Access kreves fortsatt for oppretting, og admin-nøkkelen erstatter den ikke.
    const create = await app.request({ method: 'POST', path: '/api/admin/events', headers: { ...onHost(ADMIN), ...bearer(event.adminKey) }, body: { title: 'x' } });
    assert.equal(create.status, 403);
  });
});

describe('opprettingsnøkkelen: /admin/ny#<nøkkel> (CREATE_KEY)', () => {
  test('leses fra miljøet: minst 32 tegn fra A–Z, a–z, 0–9, - og _', () => {
    assert.equal(loadConfig({}).createKey, null);
    assert.equal(loadConfig({ CREATE_KEY: '' }).createKey, null);
    assert.equal(loadConfig({ CREATE_KEY: CREATE_KEY }).createKey, CREATE_KEY);
    assert.equal(loadConfig({ CREATE_KEY: `"${CREATE_KEY}"` }).createKey, CREATE_KEY, 'anførselstegn fjernes');
    assert.equal(loadConfig({ CREATE_KEY: 'a'.repeat(64) }).createKey, 'a'.repeat(64));
    for (const bad of ['kort', 'a'.repeat(31), `${'a'.repeat(32)}#`, `${'a'.repeat(32)} b`, `${'æ'.repeat(40)}`]) {
      const config = loadConfig({ CREATE_KEY: bad });
      assert.equal(config.createKey, null, bad);
      assert.ok(config.warnings.some((w) => w.startsWith('CREATE_KEY ignoreres')), bad);
    }
  });

  test('uten Cloudflare Access: nøkkelen gir rett til å opprette, og ingenting annet gjør det', async () => {
    const app = await startApp({ CREATE_KEY, ADMIN_NO_AUTH: 'true' }, { placeSearch: { search: async () => [] } });

    // Siden vises uten nøkkel (nettleseren sender aldri det som står etter #), men har ingen data.
    assert.equal((await app.request({ path: '/admin/ny' })).status, 200);

    // ADMIN_NO_AUTH har ingen virkning når CREATE_KEY er satt: nøkkelen kreves alltid.
    for (const headers of [{}, bearer('feil'), bearer(`${CREATE_KEY}x`), bearer(CREATE_KEY.slice(0, -1))]) {
      const config = await app.request({ path: '/api/admin/config', headers });
      assert.equal(config.status, 403, JSON.stringify(headers));
      assert.match(config.json.error, /opprettingsnøkkelen/);
      assert.equal((await app.request({ path: '/api/admin/places?q=Oslo', headers })).status, 403);
      const create = await app.request({ method: 'POST', path: '/api/admin/events', headers, body: { title: 'x' } });
      assert.equal(create.status, 403);
    }
    assert.equal(app.sent.length, 0);

    assert.equal((await app.request({ path: '/api/admin/config', headers: bearer(CREATE_KEY) })).status, 200);
    assert.equal((await app.request({ path: '/api/admin/places?q=Oslo', headers: bearer(CREATE_KEY) })).status, 200);
    const created = await createEvent(app, {}, bearer(CREATE_KEY));
    assert.equal(created.adminUrl, `http://localhost:3000/admin/${created.slug}#${created.adminKey}`);
    assert.equal(app.sent.length, 1, 'arrangøren får admin-lenken');

    // Admin-nøkkelen til et arrangement er ikke en opprettingsnøkkel.
    const withAdminKey = await app.request({ method: 'POST', path: '/api/admin/events', headers: bearer(created.adminKey), body: { title: 'x' } });
    assert.equal(withAdminKey.status, 403);
    // Og opprettingsnøkkelen gir ikke tilgang til arrangementer andre har opprettet.
    assert.equal((await app.request({ path: `/api/admin/events/${created.slug}`, headers: bearer(CREATE_KEY) })).status, 401);
  });

  test('med ADMIN_HOST virker nøkkelen bare på admin-vertsnavnet', async () => {
    const app = await startApp({ ...SITES, ADMIN_HOST: ADMIN, CREATE_KEY });
    const pub = await app.request({ method: 'POST', path: '/api/admin/events', headers: { ...onHost(MAIN), ...bearer(CREATE_KEY) }, body: { title: 'x' } });
    expectNaked404(pub, 'offentlig domene');
    const created = await createEvent(app, { site: 'com' }, { ...onHost(ADMIN), ...bearer(CREATE_KEY) });
    assert.equal(created.adminUrl, `https://${COM}/admin/${created.slug}#${created.adminKey}`);
  });

  test('sammen med Cloudflare Access: enten nøkkelen eller Access holder', async () => {
    const access = fakeAccess();
    const app = await startApp({ CREATE_KEY }, { accessVerifier: access.verifier });

    // Siden vises også uten Access-token, fordi nøkkelen kan stå etter # (den sjekkes av API-et).
    assert.equal((await app.request({ path: '/admin/ny' })).status, 200);

    const none = await app.request({ path: '/api/admin/config' });
    assert.equal(none.status, 403);
    assert.match(none.json.error, /opprettingsnøkkelen/);

    const calls = access.calls();
    assert.equal((await app.request({ path: '/api/admin/config', headers: bearer(CREATE_KEY) })).status, 200);
    assert.equal(access.calls(), calls, 'med riktig nøkkel spørres ikke Access');
    await createEvent(app, {}, bearer(CREATE_KEY));

    const viaToken = await app.request({ path: '/api/admin/config', headers: viaAccess });
    assert.equal(viaToken.status, 200);
    assert.equal(viaToken.json.accessEmail, 'drift@example.no');
    await createEvent(app, {}, viaAccess);
  });

  test('uten CREATE_KEY er alt som før: Access-siden avviser uten token', async () => {
    const access = fakeAccess();
    const app = await startApp({}, { accessVerifier: access.verifier });
    const page = await app.request({ path: '/admin/ny' });
    assert.equal(page.status, 403);
    const config = await app.request({ path: '/api/admin/config', headers: bearer(CREATE_KEY) });
    assert.equal(config.status, 403);
    assert.match(config.json.error, /Cloudflare Access/);
  });
});

test('skriptene lastes med versjonsnummeret, så en ny versjon aldri kjører et gammelt skript', async () => {
  const version = readVersion();
  assert.ok(version, 'VERSION finnes');
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const { slug, adminKey } = await createEvent(app);
  const pages = { [`/${slug}`]: 'event', [`/${slug}/avmelding`]: 'cancel', [`/admin/${slug}`]: 'admin', '/admin/ny': 'new', [`/dorvakt/${slug}`]: 'scanner' };
  for (const [path, script] of Object.entries(pages)) {
    const page = await app.request({ path });
    assert.ok(page.text.includes(`<script type="module" src="/assets/js/${script}.js?v=${version}"></script>`), path);
  }
  const reg = await register(app, slug);
  const ticketPage = await app.request({ path: new URL(reg.json.links.tickets).pathname });
  assert.ok(ticketPage.text.includes(`/assets/js/ticket.js?v=${version}"`));
  // Filen selv serveres som før – versjonen i adressen er bare for hurtigbufferen.
  const script = await app.request({ path: `/assets/js/admin.js?v=${version}` });
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /javascript/);
  assert.ok(adminKey);
});

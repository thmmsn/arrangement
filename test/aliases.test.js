import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { AliasError, createRepository, MIGRATIONS, openDatabase } from '../src/db.js';
import { normalizeAlias } from '../src/ids.js';
import { validateAlias, ValidationError } from '../src/validation.js';
import { createEvent, register, startApp } from './helpers.js';

// Alias: lesbare adresser (<domene>/julebord) til et arrangement, i tillegg til hash-en. Arrangøren
// legger dem til og fjerner dem på admin-siden. Hash-lenken er fortsatt hovedlenken.

const MAIN = 'arrangement.example.no';
const COM = 'events.example.com';
// ADMIN_NO_AUTH: testene oppretter arrangementer uten innlogging, som ved lokal utvikling.
const SITES = { ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, SITE_COM_DOMAIN: COM, SITE_COM_LANG: 'en' };
const onHost = (host) => ({ host });
const bearer = (key) => ({ authorization: `Bearer ${key}` });

const addAlias = (app, event, alias, key = event.adminKey) => app.request({
  method: 'POST', path: `/api/admin/events/${event.slug}/aliases`, headers: bearer(key), body: { alias },
});
const removeAlias = (app, event, alias, key = event.adminKey) => app.request({
  method: 'DELETE', path: `/api/admin/events/${event.slug}/aliases/${alias}`, headers: bearer(key),
});
const adminView = (app, event) => app.request({ path: `/api/admin/events/${event.slug}`, headers: bearer(event.adminKey) });

const expectNaked404 = (res, label) => {
  assert.equal(res.status, 404, label);
  assert.equal(res.text, 'Not Found', label);
};

describe('navnet', () => {
  test('normaliseres: små bokstaver, mellomrom og _ blir bindestrek, / foran fjernes', () => {
    assert.equal(normalizeAlias('  Julebord 2026 '), 'julebord-2026');
    assert.equal(normalizeAlias('/sommer_fest'), 'sommer-fest');
    assert.equal(validateAlias('Julebord   2026'), 'julebord-2026');
  });

  test('avvises med en feil på feltet «alias»', () => {
    const errorKey = (input) => {
      try {
        validateAlias(input);
      } catch (err) {
        assert.ok(err instanceof ValidationError);
        return err.errors.alias.key;
      }
      return null;
    };
    assert.equal(errorKey(''), 'aliasRequired');
    assert.equal(errorKey(undefined), 'aliasRequired');
    assert.equal(errorKey('ab'), 'aliasLength');
    assert.equal(errorKey('a'.repeat(61)), 'aliasLength');
    assert.equal(errorKey('a'.repeat(60)), null);
    assert.equal(errorKey('sommerfest-på-hytta'), 'aliasInvalid', 'æ, ø og å blir %C3%A5 o.l. i adressen');
    assert.equal(errorKey('-julebord'), 'aliasInvalid');
    assert.equal(errorKey('julebord-'), 'aliasInvalid');
    assert.equal(errorKey('jule--bord'), 'aliasInvalid');
    assert.equal(errorKey('jule.bord'), 'aliasInvalid');
    assert.equal(errorKey('jule/bord'), 'aliasInvalid');
    for (const reserved of ['admin', 'api', 'assets', 'dorvakt', 'Admin']) assert.equal(errorKey(reserved), 'aliasReserved', reserved);
  });
});

describe('adressen', () => {
  test('viser arrangementssiden direkte – adressen beholdes, delingstaggene peker på hash-lenken', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app, { title: 'Julebord' });
    const added = await addAlias(app, event, 'Julebord 2026');
    assert.equal(added.status, 201);
    assert.equal(added.json.alias, 'julebord-2026');
    assert.deepEqual(added.json.aliases, [{ alias: 'julebord-2026', url: `https://${MAIN}/julebord-2026` }]);

    const page = await app.request({ path: '/julebord-2026', headers: onHost(MAIN) });
    assert.equal(page.status, 200, 'ingen videresending');
    assert.match(page.headers['content-type'], /html/);
    assert.match(page.text, /<meta property="og:title" content="Julebord">/);
    assert.match(page.text, new RegExp(`<meta property="og:url" content="https://${MAIN}/${event.slug}">`));
    // Store bokstaver i adressen går også, som for hash-en.
    assert.equal((await app.request({ path: '/JULEBORD-2026', headers: onHost(MAIN) })).status, 200);
  });

  test('siden henter arrangementet og melder på via aliaset (/api/events/<alias>)', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    await addAlias(app, event, 'sommerfest');

    const info = await app.request({ path: '/api/events/sommerfest', headers: onHost(MAIN) });
    assert.equal(info.status, 200);
    assert.equal(info.json.slug, event.slug, 'hash-en er fortsatt arrangementets id');
    assert.equal(info.json.url, `https://${MAIN}/${event.slug}`, 'hovedlenken er hash-lenken');

    const res = await register(app, 'sommerfest', { headers: onHost(MAIN) });
    assert.equal(res.status, 201);
    assert.equal(app.repo.countRegistrations(app.repo.findEvent(event.slug).id), 1);
    // E-postene lenker til hash-lenken, ikke til aliaset.
    const confirmation = app.sent.find((m) => m.to === 'ola@example.com');
    assert.ok(confirmation.html.includes(`https://${MAIN}/${event.slug}`));
    assert.ok(app.sent.every((m) => !m.html.includes('/sommerfest')));
  });

  test('avmeldingssiden og kalenderfilen virker også under aliaset', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    await addAlias(app, event, 'quiz');
    assert.equal((await app.request({ path: '/quiz/avmelding', headers: onHost(MAIN) })).status, 200);
    const ics = await app.request({ path: '/quiz/kalender.ics', headers: onHost(MAIN) });
    assert.equal(ics.status, 200);
    assert.match(ics.text, /BEGIN:VCALENDAR/);
  });

  test('et ukjent alias, og et fjernet alias, gir den nakne 404-en', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    expectNaked404(await app.request({ path: '/julebord', headers: onHost(MAIN) }), 'ukjent side');
    expectNaked404(await app.request({ path: '/api/events/julebord', headers: onHost(MAIN) }), 'ukjent i API-et');

    await addAlias(app, event, 'julebord');
    assert.equal((await app.request({ path: '/julebord', headers: onHost(MAIN) })).status, 200);
    const removed = await removeAlias(app, event, 'julebord');
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.aliases, []);
    expectNaked404(await app.request({ path: '/julebord', headers: onHost(MAIN) }), 'fjernet');
    // Hash-lenken virker som før.
    assert.equal((await app.request({ path: `/${event.slug}`, headers: onHost(MAIN) })).status, 200);
  });

  test('på feil domene: 302 (ikke 301) til arrangementets domene – aliaset kan senere flyttes', async () => {
    const app = await startApp(SITES);
    const en = await createEvent(app, { site: 'com' });
    await addAlias(app, en, 'party');
    const viaAlias = await app.request({ path: '/party', headers: onHost(MAIN) });
    assert.equal(viaAlias.status, 302);
    assert.equal(viaAlias.headers.location, `https://${COM}/party`);
    assert.equal((await app.request({ path: '/party', headers: onHost(COM) })).status, 200);
    // Hash-lenken er permanent og får fortsatt 301.
    const viaHash = await app.request({ path: `/${en.slug}`, headers: onHost(MAIN) });
    assert.equal(viaHash.status, 301);
    // Aliasets adresse bygges fra arrangementets nettsted.
    assert.deepEqual((await adminView(app, en)).json.event.aliases, [{ alias: 'party', url: `https://${COM}/party` }]);
  });
});

describe('administrasjon', () => {
  test('mange alias per arrangement, i den rekkefølgen de ble lagt til, med adresse og tak i admin-svaret', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    for (const alias of ['julebord', 'julebord-2026', 'jul']) assert.equal((await addAlias(app, event, alias)).status, 201);
    const { event: view } = (await adminView(app, event)).json;
    assert.deepEqual(view.aliases.map((a) => a.alias), ['julebord', 'julebord-2026', 'jul']);
    assert.equal(view.aliases[1].url, `https://${MAIN}/julebord-2026`);
    assert.equal(view.baseUrl, `https://${MAIN}`);
    assert.equal(view.maxAliases, 50);
    for (const alias of ['julebord', 'julebord-2026', 'jul']) {
      assert.equal((await app.request({ path: `/${alias}`, headers: onHost(MAIN) })).status, 200, alias);
    }
  });

  test('krever arrangementets admin-nøkkel', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    const other = await createEvent(app);
    assert.equal((await addAlias(app, event, 'julebord', 'feil-nokkel')).status, 401);
    assert.equal((await addAlias(app, event, 'julebord', other.adminKey)).status, 401, 'et annet arrangements nøkkel');
    assert.equal((await app.request({ method: 'POST', path: `/api/admin/events/${event.slug}/aliases`, body: { alias: 'julebord' } })).status, 401);
    assert.deepEqual(app.repo.listAliases(app.repo.findEvent(event.slug).id), []);

    await addAlias(app, event, 'julebord');
    assert.equal((await removeAlias(app, event, 'julebord', other.adminKey)).status, 401);
    assert.equal((await app.request({ path: '/julebord', headers: onHost(MAIN) })).status, 200, 'fortsatt der');
  });

  test('et alias gir ingen ekstra tilgang: admin via aliaset krever fortsatt nøkkelen', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    await addAlias(app, event, 'julebord');
    assert.equal((await app.request({ path: '/api/admin/events/julebord' })).status, 401);
    const withKey = await app.request({ path: '/api/admin/events/julebord', headers: bearer(event.adminKey) });
    assert.equal(withKey.status, 200);
    assert.equal(withKey.json.event.slug, event.slug);
    // Den gamle admin-adressen sendes til hash-en – 302 via aliaset, så nettleseren ikke husker den.
    const legacy = await app.request({ path: '/julebord/admin', headers: onHost(MAIN) });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.location, `/admin/${event.slug}`);
    assert.equal((await app.request({ path: `/${event.slug}/admin`, headers: onHost(MAIN) })).status, 301);
  });

  test('ugyldig navn gir 400 med feilmelding på feltet', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    for (const alias of ['', 'ab', 'blåbær', 'admin', 42, null]) {
      const res = await addAlias(app, event, alias);
      assert.equal(res.status, 400, String(alias));
      assert.ok(res.json.errors.alias, String(alias));
    }
    assert.match((await addAlias(app, event, 'admin')).json.errors.alias, /reservert/);
  });

  test('et navn kan bare brukes én gang – heller ikke som et annet arrangements hash', async () => {
    const app = await startApp(SITES);
    const first = await createEvent(app);
    const second = await createEvent(app, { site: 'com' });
    await addAlias(app, first, 'julebord');

    const taken = await addAlias(app, second, 'julebord');
    assert.equal(taken.status, 409, 'også på et annet nettsted: navnerommet er felles');
    assert.match(taken.json.errors.alias, /allerede i bruk/);
    assert.equal((await addAlias(app, first, 'julebord')).status, 409, 'det samme arrangementet to ganger');
    assert.equal((await addAlias(app, second, first.slug)).status, 409, 'et annet arrangements hash');
    assert.equal((await addAlias(app, first, first.slug)).status, 409, 'sin egen hash');
  });

  test('taket per arrangement: maks 50', async () => {
    const app = await startApp(SITES);
    const event = await createEvent(app);
    for (let i = 1; i <= 50; i++) assert.equal((await addAlias(app, event, `lenke-${i}`)).status, 201, `nr. ${i}`);
    const tooMany = await addAlias(app, event, 'lenke-51');
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.errors.alias, /maks 50/);
    // Når ett fjernes, er det plass igjen.
    await removeAlias(app, event, 'lenke-1');
    assert.equal((await addAlias(app, event, 'lenke-51')).status, 201);
  });

  test('å fjerne et alias arrangementet ikke har, gir 404 – også et annet arrangements alias', async () => {
    const app = await startApp(SITES);
    const first = await createEvent(app);
    const second = await createEvent(app);
    await addAlias(app, first, 'julebord');
    assert.equal((await removeAlias(app, second, 'julebord')).status, 404);
    assert.equal((await removeAlias(app, first, 'finnes-ikke')).status, 404);
    assert.equal((await app.request({ path: '/julebord', headers: onHost(MAIN) })).status, 200, 'urørt');
  });

  test('når arrangementet slettes, forsvinner aliasene og navnet blir ledig igjen', async () => {
    const app = await startApp(SITES);
    const old = await createEvent(app);
    await addAlias(app, old, 'julebord');
    const deleted = await app.request({ method: 'DELETE', path: `/api/admin/events/${old.slug}`, headers: bearer(old.adminKey) });
    assert.equal(deleted.status, 200);
    expectNaked404(await app.request({ path: '/julebord', headers: onHost(MAIN) }), 'borte med arrangementet');

    const next = await createEvent(app, { title: 'Neste år' });
    assert.equal((await addAlias(app, next, 'julebord')).status, 201);
    const page = await app.request({ path: '/julebord', headers: onHost(MAIN) });
    assert.match(page.text, /og:title" content="Neste år"/);
  });
});

describe('databasen', () => {
  test('hash-er og alias deler navnerom, også ved samtidige forespørsler', () => {
    const repo = createRepository(openDatabase(':memory:'));
    const base = {
      adminKeyHash: 'x', title: 'A', description: '', location: '', startsAt: '2030-01-01T10:00:00.000Z', endsAt: null,
      registrationDeadline: null, capacity: null, maxPerBooking: 10, showCount: true, isOpen: true, organizerName: 'Kari',
      organizerEmail: 'kari@example.com', imageUrl: null, fields: [], site: 'main',
    };
    const a = repo.createEvent({ ...base, slug: 'abcdefghjkmn' });
    const b = repo.createEvent({ ...base, slug: 'pqrstuvwxyz2' });
    repo.addAlias(a.id, 'julebord', 50);
    assert.equal(repo.isNameTaken('julebord'), true);
    assert.equal(repo.isNameTaken('abcdefghjkmn'), true);
    assert.equal(repo.isNameTaken('ledig'), false);
    assert.equal(repo.findEventByAlias('julebord').id, a.id);
    assert.equal(repo.findEventByAlias('ledig'), null);
    assert.throws(() => repo.addAlias(b.id, 'julebord', 50), (err) => err instanceof AliasError && err.reason === 'taken');
    assert.throws(() => repo.addAlias(b.id, 'abcdefghjkmn', 50), (err) => err instanceof AliasError && err.reason === 'taken');
    assert.throws(() => repo.addAlias(a.id, 'enda-en', 1), (err) => err instanceof AliasError && err.reason === 'tooMany');
    assert.equal(repo.removeAlias(b.id, 'julebord'), false, 'bare arrangementets egne');
    assert.equal(repo.removeAlias(a.id, 'julebord'), true);
    assert.equal(repo.isNameTaken('julebord'), false);
  });

  // Versjon 8 legger til tabellen event_aliases. Arrangementer fra før har ingen alias, og alt annet er urørt.
  test('versjon 7-database migreres: tabellen for alias finnes, og arrangementene er urørt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arrangement-migrering-'));
    const path = join(dir, 'arrangement.db');
    try {
      const old = new Database(path);
      for (const migration of MIGRATIONS.slice(0, 7)) {
        if (typeof migration === 'function') migration(old);
        else old.exec(migration);
      }
      old.pragma('user_version = 7');
      const now = '2026-09-01T10:00:00.000Z';
      old.prepare(`INSERT INTO events (id, slug, admin_key_hash, title, starts_at, organizer_name, organizer_email, created_at, updated_at)
        VALUES (1, 'abcdefghjkmn', 'x', 'Arrangement', '2099-01-01T10:00:00.000Z', 'Kari', 'kari@example.com', ?, ?)`).run(now, now);
      old.close();

      const db = openDatabase(path);
      assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
      const repo = createRepository(db);
      assert.equal(repo.findEvent('abcdefghjkmn').title, 'Arrangement');
      assert.deepEqual(repo.listAliases(1), []);
      repo.addAlias(1, 'julebord', 50);
      assert.equal(repo.findEventByAlias('julebord').slug, 'abcdefghjkmn');
      // Koblingen virker: slettes arrangementet, forsvinner aliaset.
      db.prepare('DELETE FROM events WHERE id = 1').run();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_aliases').get().n, 0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

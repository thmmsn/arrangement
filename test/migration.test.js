import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createRepository, MIGRATIONS, openDatabase } from '../src/db.js';
import { hashSecret } from '../src/ids.js';

// Sikrer at en database fra første versjon (én gjest per påmelding) oppgraderes uten tap av data.
test('versjon 1-database migreres til påmeldinger med flere personer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-migrering-'));
  const path = join(dir, 'arrangement.db');
  try {
    const old = new Database(path);
    old.exec(MIGRATIONS[0]);
    old.pragma('user_version = 1');
    const now = '2026-09-01T10:00:00.000Z';
    old.prepare(`INSERT INTO events (id, slug, admin_key_hash, title, starts_at, organizer_name, organizer_email, created_at, updated_at)
      VALUES (1, 'abcdefghjkmn', 'x', 'Gammelt arrangement', '2026-12-01T17:00:00.000Z', 'Kari', 'kari@example.com', ?, ?)`).run(now, now);
    const insert = old.prepare(`INSERT INTO registrations (id, event_id, name, email, answers, cancel_token_hash, created_at)
      VALUES (?, 1, ?, ?, ?, ?, ?)`);
    insert.run(7, 'Ola', 'ola@example.com', '{"f1":"Nøtter"}', hashSecret('gammel-nokkel-ola'), now);
    insert.run(8, 'Per', 'per@example.com', '{}', hashSecret('gammel-nokkel-per'), now);
    old.close();

    const db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const repo = createRepository(db);

    const event = repo.findEvent('abcdefghjkmn');
    assert.equal(event.maxPerBooking, 10);

    const rows = repo.listRegistrations(1);
    assert.deepEqual(rows.map((r) => [r.id, r.name, r.email, r.position, r.contactName, r.contactEmail]), [
      [7, 'Ola', 'ola@example.com', 0, 'Ola', 'ola@example.com'],
      [8, 'Per', 'per@example.com', 0, 'Per', 'per@example.com'],
    ]);
    assert.deepEqual(rows[0].answers, { f1: 'Nøtter' });

    // Hver gjest er blitt sin egen påmelding, med påmeldingsnummer (som avmeldingslenken avledes fra).
    const booking = repo.findBookingByCode(rows[0].bookingCode);
    assert.deepEqual(booking.persons.map((p) => p.name), ['Ola']);
    assert.equal(repo.deleteFromBooking(1, booking.id, [7]).length, 1);
    assert.equal(repo.countRegistrations(1), 1);
    assert.equal(repo.findBookingByCode(rows[0].bookingCode), null);

    // Å åpne databasen på nytt kjører ingen migreringer to ganger.
    db.close();
    const again = openDatabase(path);
    assert.equal(createRepository(again).countRegistrations(1), 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Versjon 3 knytter arrangementer til et nettsted. Eksisterende arrangementer skal havne på hovednettstedet.
test('versjon 2-database migreres: eksisterende arrangementer havner på hovednettstedet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-migrering-'));
  const path = join(dir, 'arrangement.db');
  try {
    const old = new Database(path);
    old.exec(MIGRATIONS[0]);
    old.exec(MIGRATIONS[1]);
    old.pragma('user_version = 2');
    const now = '2026-09-01T10:00:00.000Z';
    old.prepare(`INSERT INTO events (id, slug, admin_key_hash, title, starts_at, organizer_name, organizer_email, max_per_booking, created_at, updated_at)
      VALUES (1, 'abcdefghjkmn', 'x', 'Før nettsteder', '2026-12-01T17:00:00.000Z', 'Kari', 'kari@example.com', 4, ?, ?)`).run(now, now);
    old.prepare(`INSERT INTO bookings (id, event_id, contact_name, contact_email, cancel_token_hash, created_at)
      VALUES (1, 1, 'Ola', 'ola@example.com', ?, ?)`).run(hashSecret('nokkel'), now);
    old.prepare(`INSERT INTO registrations (event_id, booking_id, position, name, email, answers, created_at)
      VALUES (1, 1, 0, 'Ola', 'ola@example.com', '{}', ?)`).run(now);
    old.close();

    const db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const repo = createRepository(db);
    const event = repo.findEvent('abcdefghjkmn');
    assert.equal(event.site, 'main');
    assert.equal(event.maxPerBooking, 4);
    assert.equal(repo.countRegistrations(1), 1);
    assert.equal(repo.findBookingByCode(repo.listRegistrations(1)[0].bookingCode).contactName, 'Ola');
    assert.deepEqual(repo.countEventsBySite(), { main: 1 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Versjon 4: billetter, innsjekking, kartpunkt, etteranmelding, skin og avlysning.
test('versjon 3-database migreres: billettnumre, hemmelighet og brytere – ingen rapport for gamle frister', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-migrering-'));
  const path = join(dir, 'arrangement.db');
  try {
    const old = new Database(path);
    for (const migration of MIGRATIONS.slice(0, 3)) old.exec(migration);
    old.pragma('user_version = 3');
    const now = '2026-09-01T10:00:00.000Z';
    const insertEvent = old.prepare(`INSERT INTO events (id, slug, admin_key_hash, title, starts_at, organizer_name, organizer_email, created_at, updated_at)
      VALUES (?, ?, 'x', 'Arrangement', ?, 'Kari', 'kari@example.com', ?, ?)`);
    insertEvent.run(1, 'abcdefghjkmn', '2020-01-01T10:00:00.000Z', now, now); // fristen er for lengst passert
    insertEvent.run(2, 'pqrstuvwxyza', '2099-01-01T10:00:00.000Z', now, now); // fristen er i fremtiden
    old.prepare(`INSERT INTO bookings (id, event_id, contact_name, contact_email, cancel_token_hash, created_at)
      VALUES (1, 2, 'Ola', 'ola@example.com', ?, ?)`).run(hashSecret('nokkel'), now);
    const insertPerson = old.prepare(`INSERT INTO registrations (event_id, booking_id, position, name, email, answers, created_at)
      VALUES (2, 1, ?, ?, '', '{}', ?)`);
    insertPerson.run(0, 'Ola', now);
    insertPerson.run(1, 'Kari', now);
    old.close();

    const db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const repo = createRepository(db);
    assert.match(repo.secret(), /^[0-9a-f]{64}$/);

    const persons = repo.listRegistrations(2);
    assert.equal(persons.length, 2);
    for (const p of persons) {
      assert.match(p.code, /^[a-hj-km-np-z2-9]{10}$/);
      assert.equal(p.checkedInAt, null);
      assert.equal(p.late, false);
    }
    assert.notEqual(persons[0].code, persons[1].code);
    assert.match(persons[0].bookingCode, /^[a-z0-9]{10}$/);
    assert.equal(repo.findRegistrationByCode(persons[1].code).name, 'Kari');
    assert.equal(repo.findBookingByCode(persons[0].bookingCode).persons.length, 2);

    const future = repo.findEvent('pqrstuvwxyza');
    assert.deepEqual(future.features, { tickets: true, calendar: true, pdf: true, googleWallet: true, appleWallet: true, selfCancel: true });
    assert.equal(future.scannerVersion, 1);
    assert.equal(future.allowLate, false);
    assert.equal(future.skin, null);
    assert.equal(future.geo, null);
    assert.equal(future.cancelledAt, null);
    assert.equal(future.deadlineReportSentAt, null);
    // Et gammelt arrangement får ingen rapport i det øyeblikket appen oppgraderes.
    assert.ok(repo.findEvent('abcdefghjkmn').deadlineReportSentAt);
    assert.deepEqual(repo.eventsDueForReport(new Date('2030-01-01T00:00:00Z')).map((e) => e.slug), []);
    assert.equal(db.pragma('secure_delete', { simple: true }), 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Versjon 5: dørkode per person og tabell for opplastede bilder.
test('versjon 4-database migreres: alle får en dørkode, unik innenfor arrangementet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-migrering-'));
  const path = join(dir, 'arrangement.db');
  try {
    const old = new Database(path);
    for (const migration of MIGRATIONS.slice(0, 4)) {
      if (typeof migration === 'function') migration(old);
      else old.exec(migration);
    }
    old.pragma('user_version = 4');
    const now = '2026-09-01T10:00:00.000Z';
    old.prepare(`INSERT INTO events (id, slug, admin_key_hash, title, starts_at, organizer_name, organizer_email, created_at, updated_at)
      VALUES (1, 'abcdefghjkmn', 'x', 'Arrangement', '2099-01-01T10:00:00.000Z', 'Kari', 'kari@example.com', ?, ?)`).run(now, now);
    old.prepare(`INSERT INTO bookings (id, event_id, contact_name, contact_email, cancel_token_hash, code, created_at)
      VALUES (1, 1, 'Ola', 'ola@example.com', 'h', 'bbbbbbbbbb', ?)`).run(now);
    const insert = old.prepare(`INSERT INTO registrations (event_id, booking_id, position, name, email, answers, ticket_code, created_at)
      VALUES (1, 1, ?, ?, '', '{}', ?, ?)`);
    for (let i = 0; i < 40; i++) insert.run(i, `Person ${i}`, `cccccccc${String.fromCharCode(97 + Math.floor(i / 20))}${'abcdefghjkmnpqrstuvw'[i % 20]}`, now);
    old.close();

    const db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const repo = createRepository(db);
    const codes = repo.listRegistrations(1).map((r) => r.doorCode);
    assert.equal(codes.length, 40);
    for (const code of codes) assert.match(code, /^[A-HJ-NP-Z]{5}$/);
    assert.equal(new Set(codes).size, 40, 'ingen like dørkoder i samme arrangement');
    assert.equal(repo.findRegistrationByDoorCode(1, codes[7]).name, 'Person 7');
    assert.equal(repo.imageMeta(1), null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Versjon 6: den tilfeldige avmeldingsnøkkelen fjernes (bookings bygges opp på nytt), og bryteren
// for selvavmelding kommer til. registrations peker på bookings med ON DELETE CASCADE, så ingen
// deltakere må forsvinne når den gamle tabellen fjernes.
test('versjon 5-database migreres: bookings uten avmeldingsnøkkel, ingen deltakere forsvinner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-migrering-'));
  const path = join(dir, 'arrangement.db');
  try {
    const old = new Database(path);
    old.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.slice(0, 5)) {
      if (typeof migration === 'function') migration(old);
      else old.exec(migration);
    }
    old.pragma('user_version = 5');
    const now = '2026-09-01T10:00:00.000Z';
    old.prepare(`INSERT INTO events (id, slug, admin_key_hash, title, starts_at, organizer_name, organizer_email, created_at, updated_at)
      VALUES (1, 'abcdefghjkmn', 'x', 'Arrangement', '2099-01-01T10:00:00.000Z', 'Kari', 'kari@example.com', ?, ?)`).run(now, now);
    old.prepare(`INSERT INTO bookings (id, event_id, contact_name, contact_email, cancel_token_hash, code, late, created_at)
      VALUES (5, 1, 'Ola', 'ola@example.com', 'hash', 'bbbbbbbbbb', 1, ?)`).run(now);
    const insert = old.prepare(`INSERT INTO registrations (event_id, booking_id, position, name, email, answers, ticket_code, door_code, created_at)
      VALUES (1, 5, ?, ?, '', '{}', ?, ?, ?)`);
    insert.run(0, 'Ola', 'cccccccccc', 'AAAAA', now);
    insert.run(1, 'Kari', 'dddddddddd', 'BBBBB', now);
    old.close();

    const db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'fremmednøklene er slått på igjen');
    const columns = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
    assert.ok(!columns.includes('cancel_token_hash'));
    const repo = createRepository(db);
    const booking = repo.findBookingByCode('bbbbbbbbbb');
    assert.equal(booking.id, 5);
    assert.equal(booking.late, true);
    assert.deepEqual(booking.persons.map((p) => [p.name, p.code, p.doorCode]), [['Ola', 'cccccccccc', 'AAAAA'], ['Kari', 'dddddddddd', 'BBBBB']]);
    assert.equal(repo.findEvent('abcdefghjkmn').features.selfCancel, true);
    // Koblingen virker fortsatt: slettes arrangementet, forsvinner påmeldingen og deltakerne.
    db.prepare('DELETE FROM events WHERE id = 1').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Versjon 7 lagrer delingsbildet (og:image) ved siden av forsidebildet. Bilder fra før har det ikke
// og skal lages ved neste vedlikehold – forsidebildet selv skal være urørt.
test('versjon 6-database migreres: forsidebildet beholdes, delingsbildet mangler og lages senere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-migrering-'));
  const path = join(dir, 'arrangement.db');
  try {
    const old = new Database(path);
    for (const migration of MIGRATIONS.slice(0, 6)) {
      if (typeof migration === 'function') migration(old);
      else old.exec(migration);
    }
    old.pragma('user_version = 6');
    const now = '2026-09-01T10:00:00.000Z';
    old.prepare(`INSERT INTO events (id, slug, admin_key_hash, title, starts_at, organizer_name, organizer_email, created_at, updated_at)
      VALUES (1, 'abcdefghjkmn', 'x', 'Arrangement', '2099-01-01T10:00:00.000Z', 'Kari', 'kari@example.com', ?, ?)`).run(now, now);
    old.prepare(`INSERT INTO event_images (event_id, type, hash, data, created_at) VALUES (1, 'image/png', '0123456789abcdef', ?, ?)`)
      .run(Buffer.from('bildedata'), now);
    old.close();

    const db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const repo = createRepository(db);
    assert.deepEqual(repo.imageMeta(1), { type: 'image/png', hash: '0123456789abcdef', hasOg: false });
    assert.deepEqual(repo.image(1).data, Buffer.from('bildedata'));
    assert.equal(repo.ogImage(1), null);
    assert.deepEqual(repo.imagesWithoutOg(), [{ eventId: 1, hash: '0123456789abcdef' }]);

    // Delingsbildet lagres bare hvis forsidebildet fortsatt er det samme.
    assert.equal(repo.setOgImage(1, 'ffffffffffffffff', Buffer.from('feil')), false);
    assert.equal(repo.setOgImage(1, '0123456789abcdef', Buffer.from('og')), true);
    assert.deepEqual(repo.ogImage(1), { hash: '0123456789abcdef', data: Buffer.from('og') });
    assert.equal(repo.imageMeta(1).hasOg, true);
    assert.deepEqual(repo.imagesWithoutOg(), []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Prosjektet het «booking» før, og databasefilen booking.db. En eksisterende installasjon skal
// beholde alle data etter omdøpingen.
test('den gamle databasefilen booking.db tas over av arrangement.db', async () => {
  const { adoptLegacyDatabase } = await import('../src/db.js');
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-omdoping-'));
  try {
    const legacy = openDatabase(join(dir, 'booking.db'));
    createRepository(legacy).createEvent({
      slug: 'abcdefghjkmn', adminKeyHash: 'x', title: 'Fra før', description: '', location: '', startsAt: '2030-01-01T10:00:00.000Z',
      endsAt: null, registrationDeadline: null, capacity: null, maxPerBooking: 10, showCount: true, isOpen: true,
      organizerName: 'Kari', organizerEmail: 'kari@example.com', imageUrl: null, fields: [], site: 'main',
    });
    legacy.close();

    const path = join(dir, 'arrangement.db');
    assert.equal(adoptLegacyDatabase(path), join(dir, 'booking.db'));
    const db = openDatabase(path);
    assert.equal(createRepository(db).findEvent('abcdefghjkmn').title, 'Fra før');
    db.close();
    // Finnes den nye filen allerede, røres ingenting.
    assert.equal(adoptLegacyDatabase(path), null);
    assert.equal(adoptLegacyDatabase(':memory:'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

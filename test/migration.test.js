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
  const dir = mkdtempSync(join(tmpdir(), 'booking-migrering-'));
  const path = join(dir, 'booking.db');
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

    // Avmeldingslenker som allerede er sendt ut, virker fortsatt.
    const booking = repo.findBookingByToken(1, hashSecret('gammel-nokkel-ola'));
    assert.deepEqual(booking.persons.map((p) => p.name), ['Ola']);
    assert.equal(repo.deleteFromBooking(1, booking.id, [7]).length, 1);
    assert.equal(repo.countRegistrations(1), 1);
    assert.equal(repo.findBookingByToken(1, hashSecret('gammel-nokkel-ola')), null);

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
  const dir = mkdtempSync(join(tmpdir(), 'booking-migrering-'));
  const path = join(dir, 'booking.db');
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
    assert.ok(repo.findBookingByToken(1, hashSecret('nokkel')), 'avmeldingslenken virker fortsatt');
    assert.deepEqual(repo.countEventsBySite(), { main: 1 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Versjon 4: billetter, innsjekking, kartpunkt, etteranmelding, skin og avlysning.
test('versjon 3-database migreres: billettnumre, hemmelighet og brytere – ingen rapport for gamle frister', () => {
  const dir = mkdtempSync(join(tmpdir(), 'booking-migrering-'));
  const path = join(dir, 'booking.db');
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
    assert.deepEqual(future.features, { tickets: true, calendar: true, pdf: true, googleWallet: true, appleWallet: true });
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

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

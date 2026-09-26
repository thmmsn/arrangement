import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// Hver migrering kjøres én gang. PRAGMA user_version husker hvor langt databasen er kommet.
// Nye endringer legges til nederst – eksisterende migreringer skal aldri endres.
const MIGRATIONS = [
  `
  CREATE TABLE events (
    id                    INTEGER PRIMARY KEY,
    slug                  TEXT    NOT NULL UNIQUE,
    admin_key_hash        TEXT    NOT NULL,
    title                 TEXT    NOT NULL,
    description           TEXT    NOT NULL DEFAULT '',
    location              TEXT    NOT NULL DEFAULT '',
    starts_at             TEXT    NOT NULL,          -- ISO 8601 i UTC
    ends_at               TEXT,
    registration_deadline TEXT,                      -- NULL = påmelding stenger når arrangementet starter
    capacity              INTEGER,                   -- NULL = ubegrenset antall plasser
    show_count            INTEGER NOT NULL DEFAULT 1,
    is_open               INTEGER NOT NULL DEFAULT 1,
    organizer_name        TEXT    NOT NULL,
    organizer_email       TEXT    NOT NULL,
    image_url             TEXT,
    fields                TEXT    NOT NULL DEFAULT '[]', -- JSON: egendefinerte felter i skjemaet
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL
  );

  CREATE TABLE registrations (
    id                INTEGER PRIMARY KEY,
    event_id          INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name              TEXT    NOT NULL,
    email             TEXT    NOT NULL,
    answers           TEXT    NOT NULL DEFAULT '{}', -- JSON: { feltId: svar }
    cancel_token_hash TEXT    NOT NULL UNIQUE,
    created_at        TEXT    NOT NULL
  );

  CREATE INDEX registrations_event_id ON registrations(event_id);
  `,
];

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export class CapacityError extends Error {}

// Samler all SQL på ett sted. Resten av appen jobber med vanlige JS-objekter (camelCase).
export function createRepository(db) {
  const stmt = {
    eventBySlug: db.prepare('SELECT * FROM events WHERE slug = ?'),
    insertEvent: db.prepare(`
      INSERT INTO events (slug, admin_key_hash, title, description, location, starts_at, ends_at,
        registration_deadline, capacity, show_count, is_open, organizer_name, organizer_email,
        image_url, fields, created_at, updated_at)
      VALUES (@slug, @adminKeyHash, @title, @description, @location, @startsAt, @endsAt,
        @registrationDeadline, @capacity, @showCount, @isOpen, @organizerName, @organizerEmail,
        @imageUrl, @fields, @now, @now)`),
    updateEvent: db.prepare(`
      UPDATE events SET title = @title, description = @description, location = @location,
        starts_at = @startsAt, ends_at = @endsAt, registration_deadline = @registrationDeadline,
        capacity = @capacity, show_count = @showCount, is_open = @isOpen,
        organizer_name = @organizerName, organizer_email = @organizerEmail, image_url = @imageUrl,
        fields = @fields, updated_at = @now
      WHERE id = @id`),
    deleteEvent: db.prepare('DELETE FROM events WHERE id = ?'),
    countRegistrations: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?'),
    listRegistrations: db.prepare('SELECT * FROM registrations WHERE event_id = ? ORDER BY created_at, id'),
    insertRegistration: db.prepare(`
      INSERT INTO registrations (event_id, name, email, answers, cancel_token_hash, created_at)
      VALUES (@eventId, @name, @email, @answers, @cancelTokenHash, @now)`),
    registrationByToken: db.prepare(
      'SELECT * FROM registrations WHERE event_id = ? AND cancel_token_hash = ?'),
    deleteRegistration: db.prepare('DELETE FROM registrations WHERE event_id = ? AND id = ?'),
  };

  const toDb = (event) => ({
    ...event,
    showCount: event.showCount ? 1 : 0,
    isOpen: event.isOpen ? 1 : 0,
    fields: JSON.stringify(event.fields),
    now: new Date().toISOString(),
  });

  // BEGIN IMMEDIATE låser databasen for skriving før vi teller, slik at to samtidige påmeldinger
  // aldri begge kan ta den siste plassen – heller ikke hvis flere prosesser deler databasefilen.
  const registerTx = db.transaction((event, registration) => {
    const count = stmt.countRegistrations.get(event.id).n;
    if (event.capacity != null && count >= event.capacity) throw new CapacityError('Arrangementet er fullt');
    const { lastInsertRowid } = stmt.insertRegistration.run({
      eventId: event.id,
      name: registration.name,
      email: registration.email,
      answers: JSON.stringify(registration.answers),
      cancelTokenHash: registration.cancelTokenHash,
      now: new Date().toISOString(),
    });
    return { id: Number(lastInsertRowid), count: count + 1 };
  });

  return {
    findEvent(slug) {
      return mapEvent(stmt.eventBySlug.get(slug));
    },
    createEvent(event) {
      stmt.insertEvent.run(toDb(event));
      return this.findEvent(event.slug);
    },
    updateEvent(id, event) {
      stmt.updateEvent.run({ ...toDb(event), id });
    },
    deleteEvent(id) {
      stmt.deleteEvent.run(id);
    },
    countRegistrations(eventId) {
      return stmt.countRegistrations.get(eventId).n;
    },
    listRegistrations(eventId) {
      return stmt.listRegistrations.all(eventId).map(mapRegistration);
    },
    register(event, registration) {
      return registerTx.immediate(event, registration);
    },
    findRegistrationByToken(eventId, tokenHash) {
      return mapRegistration(stmt.registrationByToken.get(eventId, tokenHash));
    },
    deleteRegistration(eventId, id) {
      return stmt.deleteRegistration.run(eventId, id).changes > 0;
    },
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    adminKeyHash: row.admin_key_hash,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    registrationDeadline: row.registration_deadline,
    capacity: row.capacity,
    showCount: row.show_count === 1,
    isOpen: row.is_open === 1,
    organizerName: row.organizer_name,
    organizerEmail: row.organizer_email,
    imageUrl: row.image_url,
    fields: JSON.parse(row.fields),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRegistration(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    email: row.email,
    answers: JSON.parse(row.answers),
    createdAt: row.created_at,
  };
}

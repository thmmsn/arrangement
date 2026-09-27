import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// Hver migrering kjøres én gang. PRAGMA user_version husker hvor langt databasen er kommet.
// Nye endringer legges til nederst – eksisterende migreringer skal aldri endres.
export const MIGRATIONS = [
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

  // 2: Én påmelding kan nå gjelde flere personer. «bookings» er selve påmeldingen (kontaktperson og
  // avmeldingsnøkkel), mens hver rad i «registrations» fortsatt er én gjest.
  // SQLite kan ikke fjerne en UNIQUE-kolonne med ALTER TABLE, så registrations bygges opp på nytt.
  // Hver eksisterende gjest blir sin egen påmelding med samme id, så gamle avmeldingslenker virker fortsatt.
  `
  CREATE TABLE bookings (
    id                INTEGER PRIMARY KEY,
    event_id          INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    contact_name      TEXT    NOT NULL,
    contact_email     TEXT    NOT NULL,
    cancel_token_hash TEXT    NOT NULL UNIQUE,
    created_at        TEXT    NOT NULL
  );

  INSERT INTO bookings (id, event_id, contact_name, contact_email, cancel_token_hash, created_at)
    SELECT id, event_id, name, email, cancel_token_hash, created_at FROM registrations;

  CREATE TABLE registrations_new (
    id         INTEGER PRIMARY KEY,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL DEFAULT 0,       -- 0 = kontaktpersonen, 1, 2 … = personer lagt til
    name       TEXT    NOT NULL,
    email      TEXT    NOT NULL DEFAULT '',      -- valgfritt for personer som er lagt til
    answers    TEXT    NOT NULL DEFAULT '{}',    -- JSON: { feltId: svar }
    created_at TEXT    NOT NULL
  );

  INSERT INTO registrations_new (id, event_id, booking_id, position, name, email, answers, created_at)
    SELECT id, event_id, id, 0, name, email, answers, created_at FROM registrations;

  DROP TABLE registrations;
  ALTER TABLE registrations_new RENAME TO registrations;
  CREATE INDEX registrations_event_id ON registrations(event_id);
  CREATE INDEX registrations_booking_id ON registrations(booking_id);
  CREATE INDEX bookings_event_id ON bookings(event_id);

  -- Hvor mange personer én påmelding kan gjelde. 1 = bare seg selv.
  ALTER TABLE events ADD COLUMN max_per_booking INTEGER NOT NULL DEFAULT 10;
  `,

  // 3: Flere nettsteder (domener) med felles database. Hvert arrangement hører til ett nettsted,
  // som bestemmer domene, språk og utseende. Eksisterende arrangementer havner på hovednettstedet.
  `
  ALTER TABLE events ADD COLUMN site TEXT NOT NULL DEFAULT 'main';
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

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export class CapacityError extends Error {
  constructor(spotsLeft) {
    super('Ikke nok ledige plasser');
    this.spotsLeft = spotsLeft;
  }
}

// Samler all SQL på ett sted. Resten av appen jobber med vanlige JS-objekter (camelCase).
export function createRepository(db) {
  const stmt = {
    eventBySlug: db.prepare('SELECT * FROM events WHERE slug = ?'),
    insertEvent: db.prepare(`
      INSERT INTO events (slug, admin_key_hash, title, description, location, starts_at, ends_at,
        registration_deadline, capacity, max_per_booking, show_count, is_open, organizer_name,
        organizer_email, image_url, fields, site, created_at, updated_at)
      VALUES (@slug, @adminKeyHash, @title, @description, @location, @startsAt, @endsAt,
        @registrationDeadline, @capacity, @maxPerBooking, @showCount, @isOpen, @organizerName,
        @organizerEmail, @imageUrl, @fields, @site, @now, @now)`),
    updateEvent: db.prepare(`
      UPDATE events SET title = @title, description = @description, location = @location,
        starts_at = @startsAt, ends_at = @endsAt, registration_deadline = @registrationDeadline,
        capacity = @capacity, max_per_booking = @maxPerBooking, show_count = @showCount,
        is_open = @isOpen, organizer_name = @organizerName, organizer_email = @organizerEmail,
        image_url = @imageUrl, fields = @fields, site = @site, updated_at = @now
      WHERE id = @id`),
    deleteEvent: db.prepare('DELETE FROM events WHERE id = ?'),
    eventsPerSite: db.prepare('SELECT site, COUNT(*) AS n FROM events GROUP BY site'),
    countRegistrations: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?'),
    listRegistrations: db.prepare(`
      SELECT r.*, b.contact_name, b.contact_email
      FROM registrations r JOIN bookings b ON b.id = r.booking_id
      WHERE r.event_id = ?
      ORDER BY b.created_at, b.id, r.position`),
    insertBooking: db.prepare(`
      INSERT INTO bookings (event_id, contact_name, contact_email, cancel_token_hash, created_at)
      VALUES (@eventId, @contactName, @contactEmail, @cancelTokenHash, @now)`),
    insertRegistration: db.prepare(`
      INSERT INTO registrations (event_id, booking_id, position, name, email, answers, created_at)
      VALUES (@eventId, @bookingId, @position, @name, @email, @answers, @now)`),
    bookingByToken: db.prepare('SELECT * FROM bookings WHERE event_id = ? AND cancel_token_hash = ?'),
    bookingPersons: db.prepare('SELECT * FROM registrations WHERE booking_id = ? ORDER BY position'),
    registrationById: db.prepare('SELECT * FROM registrations WHERE event_id = ? AND id = ?'),
    deleteRegistration: db.prepare('DELETE FROM registrations WHERE event_id = ? AND booking_id = ? AND id = ?'),
    // En påmelding uten personer igjen har ingen funksjon – da forsvinner også avmeldingsnøkkelen.
    deleteEmptyBooking: db.prepare(`
      DELETE FROM bookings WHERE id = ? AND NOT EXISTS (SELECT 1 FROM registrations WHERE booking_id = ?)`),
  };

  const toDb = (event) => ({
    ...event,
    showCount: event.showCount ? 1 : 0,
    isOpen: event.isOpen ? 1 : 0,
    fields: JSON.stringify(event.fields),
    now: new Date().toISOString(),
  });

  // BEGIN IMMEDIATE låser databasen for skriving før vi teller, slik at to samtidige påmeldinger
  // aldri begge kan ta de siste plassene – heller ikke hvis flere prosesser deler databasefilen.
  // Hele gruppen får plass, eller ingen: det blir aldri halve påmeldinger.
  const registerTx = db.transaction((event, booking) => {
    const count = stmt.countRegistrations.get(event.id).n;
    if (event.capacity != null && count + booking.persons.length > event.capacity) {
      throw new CapacityError(Math.max(0, event.capacity - count));
    }
    const now = new Date().toISOString();
    const bookingId = Number(stmt.insertBooking.run({
      eventId: event.id,
      contactName: booking.contactName,
      contactEmail: booking.contactEmail,
      cancelTokenHash: booking.cancelTokenHash,
      now,
    }).lastInsertRowid);
    const ids = booking.persons.map((person, position) => Number(stmt.insertRegistration.run({
      eventId: event.id,
      bookingId,
      position,
      name: person.name,
      email: person.email || '',
      answers: JSON.stringify(person.answers),
      now,
    }).lastInsertRowid));
    return { bookingId, ids, count: count + booking.persons.length };
  });

  // Sletter de valgte personene i én påmelding, og selve påmeldingen hvis ingen er igjen.
  const deleteFromBookingTx = db.transaction((eventId, bookingId, ids) => {
    const deleted = [];
    for (const id of ids) {
      const person = stmt.registrationById.get(eventId, id);
      if (person && person.booking_id === bookingId && stmt.deleteRegistration.run(eventId, bookingId, id).changes) {
        deleted.push(mapRegistration(person));
      }
    }
    stmt.deleteEmptyBooking.run(bookingId, bookingId);
    return deleted;
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
    /** { nettsted: antall arrangementer } – brukes til å varsle om arrangementer på ukjente nettsteder. */
    countEventsBySite() {
      return Object.fromEntries(stmt.eventsPerSite.all().map((r) => [r.site, r.n]));
    },
    countRegistrations(eventId) {
      return stmt.countRegistrations.get(eventId).n;
    },
    listRegistrations(eventId) {
      return stmt.listRegistrations.all(eventId).map(mapRegistration);
    },
    /** booking: { contactName, contactEmail, cancelTokenHash, persons: [{ name, email, answers }] } */
    register(event, booking) {
      return registerTx.immediate(event, booking);
    },
    findBookingByToken(eventId, tokenHash) {
      const row = stmt.bookingByToken.get(eventId, tokenHash);
      if (!row) return null;
      return {
        id: row.id,
        contactName: row.contact_name,
        contactEmail: row.contact_email,
        createdAt: row.created_at,
        persons: stmt.bookingPersons.all(row.id).map(mapRegistration),
      };
    },
    /** Sletter personer (id-er) fra en påmelding. Returnerer personene som faktisk ble slettet. */
    deleteFromBooking(eventId, bookingId, ids) {
      return deleteFromBookingTx.immediate(eventId, bookingId, ids);
    },
    /** Admin: sletter én person, uansett hvilken påmelding den hører til. */
    deleteRegistration(eventId, id) {
      const person = stmt.registrationById.get(eventId, id);
      if (!person) return false;
      return this.deleteFromBooking(eventId, person.booking_id, [id]).length > 0;
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
    maxPerBooking: row.max_per_booking,
    site: row.site,
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
    bookingId: row.booking_id,
    position: row.position,
    name: row.name,
    email: row.email,
    answers: JSON.parse(row.answers),
    createdAt: row.created_at,
    // Bare med når raden er hentet sammen med påmeldingen (listRegistrations).
    ...(row.contact_name !== undefined && { contactName: row.contact_name, contactEmail: row.contact_email }),
  };
}

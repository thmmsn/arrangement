import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { newCode, newDoorCode } from './ids.js';

// Hver migrering kjøres én gang. PRAGMA user_version husker hvor langt databasen er kommet.
// Nye endringer legges til nederst – eksisterende migreringer skal aldri endres.
// En migrering er SQL, eller en funksjon når den trenger JavaScript (f.eks. tilfeldige verdier).
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

  // 4: Billetter, innsjekking og kartpunkt for stedet.
  // - meta.secret: hemmeligheten billett-, påmeldings- og dørvaktnøklene avledes fra (se tokens.js).
  //   Lages én gang, tilfeldig, av SQLite selv. Følger databasen, så en gjenopprettet backup
  //   har de samme lenkene.
  // - Hver person får et billettnummer, og hver påmelding et påmeldingsnummer.
  // - Brytere per arrangement for billett, kalenderfil, PDF og Wallet. Alt er på som standard.
  // - scanner_version: økes når arrangøren lager en ny dørvaktlenke.
  (db) => {
    db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('secret', lower(hex(randomblob(32))));

    ALTER TABLE events ADD COLUMN tickets_enabled       INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE events ADD COLUMN calendar_enabled      INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE events ADD COLUMN pdf_enabled           INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE events ADD COLUMN google_wallet_enabled INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE events ADD COLUMN apple_wallet_enabled  INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE events ADD COLUMN scanner_version       INTEGER NOT NULL DEFAULT 1;
    -- Kartpunkt for stedet (WGS84/EUREF89), valgt fra Kartverket i skjemaet. NULL = bare tekst.
    ALTER TABLE events ADD COLUMN location_lat          REAL;
    ALTER TABLE events ADD COLUMN location_lon          REAL;
    -- Påmelding etter fristen (etteranmelding) fram til arrangementet er over. Av som standard.
    ALTER TABLE events ADD COLUMN allow_late            INTEGER NOT NULL DEFAULT 0;
    -- Når rapporten ved påmeldingsfristen ble sendt til arrangøren. NULL = ikke sendt ennå.
    ALTER TABLE events ADD COLUMN deadline_report_sent_at TEXT;
    ALTER TABLE bookings ADD COLUMN late INTEGER NOT NULL DEFAULT 0; -- 1 = etteranmelding
    -- Utseende (skin) valgt av arrangøren, f.eks. «dark» eller «glass». NULL = nettstedets tema.
    ALTER TABLE events ADD COLUMN skin TEXT;
    -- Avlysning: når, og meldingen arrangøren sendte til de påmeldte. NULL = ikke avlyst.
    ALTER TABLE events ADD COLUMN cancelled_at   TEXT;
    ALTER TABLE events ADD COLUMN cancel_message TEXT;

    -- Arrangementer der fristen allerede er passert, skal ikke få en rapport i det øyeblikket
    -- appen oppgraderes.
    UPDATE events SET deadline_report_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE COALESCE(registration_deadline, starts_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

    ALTER TABLE registrations ADD COLUMN ticket_code   TEXT;
    ALTER TABLE registrations ADD COLUMN checked_in_at TEXT;   -- NULL = ikke sjekket inn
    ALTER TABLE registrations ADD COLUMN checked_in_by TEXT;   -- dørvaktens navn, e-post fra Access, eller NULL
    ALTER TABLE bookings ADD COLUMN code TEXT;
    `);
    // Eksisterende påmeldinger får nummer, så også de kan vise billett og sjekkes inn.
    const used = new Set();
    const unique = () => {
      let code = newCode();
      while (used.has(code)) code = newCode();
      used.add(code);
      return code;
    };
    const setTicket = db.prepare('UPDATE registrations SET ticket_code = ? WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM registrations').all()) setTicket.run(unique(), id);
    const setBooking = db.prepare('UPDATE bookings SET code = ? WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM bookings').all()) setBooking.run(unique(), id);
    db.exec(`
    CREATE UNIQUE INDEX registrations_ticket_code ON registrations(ticket_code);
    CREATE UNIQUE INDEX bookings_code ON bookings(code);
    `);
  },

  // 5: Dørkode og opplastet forsidebilde.
  // - Dørkode: 5 bokstaver per person, unik innenfor arrangementet (se ids.js).
  // - Bildet lagres i databasen, i en egen tabell så det ikke hentes med hvert arrangement. Det slettes
  //   sammen med arrangementet (ON DELETE CASCADE) og kommer med i sikkerhetskopien.
  (db) => {
    db.exec(`
    ALTER TABLE registrations ADD COLUMN door_code TEXT;

    CREATE TABLE event_images (
      event_id   INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      type       TEXT    NOT NULL,   -- image/jpeg, image/png eller image/webp
      hash       TEXT    NOT NULL,   -- SHA-256 av innholdet (forkortet), brukes i adressen
      data       BLOB    NOT NULL,
      created_at TEXT    NOT NULL
    );
    `);
    const used = new Map(); // event_id → brukte koder
    const setCode = db.prepare('UPDATE registrations SET door_code = ? WHERE id = ?');
    for (const { id, event_id: eventId } of db.prepare('SELECT id, event_id FROM registrations').all()) {
      if (!used.has(eventId)) used.set(eventId, new Set());
      const codes = used.get(eventId);
      let code = newDoorCode();
      while (codes.has(code)) code = newDoorCode();
      codes.add(code);
      setCode.run(code, id);
    }
    db.exec('CREATE UNIQUE INDEX registrations_door_code ON registrations(event_id, door_code);');
  },
];

// Før prosjektet ble omdøpt til «arrangement», het databasefilen booking.db.
export const LEGACY_DATABASE_NAME = 'booking.db';

/**
 * Finnes den gamle databasefilen (booking.db) i samme mappe, men ikke den nye, flyttes den – med
 * WAL- og SHM-filene – så en eksisterende installasjon beholder alle data etter omdøpingen.
 * Returnerer stien til den gamle filen hvis den ble flyttet, ellers null.
 */
export function adoptLegacyDatabase(path) {
  if (path === ':memory:' || existsSync(path)) return null;
  const legacy = join(dirname(path), LEGACY_DATABASE_NAME);
  if (basename(path) === LEGACY_DATABASE_NAME || !existsSync(legacy)) return null;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path + suffix);
  }
  return legacy;
}

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Slettede data overskrives med nuller i stedet for å bli liggende igjen i ledige sider i filen.
  // Når et arrangement slettes (etter 30 dager, eller av arrangøren), er personopplysningene borte.
  db.pragma('secure_delete = ON');
  migrate(db);
  return db;
}

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      const migration = MIGRATIONS[version];
      if (typeof migration === 'function') migration(db);
      else db.exec(migration);
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
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    eventBySlug: db.prepare('SELECT * FROM events WHERE slug = ?'),
    eventById: db.prepare('SELECT * FROM events WHERE id = ?'),
    insertEvent: db.prepare(`
      INSERT INTO events (slug, admin_key_hash, title, description, location, starts_at, ends_at,
        registration_deadline, capacity, max_per_booking, show_count, is_open, organizer_name,
        organizer_email, image_url, fields, site, tickets_enabled, calendar_enabled, pdf_enabled,
        google_wallet_enabled, apple_wallet_enabled, location_lat, location_lon, allow_late, skin, created_at, updated_at)
      VALUES (@slug, @adminKeyHash, @title, @description, @location, @startsAt, @endsAt,
        @registrationDeadline, @capacity, @maxPerBooking, @showCount, @isOpen, @organizerName,
        @organizerEmail, @imageUrl, @fields, @site, @tickets, @calendar, @pdf,
        @googleWallet, @appleWallet, @lat, @lon, @allowLate, @skin, @now, @now)`),
    updateEvent: db.prepare(`
      UPDATE events SET title = @title, description = @description, location = @location,
        starts_at = @startsAt, ends_at = @endsAt, registration_deadline = @registrationDeadline,
        capacity = @capacity, max_per_booking = @maxPerBooking, show_count = @showCount,
        is_open = @isOpen, organizer_name = @organizerName, organizer_email = @organizerEmail,
        image_url = @imageUrl, fields = @fields, site = @site, tickets_enabled = @tickets,
        calendar_enabled = @calendar, pdf_enabled = @pdf, google_wallet_enabled = @googleWallet,
        apple_wallet_enabled = @appleWallet, location_lat = @lat, location_lon = @lon, allow_late = @allowLate, skin = @skin,
        -- Flyttes fristen fram i tid, skal rapporten sendes på nytt når den nye fristen er nådd.
        deadline_report_sent_at = CASE WHEN COALESCE(@registrationDeadline, @startsAt) > @now THEN NULL
                                       ELSE deadline_report_sent_at END,
        updated_at = @now
      WHERE id = @id`),
    // Rapport ved fristen: arrangementer der fristen er nådd og rapporten ikke er sendt.
    dueReports: db.prepare(`
      SELECT * FROM events
      WHERE deadline_report_sent_at IS NULL AND COALESCE(registration_deadline, starts_at) <= ?`),
    markReportSent: db.prepare('UPDATE events SET deadline_report_sent_at = ? WHERE id = ?'),
    // Sletting: arrangementer som var over før `cutoff`. Påmeldingene slettes med (ON DELETE CASCADE).
    expiredEvents: db.prepare('SELECT id, slug FROM events WHERE COALESCE(ends_at, starts_at) < ?'),
    rotateScanner: db.prepare('UPDATE events SET scanner_version = scanner_version + 1 WHERE id = ?'),
    // updated_at endres også, så kalenderfilen får ny SEQUENCE og kalenderne oppdaterer avtalen.
    setCancelled: db.prepare('UPDATE events SET cancelled_at = ?, cancel_message = ?, updated_at = ? WHERE id = ?'),
    deleteEvent: db.prepare('DELETE FROM events WHERE id = ?'),
    eventsPerSite: db.prepare('SELECT site, COUNT(*) AS n FROM events GROUP BY site'),
    countRegistrations: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?'),
    countCheckedIn: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND checked_in_at IS NOT NULL'),
    listRegistrations: db.prepare(`
      SELECT r.*, b.contact_name, b.contact_email, b.code AS booking_code, b.late
      FROM registrations r JOIN bookings b ON b.id = r.booking_id
      WHERE r.event_id = ?
      ORDER BY b.created_at, b.id, r.position`),
    registrationByCode: db.prepare(`
      SELECT r.*, b.contact_name, b.contact_email, b.code AS booking_code, b.late
      FROM registrations r JOIN bookings b ON b.id = r.booking_id
      WHERE r.ticket_code = ?`),
    registrationWithBooking: db.prepare(`
      SELECT r.*, b.contact_name, b.contact_email, b.code AS booking_code, b.late
      FROM registrations r JOIN bookings b ON b.id = r.booking_id
      WHERE r.event_id = ? AND r.id = ?`),
    ticketCodeExists: db.prepare('SELECT 1 FROM registrations WHERE ticket_code = ?'),
    doorCodeExists: db.prepare('SELECT 1 FROM registrations WHERE event_id = ? AND door_code = ?'),
    registrationByDoorCode: db.prepare(`
      SELECT r.*, b.contact_name, b.contact_email, b.code AS booking_code, b.late
      FROM registrations r JOIN bookings b ON b.id = r.booking_id
      WHERE r.event_id = ? AND r.door_code = ?`),
    imageMeta: db.prepare('SELECT type, hash FROM event_images WHERE event_id = ?'),
    image: db.prepare('SELECT type, hash, data FROM event_images WHERE event_id = ?'),
    setImage: db.prepare(`
      INSERT INTO event_images (event_id, type, hash, data, created_at) VALUES (@eventId, @type, @hash, @data, @now)
      ON CONFLICT(event_id) DO UPDATE SET type = @type, hash = @hash, data = @data, created_at = @now`),
    deleteImage: db.prepare('DELETE FROM event_images WHERE event_id = ?'),
    bookingCodeExists: db.prepare('SELECT 1 FROM bookings WHERE code = ?'),
    insertBooking: db.prepare(`
      INSERT INTO bookings (event_id, contact_name, contact_email, cancel_token_hash, code, late, created_at)
      VALUES (@eventId, @contactName, @contactEmail, @cancelTokenHash, @code, @late, @now)`),
    insertRegistration: db.prepare(`
      INSERT INTO registrations (event_id, booking_id, position, name, email, answers, ticket_code, door_code, created_at)
      VALUES (@eventId, @bookingId, @position, @name, @email, @answers, @ticketCode, @doorCode, @now)`),
    bookingByToken: db.prepare('SELECT * FROM bookings WHERE event_id = ? AND cancel_token_hash = ?'),
    bookingByCode: db.prepare('SELECT * FROM bookings WHERE code = ?'),
    // Atomisk: to dørvakter som skanner samme billett samtidig kan ikke begge få «sjekket inn».
    checkIn: db.prepare(`
      UPDATE registrations SET checked_in_at = ?, checked_in_by = ?
      WHERE event_id = ? AND id = ? AND checked_in_at IS NULL`),
    undoCheckIn: db.prepare(`
      UPDATE registrations SET checked_in_at = NULL, checked_in_by = NULL
      WHERE event_id = ? AND id = ? AND checked_in_at IS NOT NULL`),
    bookingPersons: db.prepare('SELECT * FROM registrations WHERE booking_id = ? ORDER BY position'),
    registrationById: db.prepare('SELECT * FROM registrations WHERE event_id = ? AND id = ?'),
    deleteRegistration: db.prepare('DELETE FROM registrations WHERE event_id = ? AND booking_id = ? AND id = ?'),
    // En påmelding uten personer igjen har ingen funksjon – da forsvinner også avmeldingsnøkkelen.
    deleteEmptyBooking: db.prepare(`
      DELETE FROM bookings WHERE id = ? AND NOT EXISTS (SELECT 1 FROM registrations WHERE booking_id = ?)`),
  };

  const toDb = (event) => {
    const features = { ...DEFAULT_FEATURES, ...event.features };
    const { features: _, geo, ...rest } = event;
    return {
      ...rest,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      showCount: event.showCount ? 1 : 0,
      isOpen: event.isOpen ? 1 : 0,
      allowLate: event.allowLate ? 1 : 0,
      skin: event.skin || null,
      fields: JSON.stringify(event.fields),
      ...Object.fromEntries(Object.entries(features).map(([key, on]) => [key, on ? 1 : 0])),
      now: new Date().toISOString(),
    };
  };

  const withPersons = (row) => row ? { ...mapBooking(row), persons: stmt.bookingPersons.all(row.id).map(mapRegistration) } : null;

  // Et nytt, ubrukt nummer. Kjøres inne i en skrivetransaksjon, så ingen andre kan ta det i mellomtiden.
  const unusedCode = (exists) => {
    let code = newCode();
    while (exists.get(code)) code = newCode();
    return code;
  };

  // BEGIN IMMEDIATE låser databasen for skriving før vi teller, slik at to samtidige påmeldinger
  // aldri begge kan ta de siste plassene – heller ikke hvis flere prosesser deler databasefilen.
  // Hele gruppen får plass, eller ingen: det blir aldri halve påmeldinger.
  const registerTx = db.transaction((event, booking) => {
    const count = stmt.countRegistrations.get(event.id).n;
    if (event.capacity != null && count + booking.persons.length > event.capacity) {
      throw new CapacityError(Math.max(0, event.capacity - count));
    }
    const now = new Date().toISOString();
    const bookingCode = unusedCode(stmt.bookingCodeExists);
    const bookingId = Number(stmt.insertBooking.run({
      eventId: event.id,
      contactName: booking.contactName,
      contactEmail: booking.contactEmail,
      cancelTokenHash: booking.cancelTokenHash,
      code: bookingCode,
      late: booking.late ? 1 : 0,
      now,
    }).lastInsertRowid);
    const persons = booking.persons.map((person, position) => {
      const ticketCode = unusedCode(stmt.ticketCodeExists);
      let doorCode = newDoorCode();
      while (stmt.doorCodeExists.get(event.id, doorCode)) doorCode = newDoorCode();
      const id = Number(stmt.insertRegistration.run({
        eventId: event.id,
        bookingId,
        position,
        name: person.name,
        email: person.email || '',
        answers: JSON.stringify(person.answers),
        ticketCode,
        doorCode,
        now,
      }).lastInsertRowid);
      return { id, code: ticketCode, doorCode };
    });
    return { bookingId, bookingCode, persons, ids: persons.map((p) => p.id), count: count + booking.persons.length };
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
    /** Hemmeligheten nøklene avledes fra (se tokens.js). */
    secret() {
      return stmt.meta.get('secret').value;
    },
    findEvent(slug) {
      return mapEvent(stmt.eventBySlug.get(slug));
    },
    findEventById(id) {
      return mapEvent(stmt.eventById.get(id));
    },
    /** Avlyser arrangementet (at = tidspunkt), eller opphever avlysningen (at = null). */
    setCancelled(id, at, message = null) {
      stmt.setCancelled.run(at, at ? message : null, new Date().toISOString(), id);
    },
    /** Ny dørvaktlenke: den gamle lenken, og alle som er logget inn med den, slutter å virke. */
    rotateScannerKey(id) {
      stmt.rotateScanner.run(id);
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
      return withPersons(stmt.bookingByToken.get(eventId, tokenHash));
    },
    /** Påmeldingen med dette påmeldingsnummeret (alle billettene i den), eller null. */
    findBookingByCode(code) {
      return withPersons(stmt.bookingByCode.get(code));
    },
    /** Personen med dette billettnummeret, med påmeldingen den hører til, eller null. */
    findRegistrationByCode(code) {
      return mapRegistration(stmt.registrationByCode.get(code));
    },
    /** Personen med denne dørkoden i arrangementet, eller null. */
    findRegistrationByDoorCode(eventId, doorCode) {
      return mapRegistration(stmt.registrationByDoorCode.get(eventId, doorCode));
    },
    /** Forsidebildet: { type, hash } uten selve dataene, eller null. */
    imageMeta(eventId) {
      return stmt.imageMeta.get(eventId) ?? null;
    },
    /** Forsidebildet med data (Buffer), eller null. */
    image(eventId) {
      return stmt.image.get(eventId) ?? null;
    },
    setImage(eventId, { type, hash, data }) {
      stmt.setImage.run({ eventId, type, hash, data, now: new Date().toISOString() });
    },
    deleteImage(eventId) {
      return stmt.deleteImage.run(eventId).changes > 0;
    },
    findRegistration(eventId, id) {
      return mapRegistration(stmt.registrationWithBooking.get(eventId, id));
    },
    /** Arrangementer der påmeldingsfristen er nådd, men rapporten til arrangøren ikke er sendt. */
    eventsDueForReport(now = new Date()) {
      return stmt.dueReports.all(now.toISOString()).map(mapEvent);
    },
    markReportSent(id, at = new Date()) {
      stmt.markReportSent.run(at.toISOString(), id);
    },
    /**
     * Sletter alle arrangementer som var over før `cutoff`, med alle påmeldinger.
     * Returnerer slug-ene som ble slettet.
     */
    deleteEventsEndedBefore(cutoff) {
      return db.transaction(() => {
        const expired = stmt.expiredEvents.all(cutoff.toISOString());
        for (const { id } of expired) stmt.deleteEvent.run(id);
        return expired.map((e) => e.slug);
      }).immediate();
    },
    countCheckedIn(eventId) {
      return stmt.countCheckedIn.get(eventId).n;
    },
    /** Sjekker inn én person. true = sjekket inn nå, false = var allerede sjekket inn (eller finnes ikke). */
    checkIn(eventId, id, { at = new Date().toISOString(), by = null } = {}) {
      return stmt.checkIn.run(at, by, eventId, id).changes === 1;
    },
    /** Angrer en innsjekking. true = angret, false = var ikke sjekket inn. */
    undoCheckIn(eventId, id) {
      return stmt.undoCheckIn.run(eventId, id).changes === 1;
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

// Brytere per arrangement: kolonnenavn → nøkkel i event.features. Alt er på som standard.
const FEATURE_COLUMNS = {
  tickets: 'tickets_enabled',
  calendar: 'calendar_enabled',
  pdf: 'pdf_enabled',
  googleWallet: 'google_wallet_enabled',
  appleWallet: 'apple_wallet_enabled',
};
export const FEATURES = Object.keys(FEATURE_COLUMNS);
const DEFAULT_FEATURES = Object.fromEntries(FEATURES.map((key) => [key, true]));

function mapBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    code: row.code,
    late: row.late === 1,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    createdAt: row.created_at,
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
    // Kartpunktet, eller null når stedet bare er skrevet inn som tekst.
    geo: row.location_lat != null && row.location_lon != null ? { lat: row.location_lat, lon: row.location_lon } : null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    registrationDeadline: row.registration_deadline,
    capacity: row.capacity,
    maxPerBooking: row.max_per_booking,
    site: row.site,
    showCount: row.show_count === 1,
    isOpen: row.is_open === 1,
    allowLate: row.allow_late === 1,
    cancelledAt: row.cancelled_at,
    cancelMessage: row.cancel_message,
    skin: row.skin,
    deadlineReportSentAt: row.deadline_report_sent_at,
    organizerName: row.organizer_name,
    organizerEmail: row.organizer_email,
    imageUrl: row.image_url,
    fields: JSON.parse(row.fields),
    features: Object.fromEntries(FEATURES.map((key) => [key, row[FEATURE_COLUMNS[key]] === 1])),
    scannerVersion: row.scanner_version,
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
    code: row.ticket_code,
    doorCode: row.door_code,
    checkedInAt: row.checked_in_at,
    checkedInBy: row.checked_in_by,
    createdAt: row.created_at,
    // Bare med når raden er hentet sammen med påmeldingen (listRegistrations o.l.).
    ...(row.contact_name !== undefined && {
      contactName: row.contact_name, contactEmail: row.contact_email, bookingCode: row.booking_code, late: row.late === 1,
    }),
  };
}

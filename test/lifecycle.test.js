import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieHeader, createEvent, register, startApp } from './helpers.js';

// Arrangementets livsløp: første e-post, etteranmelding, rapport ved fristen, avlysning og sletting.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

test('første e-post til arrangøren har alle lenkene og hva som skjer videre – og administrator får kopi', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true', ADMIN_EMAIL: 'drift@example.com, sjef@example.com' });
  const { slug, adminKey, scannerUrl } = await createEvent(app, { startsAt: '2030-10-26T16:00:00.000Z', registrationDeadline: '2030-10-20T10:00:00.000Z' });
  assert.equal(app.sent.length, 3);
  const [organizer, admin1, admin2] = app.sent;

  assert.equal(organizer.to, 'arrangor@example.com');
  assert.equal(organizer.subject, 'Arrangementet er opprettet: Testarrangement');
  assert.ok(organizer.text.includes(`http://localhost:3000/admin/${slug}#${adminKey}`), 'admin-lenken');
  assert.ok(organizer.text.includes(scannerUrl), 'dørvaktlenken');
  assert.ok(organizer.text.includes(`Avlys arrangementet: http://localhost:3000/admin/${slug}/avlys#${adminKey}`), 'avlys-lenken');
  assert.match(organizer.text, /påmeldingsfristen er nådd \(20\.10\.2030, 12:00\), får du en rapport med alle påmeldte/);
  assert.match(organizer.text, /Påmeldingen stenger ved fristen\./);
  assert.match(organizer.text, /slettes automatisk 25\.11\.2030, 17:00/);
  assert.ok(organizer.html.includes(`/admin/${slug}/avlys#${adminKey}`));

  // Tjenesteadministratoren får de samme lenkene, med arrangørens navn og e-post.
  assert.deepEqual([admin1.to, admin2.to], ['drift@example.com', 'sjef@example.com']);
  assert.equal(admin1.subject, 'Nytt arrangement opprettet: Testarrangement');
  assert.match(admin1.text, /Arrangør \(arrangor@example\.com\) har opprettet arrangementet Testarrangement\./);
  assert.ok(admin1.text.includes(`/admin/${slug}#${adminKey}`));
  assert.ok(admin1.text.includes(`/admin/${slug}/avlys#${adminKey}`));
  assert.ok(admin1.text.includes(scannerUrl));
});

test('uten ADMIN_EMAIL får bare arrangøren e-post, og ugyldige adresser gir advarsel', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true', ADMIN_EMAIL: 'ikke-en-adresse' });
  assert.ok(app.config.warnings.some((w) => w.includes('ADMIN_EMAIL')));
  await createEvent(app);
  assert.deepEqual(app.sent.map((m) => m.to), ['arrangor@example.com']);
});

test('etteranmelding: stengt etter fristen som standard, åpen når arrangøren tillater det', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const deadline = iso(Date.now() - HOUR);
  const startsAt = iso(Date.now() + DAY);

  const closed = await createEvent(app, { registrationDeadline: deadline, startsAt });
  const refused = await register(app, closed.slug);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.status, 'deadline_passed');

  const late = await createEvent(app, { registrationDeadline: deadline, startsAt, allowLate: true });
  const page = await app.request({ path: `/api/events/${late.slug}` });
  assert.equal(page.json.status, 'open');
  assert.equal(page.json.late, true);
  app.sent.length = 0;
  const ok = await register(app, late.slug, { name: 'Sen Gjest', email: 'sen@example.com' });
  assert.equal(ok.status, 201);
  const notice = app.sent.find((m) => m.to === 'arrangor@example.com');
  assert.equal(notice.subject, 'Etteranmelding: Sen Gjest – Testarrangement');
  assert.match(notice.html, /Etteranmelding/);
  const list = await app.request({ path: `/api/admin/events/${late.slug}`, headers: { authorization: `Bearer ${late.adminKey}` } });
  assert.equal(list.json.registrations[0].late, true);
  assert.equal(list.json.event.allowLate, true);

  // Før fristen er en påmelding ikke en etteranmelding.
  const early = await createEvent(app, { startsAt, allowLate: true });
  app.sent.length = 0;
  await register(app, early.slug);
  assert.match(app.sent.find((m) => m.to === 'arrangor@example.com').subject, /^Ny påmelding/);

  // Når arrangementet er over, er det stengt uansett.
  const over = await createEvent(app, { startsAt: iso(Date.now() - 2 * HOUR), endsAt: iso(Date.now() - HOUR), allowLate: true });
  assert.equal((await register(app, over.slug)).json.status, 'deadline_passed');
});

test('rapport ved påmeldingsfristen: én gang, med alle påmeldte og CSV – ikke for avlyste', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const now = Date.now();
  const event = await createEvent(app, { registrationDeadline: iso(now + HOUR), startsAt: iso(now + DAY), fields: [{ label: 'Allergier', type: 'text' }] });
  await register(app, event.slug, { guests: ['Kari Nordmann'] });
  const cancelled = await createEvent(app, { title: 'Avlyst', registrationDeadline: iso(now + HOUR), startsAt: iso(now + DAY) });
  await app.request({ method: 'POST', path: `/api/admin/events/${cancelled.slug}/cancel`, headers: { authorization: `Bearer ${cancelled.adminKey}` }, body: { notify: false } });

  app.sent.length = 0;
  assert.deepEqual((await app.app.runMaintenance(new Date(now))).reported, [], 'før fristen');
  assert.equal(app.sent.length, 0);

  const after = new Date(now + 2 * HOUR);
  assert.deepEqual((await app.app.runMaintenance(after)).reported, [event.slug]);
  const [report] = app.sent;
  assert.equal(report.to, 'arrangor@example.com');
  assert.equal(report.subject, 'Påmeldingsfristen er nådd: Testarrangement');
  assert.match(report.text, /2 personer i 1 påmeldinger\./);
  assert.match(report.text, /1\. Ola Nordmann – ola@example\.com/);
  assert.match(report.text, /2\. Kari Nordmann – meldt på av Ola Nordmann/);
  assert.match(report.text, /Dørvaktlenke: http:\/\/localhost:3000\/.+\/skanner#/);
  assert.equal(report.attachments[0].filename, `pameldte-${event.slug}.csv`);
  assert.match(report.attachments[0].content.toString(), /Allergier/);

  // Bare én gang.
  app.sent.length = 0;
  await app.app.runMaintenance(new Date(now + 3 * HOUR));
  assert.equal(app.sent.length, 0);

  // Flyttes fristen fram i tid, kommer en ny rapport ved den nye fristen.
  const admin = { authorization: `Bearer ${event.adminKey}` };
  const current = (await app.request({ path: `/api/admin/events/${event.slug}`, headers: admin })).json.event;
  const later = iso(Date.now() + 5 * HOUR);
  await app.request({ method: 'PUT', path: `/api/admin/events/${event.slug}`, headers: admin, body: { ...current, registrationDeadline: later } });
  assert.equal(app.repo.findEvent(event.slug).deadlineReportSentAt, null);
});

test('e-post som ikke kan sendes, prøves igjen ved neste kjøring', async () => {
  let fail = true;
  const sent = [];
  const mailer = { send: async (m) => { if (fail && m.subject.startsWith('Påmeldingsfristen')) throw new Error('nede'); sent.push(m); } };
  const app = await startApp({ ADMIN_NO_AUTH: 'true' }, { mailer });
  const now = Date.now();
  const { slug } = await createEvent(app, { registrationDeadline: iso(now + HOUR), startsAt: iso(now + DAY) });
  assert.deepEqual((await app.app.runMaintenance(new Date(now + 2 * HOUR))).reported, []);
  fail = false;
  assert.deepEqual((await app.app.runMaintenance(new Date(now + 3 * HOUR))).reported, [slug]);
});

test('alle data slettes DELETE_AFTER_DAYS dager etter at arrangementet er over', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true', DELETE_AFTER_DAYS: '30' });
  const now = Date.now();
  const old = await createEvent(app, { startsAt: iso(now + DAY), endsAt: iso(now + DAY + 3 * HOUR) });
  await register(app, old.slug);
  const fresh = await createEvent(app, { startsAt: iso(now + 20 * DAY) });
  const eventId = app.repo.findEvent(old.slug).id;
  assert.equal(app.repo.countRegistrations(eventId), 1);

  // 29 dager etter slutt: finnes fortsatt.
  assert.deepEqual((await app.app.runMaintenance(new Date(now + DAY + 3 * HOUR + 29 * DAY))).deleted, []);
  // 31 dager etter slutt: borte, med påmeldinger og billetter.
  const { deleted } = await app.app.runMaintenance(new Date(now + DAY + 3 * HOUR + 31 * DAY));
  assert.deepEqual(deleted, [old.slug]);
  assert.equal(app.repo.findEvent(old.slug), null);
  assert.equal(app.repo.countRegistrations(eventId), 0);
  assert.equal((await app.request({ path: `/${old.slug}` })).status, 404);
  assert.ok(app.repo.findEvent(fresh.slug), 'andre arrangementer blir stående');

  const admin = await app.request({ path: `/api/admin/events/${fresh.slug}`, headers: { authorization: `Bearer ${fresh.adminKey}` } });
  assert.equal(admin.json.event.deleteAt, iso(Date.parse(app.repo.findEvent(fresh.slug).startsAt) + 30 * DAY));
});

test('avlysning: melding til de påmeldte, kvittering til arrangør og administrator, og alt stenges', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true', ADMIN_EMAIL: 'drift@example.com' });
  const { slug, adminKey, scannerUrl } = await createEvent(app);
  const admin = { authorization: `Bearer ${adminKey}` };
  await register(app, slug, { guests: ['Kari Nordmann'] });
  await register(app, slug, { name: 'Per', email: 'per@example.com' });
  const ticketsUrl = (await register(app, slug, { name: 'Lise', email: 'lise@example.com' })).json.links.tickets;

  assert.equal((await app.request({ method: 'POST', path: `/api/admin/events/${slug}/cancel`, body: { notify: true } })).status, 401);
  const tooLong = await app.request({ method: 'POST', path: `/api/admin/events/${slug}/cancel`, headers: admin, body: { notify: true, message: 'x'.repeat(2001) } });
  assert.equal(tooLong.status, 400);

  app.sent.length = 0;
  const res = await app.request({
    method: 'POST', path: `/api/admin/events/${slug}/cancel`, headers: admin,
    body: { notify: true, message: 'Beklager – vi må avlyse på grunn av uvær.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.notified, 3, 'én e-post per påmelding');
  assert.ok(res.json.event.cancelledAt);
  const guests = app.sent.filter((m) => m.subject === 'Avlyst: Testarrangement');
  assert.deepEqual(guests.map((m) => m.to).sort(), ['lise@example.com', 'ola@example.com', 'per@example.com']);
  assert.match(guests[0].text, /Beklager – vi må avlyse på grunn av uvær\./);
  assert.equal(guests[0].replyTo, 'arrangor@example.com');
  const receipts = app.sent.filter((m) => m.subject === 'Arrangementet er avlyst: Testarrangement');
  assert.deepEqual(receipts.map((m) => m.to), ['arrangor@example.com', 'drift@example.com']);
  assert.match(receipts[0].text, /3 påmeldinger har fått e-post om avlysningen\./);

  // Påmelding, innsjekking og kalender følger avlysningen.
  assert.equal((await app.request({ path: `/api/events/${slug}` })).json.status, 'cancelled');
  assert.equal((await register(app, slug, { email: 'ny@example.com' })).json.status, 'cancelled');
  const ics = await app.request({ path: `/${slug}/kalender.ics` });
  assert.match(ics.text, /STATUS:CANCELLED/);
  assert.match(ics.text.replace(/\r\n /g, ''), /SUMMARY;LANGUAGE=nb:AVLYST: Testarrangement/);
  const login = await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/login`, body: { key: scannerUrl.split('#')[1] } });
  const booking = await app.request({ path: new URL(ticketsUrl).pathname.replace('/b/', '/api/bookings/') });
  assert.equal(booking.json.event.cancelled, true);
  const checkin = await app.request({
    method: 'POST', path: `/api/events/${slug}/scanner/checkin`, headers: { cookie: cookieHeader(login) },
    body: { token: booking.json.tickets[0].path.slice(3) },
  });
  assert.equal(checkin.status, 409);
  assert.equal(checkin.json.result, 'cancelled');

  // Opphev: åpent igjen, uten nye e-poster.
  app.sent.length = 0;
  const undo = await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}/cancel`, headers: admin });
  assert.equal(undo.json.event.cancelledAt, null);
  assert.equal(app.sent.length, 0);
  assert.equal((await app.request({ path: `/api/events/${slug}` })).json.status, 'open');
});

test('avlysning uten melding: ingen e-post til de påmeldte', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const { slug, adminKey } = await createEvent(app);
  await register(app, slug);
  app.sent.length = 0;
  const res = await app.request({ method: 'POST', path: `/api/admin/events/${slug}/cancel`, headers: { authorization: `Bearer ${adminKey}` }, body: { notify: false } });
  assert.equal(res.json.notified, 0);
  assert.deepEqual(app.sent.map((m) => m.to), ['arrangor@example.com']);
  assert.match(app.sent[0].text, /De påmeldte har ikke fått e-post om avlysningen\./);
});

test('avlys-lenken fra e-posten åpner admin-siden', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const { slug } = await createEvent(app);
  const page = await app.request({ path: `/admin/${slug}/avlys` });
  assert.equal(page.status, 200);
  assert.match(page.text, /admin\.js/);
  assert.equal((await app.request({ path: '/admin/abcdefghjkmn/avlys' })).status, 404);
});

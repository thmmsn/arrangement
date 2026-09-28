import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cookieHeader, createEvent, register, startApp } from './helpers.js';

// Innsjekking: dørvaktlenken, billettsiden i dørvaktmodus, skanner-API-et og admin.

const pathOf = (url) => new URL(url).pathname;
const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Et arrangement med to påmeldte og en innlogget dørvakt. */
async function setup(overrides = {}) {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const created = await createEvent(app, overrides);
  const { slug, adminKey, scannerUrl } = created;
  const reg = await register(app, slug, { guests: ['Kari Nordmann'] });
  const booking = await app.request({ path: pathOf(reg.json.ticketsUrl).replace('/b/', '/api/bookings/') });
  const ticketPaths = booking.json.tickets.map((t) => t.path);
  const tokens = ticketPaths.map((p) => p.slice(3));
  const key = scannerUrl.split('#')[1];
  const login = await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/login`, body: { key, name: 'Per Dørvakt' } });
  const staff = { cookie: cookieHeader(login) };
  const admin = { authorization: `Bearer ${adminKey}` };
  const checkin = (body, headers = staff) => app.request({ method: 'POST', path: `/api/events/${slug}/scanner/checkin`, headers, body });
  return { app, slug, key, login, staff, admin, tokens, ticketPaths, checkin, booking: booking.json };
}

test('dørvaktlenken logger inn med en HttpOnly-informasjonskapsel – feil nøkkel gir ingenting', async () => {
  const { app, slug, login } = await setup();
  assert.equal(login.status, 200);
  const cookies = login.headers['set-cookie'];
  const main = cookies.find((c) => c.startsWith(`dv_${slug}=`));
  assert.match(main, /HttpOnly/);
  assert.match(main, /SameSite=Lax/);
  assert.match(main, /Path=\//);
  assert.ok(cookies.some((c) => c.startsWith(`dvn_${slug}=Per%20D%C3%B8rvakt`)));

  const wrong = await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/login`, body: { key: 'feil' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  // Uten innlogging: ingen innsjekking og ingen liste.
  assert.equal((await app.request({ path: `/api/events/${slug}/scanner` })).status, 401);
  assert.equal((await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/checkin`, body: { id: 1 } })).status, 401);
});

test('skann: sjekket inn, deretter «allerede inne», og angre', async () => {
  const { tokens, checkin, slug, app, staff } = await setup();
  const first = await checkin({ token: tokens[0] });
  assert.equal(first.status, 200);
  assert.equal(first.json.result, 'checked_in');
  assert.equal(first.json.person.name, 'Ola Nordmann');
  assert.equal(first.json.person.checkedInBy, 'Per Dørvakt');
  assert.deepEqual(first.json.stats, { checkedIn: 1, total: 2 });
  // Resten av påmeldingen vises, så familien kan sjekkes inn samlet – men uten e-post eller svar.
  assert.deepEqual(first.json.companions.map((c) => c.name), ['Kari Nordmann']);
  assert.ok(!JSON.stringify(first.json).includes('@example.com'), 'dørvakten ser ikke e-postadresser');

  const again = await checkin({ token: tokens[0] });
  assert.equal(again.json.result, 'already');
  assert.equal(again.json.stats.checkedIn, 1);

  const undo = await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/undo`, headers: staff, body: { id: first.json.person.id } });
  assert.equal(undo.json.result, 'undone');
  assert.equal(undo.json.stats.checkedIn, 0);
});

test('billettnummer tastet inn og navnesøk', async () => {
  const { checkin, booking, app, slug, staff } = await setup();
  const code = booking.tickets[1].code; // «ABCD-EFGH-JK»
  const res = await checkin({ code: code.toLowerCase().replaceAll('-', ' ') });
  assert.equal(res.json.result, 'checked_in');
  assert.equal(res.json.person.name, 'Kari Nordmann');
  assert.equal(res.json.person.bookedBy, 'Ola Nordmann');
  assert.equal((await checkin({ code: 'AAAA-AAAA-AA' })).json.result, 'invalid');

  const short = await app.request({ path: `/api/events/${slug}/scanner/search?q=k`, headers: staff });
  assert.deepEqual(short.json.results, [], 'minst to tegn');
  const search = await app.request({ path: `/api/events/${slug}/scanner/search?q=kar`, headers: staff });
  assert.deepEqual(search.json.results.map((r) => [r.name, Boolean(r.checkedInAt)]), [['Kari Nordmann', true]]);
});

test('to dørvakter som skanner samme billett samtidig: bare én får «sjekket inn»', async () => {
  const { tokens, checkin } = await setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => checkin({ token: tokens[1] })));
  assert.equal(results.filter((r) => r.json.result === 'checked_in').length, 1);
  assert.equal(results.filter((r) => r.json.result === 'already').length, 7);
});

test('billett til et annet arrangement gir «feil arrangement»', async () => {
  const { app, checkin } = await setup();
  const other = await createEvent(app, { title: 'Et annet arrangement' });
  const reg = await register(app, other.slug, { email: 'annen@example.com' });
  const data = await app.request({ path: pathOf(reg.json.ticketsUrl).replace('/b/', '/api/bookings/') });
  const res = await checkin({ token: data.json.tickets[0].path.slice(3) });
  assert.equal(res.status, 409);
  assert.equal(res.json.result, 'wrong_event');
  assert.match(res.json.error, /Et annet arrangement/);
});

test('billettsiden i dørvaktmodus: vanlig kamera-app åpner billetten, og siden sjekker inn', async () => {
  const { app, ticketPaths, staff } = await setup();
  // Siden sier at dette er en dørvakt – selve innsjekkingen er en egen POST (aldri bare ved GET).
  const data = await app.request({ path: ticketPaths[0].replace('/t/', '/api/tickets/'), headers: staff });
  assert.deepEqual(data.json.staff, { name: 'Per Dørvakt' });
  assert.deepEqual(data.json.checkin, { id: data.json.checkin.id });
  const admin = await app.request({ path: ticketPaths[0], headers: staff });
  assert.equal(admin.status, 200);
  const stillOut = await app.request({ path: ticketPaths[0].replace('/t/', '/api/tickets/') });
  assert.equal(stillOut.json.tickets[0].checkedInAt, null, 'å åpne lenken sjekker ikke inn');

  // En ugyldig billett gir en rød side for dørvakten, men den nakne 404-en for alle andre.
  const invalid = '/t/abcdefghjkXXXXXXXXXXXXXXXXXXXXXX';
  const forStaff = await app.request({ path: invalid, headers: staff });
  assert.equal(forStaff.status, 404);
  assert.match(forStaff.headers['content-type'], /text\/html/);
  const forOthers = await app.request({ path: invalid });
  assert.equal(forOthers.text, 'Not Found');
  const api = await app.request({ path: invalid.replace('/t/', '/api/tickets/'), headers: staff });
  assert.equal(api.json.invalid, true);
});

test('dørvakt for et annet arrangement får beskjed om feil arrangement', async () => {
  const { app, staff } = await setup();
  const other = await createEvent(app);
  const reg = await register(app, other.slug, { email: 'annen@example.com' });
  const data = await app.request({ path: pathOf(reg.json.ticketsUrl).replace('/b/', '/api/bookings/'), headers: staff });
  assert.equal(data.json.staff, null);
  assert.equal(data.json.wrongEvent, true);
});

test('ny dørvaktlenke: den gamle nøkkelen og alle innlogginger slutter å virke', async () => {
  const { app, slug, key, admin, checkin, tokens } = await setup();
  const rotated = await app.request({ method: 'POST', path: `/api/admin/events/${slug}/scanner/rotate`, headers: admin });
  const newKey = rotated.json.scannerUrl.split('#')[1];
  assert.notEqual(newKey, key);
  assert.equal((await checkin({ token: tokens[0] })).status, 401);
  assert.equal((await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/login`, body: { key } })).status, 401);
  const login = await app.request({ method: 'POST', path: `/api/events/${slug}/scanner/login`, body: { key: newKey } });
  assert.equal((await checkin({ token: tokens[0] }, { cookie: cookieHeader(login) })).json.result, 'checked_in');
});

test('forespørsler fra et annet nettsted avvises (CSRF)', async () => {
  const { checkin, staff, tokens } = await setup();
  const res = await checkin({ token: tokens[0] }, { ...staff, origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('listen for bruk uten nett: bare navn og hasher, og køen tar med tidspunktet', async () => {
  const { app, slug, staff, tokens, booking, checkin } = await setup();
  const status = await app.request({ path: `/api/events/${slug}/scanner`, headers: staff });
  assert.equal(status.json.offline.length, 2);
  const [ola] = status.json.offline;
  assert.equal(ola.token, sha(tokens[0]));
  assert.equal(ola.code, sha(booking.tickets[0].code.toLowerCase().replaceAll('-', '')));
  assert.ok(!JSON.stringify(status.json).includes('@example.com'));
  assert.ok(!JSON.stringify(status.json.offline).includes(tokens[0]), 'selve nøklene sendes ikke');

  // En innsjekking fra køen får tiden den skjedde – men aldri en tid i fremtiden eller for lenge siden.
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const res = await checkin({ token: tokens[0], at });
  assert.equal(res.json.person.checkedInAt, at);
  const future = await checkin({ token: tokens[1], at: '2999-01-01T00:00:00.000Z' });
  assert.ok(Date.parse(future.json.person.checkedInAt) <= Date.now());
});

test('admin: innsjekking og angre fra listen, med teller og CSV', async () => {
  const { app, slug, admin } = await setup();
  const list = await app.request({ path: `/api/admin/events/${slug}`, headers: admin });
  const [ola] = list.json.registrations;
  assert.equal(list.json.event.checkedIn, 0);
  assert.match(ola.ticketUrl, /\/t\//);
  const done = await app.request({ method: 'POST', path: `/api/admin/events/${slug}/registrations/${ola.id}/checkin`, headers: admin });
  assert.ok(done.json.registration.checkedInAt);
  assert.equal(done.json.stats.checkedIn, 1);
  const csv = await app.request({ path: `/api/admin/events/${slug}/registrations.csv`, headers: admin });
  assert.match(csv.text.split('\r\n')[1], /;\d\d\.\d\d\.\d{4}, \d\d:\d\d;[A-HJ-NP-Z]{5}$/);
  const undo = await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}/registrations/${ola.id}/checkin`, headers: admin });
  assert.equal(undo.json.registration.checkedInAt, null);
  // Uten admin-nøkkel: ingen tilgang.
  assert.equal((await app.request({ method: 'POST', path: `/api/admin/events/${slug}/registrations/${ola.id}/checkin` })).status, 401);
});

test('uten billetter finnes verken dørvaktlenke eller innsjekking for dørvakter', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const created = await createEvent(app, { features: { tickets: false } });
  assert.equal(created.scannerUrl, null);
  assert.equal((await app.request({ method: 'POST', path: `/api/events/${created.slug}/scanner/login`, body: { key: 'x' } })).status, 401);
});

test('dørkode: 5 bokstaver per person, unik i arrangementet, i e-posten og i døra', async () => {
  const { app, slug, checkin, booking, staff, admin } = await setup();
  const codes = booking.tickets.map((t) => t.doorCode);
  for (const code of codes) assert.match(code, /^[A-HJ-NP-Z]{5}$/, 'bare bokstaver, uten I og O');
  assert.notEqual(codes[0], codes[1]);

  // Bekreftelsen har dørkoden til hver person – varselet til arrangøren har den ikke.
  const guestMail = app.sent.find((m) => m.to === 'ola@example.com');
  for (const code of codes) assert.match(guestMail.text, new RegExp(`Dørkode: ${code}`));
  const organizerMail = app.sent.find((m) => m.to === 'arrangor@example.com' && m.subject.startsWith('Ny påmelding'));
  assert.doesNotMatch(organizerMail.text, /Dørkode/);

  // Tastet inn med små bokstaver og mellomrom – som en dørvakt ville gjort i farten.
  const res = await checkin({ code: `${codes[1].slice(0, 2).toLowerCase()} ${codes[1].slice(2).toLowerCase()}` });
  assert.equal(res.json.result, 'checked_in');
  assert.equal(res.json.person.name, 'Kari Nordmann');

  // Dørkoden gjelder bare sitt eget arrangement.
  const other = await createEvent(app);
  const reg = await register(app, other.slug, { email: 'annen@example.com' });
  const data = await app.request({ path: pathOf(reg.json.ticketsUrl).replace('/b/', '/api/bookings/') });
  const foreign = data.json.tickets[0].doorCode;
  if (!codes.includes(foreign)) assert.equal((await checkin({ code: foreign })).json.result, 'invalid');

  // Listen for bruk uten nett har dørkodene.
  const status = await app.request({ path: `/api/events/${slug}/scanner`, headers: staff });
  assert.deepEqual(status.json.offline.map((e) => e.door), codes);

  // Admin ser dørkoden, og den står i CSV-filen.
  const list = await app.request({ path: `/api/admin/events/${slug}`, headers: admin });
  assert.deepEqual(list.json.registrations.map((r) => r.doorCode), codes);
});

test('et billettnummer med tall tolkes aldri som dørkode', async () => {
  const { parseDoorCode } = await import('../src/ids.js');
  assert.equal(parseDoorCode('abc de'), 'ABCDE');
  assert.equal(parseDoorCode('ab-cde'), 'ABCDE');
  assert.equal(parseDoorCode('K7HQ-2MXP-R9'), null);
  assert.equal(parseDoorCode('KHQMX2'), null);
  assert.equal(parseDoorCode('ABCIO'), null, 'I og O finnes ikke i dørkoder');
  assert.equal(parseDoorCode('ABCD'), null);
});

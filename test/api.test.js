import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createRepository, openDatabase } from '../src/db.js';

// Kjører hele appen mot en database i minnet, med en falsk e-posttjeneste som bare husker meldingene.

const config = {
  baseUrl: 'https://booking.example.com',
  adminPassword: 'hemmelig',
  timeZone: 'Europe/Oslo',
  trustProxy: false,
  // Testene gjør mange kall på kort tid; selve rate limiteren testes i rateLimit.test.js.
  rateLimits: {
    register: { windowMs: 60_000, max: 1000 },
    cancel: { windowMs: 60_000, max: 1000 },
    create: { windowMs: 60_000, max: 1000 },
  },
};

let server;
let base;
let sent;
let failNextEmail;

before(async () => {
  const repo = createRepository(openDatabase(':memory:'));
  const mailer = {
    async send(message) {
      if (failNextEmail) {
        failNextEmail = false;
        throw new Error('Resend nede');
      }
      sent.push(message);
      return { id: 'test' };
    },
  };
  const logger = { log() {}, error() {} };
  server = createApp({ repo, mailer, config, logger }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  sent = [];
  failNextEmail = false;
});

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const inOneMonth = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

function eventInput(overrides = {}) {
  return {
    title: 'Bunadskurs',
    description: 'Hyggelig kveld',
    location: 'Fannremsgården',
    startsAt: inOneMonth(),
    organizerName: 'Kari Arrangør',
    organizerEmail: 'kari@example.com',
    fields: [
      { label: 'Allergier', type: 'text' },
      { label: 'Middag', type: 'select', options: ['Ja', 'Nei'], required: true },
      { label: 'Samtykke', type: 'checkbox', required: true },
    ],
    ...overrides,
  };
}

async function createEvent(overrides) {
  const res = await call('/api/events', { method: 'POST', body: eventInput(overrides), headers: { 'X-Admin-Password': 'hemmelig' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const { data: event } = await call(`/api/events/${res.data.slug}`);
  sent = [];
  return { ...res.data, event };
}

function answersFor(event, values = {}) {
  const [allergi, middag, samtykke] = event.fields;
  return { [allergi.id]: values.allergi ?? '', [middag.id]: values.middag ?? 'Ja', [samtykke.id]: values.samtykke ?? true };
}

async function register(slug, event, overrides = {}) {
  return call(`/api/events/${slug}/registrations`, {
    method: 'POST',
    body: { name: 'Ola Nordmann', email: 'ola@example.com', answers: answersFor(event), ...overrides },
  });
}

const admin = (key) => ({ Authorization: `Bearer ${key}` });

describe('opprette arrangement', () => {
  test('krever riktig administratorpassord', async () => {
    const none = await call('/api/events', { method: 'POST', body: eventInput() });
    assert.equal(none.status, 401);
    const wrong = await call('/api/events', { method: 'POST', body: eventInput(), headers: { 'X-Admin-Password': 'feil' } });
    assert.equal(wrong.status, 401);
  });

  test('gir tilfeldig lenke og admin-lenke, og sender admin-lenken til arrangøren', async () => {
    const res = await call('/api/events', { method: 'POST', body: eventInput(), headers: { 'X-Admin-Password': 'hemmelig' } });
    assert.equal(res.status, 201);
    assert.match(res.data.slug, /^[a-z2-9]{12}$/);
    assert.equal(res.data.eventUrl, `https://booking.example.com/${res.data.slug}`);
    assert.equal(res.data.adminUrl, `https://booking.example.com/${res.data.slug}/admin#${res.data.adminKey}`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'kari@example.com');
    assert.ok(sent[0].text.includes(res.data.adminUrl));
  });

  test('validerer input', async () => {
    const res = await call('/api/events', {
      method: 'POST',
      body: { title: '', startsAt: 'i morgen', organizerEmail: 'ikke-epost', fields: [{ label: 'Valg', type: 'select', options: [] }] },
      headers: { 'X-Admin-Password': 'hemmelig' },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.data.errors).sort(), ['fields', 'organizerEmail', 'organizerName', 'startsAt', 'title']);
  });

  test('godtar bare https-bilder', async () => {
    const res = await call('/api/events', {
      method: 'POST',
      body: eventInput({ imageUrl: 'javascript:alert(1)' }),
      headers: { 'X-Admin-Password': 'hemmelig' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.data.errors.imageUrl);
  });
});

describe('offentlig arrangementsside', () => {
  test('viser arrangementet uten hemmelige felter', async () => {
    const { slug, event } = await createEvent({ capacity: 10 });
    assert.equal(event.title, 'Bunadskurs');
    assert.equal(event.count, 0);
    assert.equal(event.spotsLeft, 10);
    assert.equal(event.status, 'open');
    assert.equal(event.organizerEmail, undefined);
    assert.equal(event.adminKeyHash, undefined);
    assert.equal(event.id, undefined);

    const page = await fetch(`${base}/${slug}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  });

  test('slug er ikke skille mellom store og små bokstaver', async () => {
    const { slug } = await createEvent();
    assert.equal((await call(`/api/events/${slug.toUpperCase()}`)).status, 200);
  });

  test('ukjent lenke gir 404', async () => {
    assert.equal((await call('/api/events/finnesikke123')).status, 404);
    assert.equal((await fetch(`${base}/finnesikke123`)).status, 404);
  });

  test('skjuler antall og kapasitet når arrangøren ønsker det', async () => {
    const { event } = await createEvent({ capacity: 10, showCount: false });
    assert.equal(event.count, null);
    assert.equal(event.capacity, null);
    assert.equal(event.spotsLeft, null);
  });
});

describe('påmelding', () => {
  test('registrerer gjesten, teller opp og sender e-post til gjest og arrangør', async () => {
    const { slug, event } = await createEvent({ capacity: 5 });
    const res = await register(slug, event, { answers: answersFor(event, { allergi: 'Nøtter' }) });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.emailSent, true);
    assert.equal(res.data.event.count, 1);
    assert.equal(res.data.event.spotsLeft, 4);

    assert.equal(sent.length, 2);
    const guest = sent.find((m) => m.to === 'ola@example.com');
    const organizer = sent.find((m) => m.to === 'kari@example.com');
    assert.equal(guest.replyTo, 'kari@example.com');
    assert.match(guest.text, /Allergier: Nøtter/);
    assert.match(guest.text, new RegExp(`/${slug}/avmelding#`));
    assert.equal(organizer.replyTo, 'ola@example.com');
    assert.match(organizer.text, /1 av 5 plasser/);
  });

  test('validerer navn, e-post og påkrevde felter', async () => {
    const { slug, event } = await createEvent();
    const [, middag, samtykke] = event.fields;
    const res = await register(slug, event, { name: ' ', email: 'feil', answers: { [middag.id]: 'Kanskje', [samtykke.id]: false } });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.data.errors).sort(), ['email', `field_${middag.id}`, `field_${samtykke.id}`, 'name'].sort());
    assert.equal(sent.length, 0);
  });

  test('stopper påmelding når arrangementet er fullt', async () => {
    const { slug, event } = await createEvent({ capacity: 2 });
    assert.equal((await register(slug, event)).status, 201);
    assert.equal((await register(slug, event, { name: 'Kari' })).status, 201);
    const full = await register(slug, event, { name: 'Per' });
    assert.equal(full.status, 409);
    assert.equal(full.data.status, 'full');
    assert.equal((await call(`/api/events/${slug}`)).data.status, 'full');
  });

  test('tar aldri flere enn kapasiteten ved samtidige påmeldinger', async () => {
    const { slug, event } = await createEvent({ capacity: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => register(slug, event, { name: `Gjest ${i}` })));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal((await call(`/api/events/${slug}`)).data.count, 3);
  });

  test('stengt påmelding og utløpt frist avvises', async () => {
    const { slug, event, adminKey } = await createEvent();
    const put = await call(`/api/events/${slug}/admin`, { method: 'PUT', body: eventInput({ isOpen: false }), headers: admin(adminKey) });
    assert.equal(put.status, 200);
    const closed = await register(slug, event);
    assert.equal(closed.status, 409);
    assert.equal(closed.data.status, 'closed');

    const past = await createEvent({ registrationDeadline: new Date(Date.now() - 60_000).toISOString() });
    const late = await register(past.slug, past.event);
    assert.equal(late.status, 409);
    assert.equal(late.data.status, 'deadline_passed');
  });

  test('honningkrukke-feltet later som alt gikk bra, men lagrer ingenting', async () => {
    const { slug, event } = await createEvent();
    const res = await register(slug, event, { website: 'http://spam.example' });
    assert.equal(res.status, 201);
    assert.equal(sent.length, 0);
    assert.equal((await call(`/api/events/${slug}`)).data.count, 0);
  });

  test('påmeldingen lagres selv om e-posten feiler', async () => {
    const { slug, event } = await createEvent();
    failNextEmail = true;
    const res = await register(slug, event);
    assert.equal(res.status, 201);
    assert.equal(res.data.emailSent, false);
    assert.equal(res.data.event.count, 1);
  });
});

describe('avmelding', () => {
  test('gjesten kan melde seg av med nøkkelen fra e-posten', async () => {
    const { slug, event } = await createEvent();
    await register(slug, event);
    const guestMail = sent.find((m) => m.to === 'ola@example.com');
    const token = guestMail.text.match(/avmelding#([\w-]+)/)[1];
    sent = [];

    const lookup = await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.data.name, 'Ola Nordmann');

    const cancel = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token } });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.event.count, 0);
    assert.deepEqual(sent.map((m) => m.to).sort(), ['kari@example.com', 'ola@example.com']);

    const again = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token } });
    assert.equal(again.status, 404);
  });

  test('feil nøkkel gir 404', async () => {
    const { slug } = await createEvent();
    assert.equal((await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token: 'feil' } })).status, 404);
    assert.equal((await call(`/api/events/${slug}/cancel`, { method: 'POST', body: {} })).status, 404);
  });
});

describe('administrasjon', () => {
  test('krever riktig admin-nøkkel for arrangementet', async () => {
    const a = await createEvent();
    const b = await createEvent();
    assert.equal((await call(`/api/events/${a.slug}/admin`)).status, 401);
    assert.equal((await call(`/api/events/${a.slug}/admin`, { headers: admin('feil') })).status, 401);
    // Nøkkelen til ett arrangement gir ikke tilgang til et annet.
    assert.equal((await call(`/api/events/${a.slug}/admin`, { headers: admin(b.adminKey) })).status, 401);
    assert.equal((await call(`/api/events/${a.slug}/admin`, { headers: admin(a.adminKey) })).status, 200);
  });

  test('lister påmeldte, fjerner gjester og eksporterer CSV', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event, { name: '=Formel', answers: answersFor(event, { allergi: 'Gluten; laktose' }) });
    await register(slug, event, { name: 'Kari', email: 'kari2@example.com' });

    const list = await call(`/api/events/${slug}/admin`, { headers: admin(adminKey) });
    assert.equal(list.data.registrations.length, 2);
    assert.equal(list.data.event.organizerEmail, 'kari@example.com');

    const csv = await fetch(`${base}/api/events/${slug}/admin/registrations.csv`, { headers: admin(adminKey) });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="pameldte-/);
    // Leser rå bytes: response.text() fjerner BOM-en, som Excel trenger for å forstå UTF-8.
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString('utf8');
    assert.ok(text.startsWith('#;Påmeldt;Navn;E-post;Allergier;Middag;Samtykke\r\n'));
    assert.match(text, /;'=Formel;/); // CSV-injection nøytralisert
    assert.match(text, /;"Gluten; laktose";/);

    const id = list.data.registrations[0].id;
    const del = await call(`/api/events/${slug}/admin/registrations/${id}`, { method: 'DELETE', headers: admin(adminKey) });
    assert.equal(del.status, 200);
    assert.equal(del.data.count, 1);
  });

  test('redigering beholder felt-id-er og svar', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event, { answers: answersFor(event, { allergi: 'Nøtter' }) });
    const fields = [...event.fields, { label: 'Telefon', type: 'tel' }];
    const put = await call(`/api/events/${slug}/admin`, { method: 'PUT', body: eventInput({ title: 'Nytt navn', fields }), headers: admin(adminKey) });
    assert.equal(put.status, 200);
    assert.equal(put.data.event.title, 'Nytt navn');
    assert.equal(put.data.event.fields[0].id, event.fields[0].id);
    assert.equal(put.data.event.fields.length, 4);

    const list = await call(`/api/events/${slug}/admin`, { headers: admin(adminKey) });
    assert.equal(list.data.registrations[0].answers[event.fields[0].id], 'Nøtter');
  });

  test('sletting fjerner arrangementet og påmeldingene', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event);
    assert.equal((await call(`/api/events/${slug}/admin`, { method: 'DELETE', headers: admin(adminKey) })).status, 200);
    assert.equal((await call(`/api/events/${slug}`)).status, 404);
  });
});

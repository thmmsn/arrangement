import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createRepository, openDatabase } from '../src/db.js';
import { startApp } from './helpers.js';

// Kjører hele appen mot en database i minnet, med en falsk e-posttjeneste som bare husker meldingene.

const config = {
  baseUrl: 'https://events.example.com',
  // Testene kjører uten Cloudflare Access, som ved lokal utvikling.
  adminNoAuth: true,
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
    location: 'Grendehuset',
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
  const res = await call('/api/admin/events', { method: 'POST', body: eventInput(overrides), });
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
  test('uten Cloudflare Access og uten ADMIN_NO_AUTH er oppretting slått av', async () => {
    const closed = await startApp({});
    const res = await closed.request({ method: 'POST', path: '/api/admin/events', body: eventInput() });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /Cloudflare Access er ikke satt opp/);
    assert.equal(closed.sent.length, 0);
  });

  test('gir tilfeldig lenke og admin-lenke, og sender admin-lenken til arrangøren', async () => {
    const res = await call('/api/admin/events', { method: 'POST', body: eventInput(), });
    assert.equal(res.status, 201);
    assert.match(res.data.slug, /^[a-z2-9]{12}$/);
    assert.equal(res.data.eventUrl, `https://events.example.com/${res.data.slug}`);
    assert.equal(res.data.adminUrl, `https://events.example.com/admin/${res.data.slug}#${res.data.adminKey}`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'kari@example.com');
    assert.ok(sent[0].text.includes(res.data.adminUrl));
  });

  test('validerer input', async () => {
    const res = await call('/api/admin/events', {
      method: 'POST',
      body: { title: '', startsAt: 'i morgen', organizerEmail: 'ikke-epost', fields: [{ label: 'Valg', type: 'select', options: [] }] },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.data.errors).sort(), ['fields', 'organizerEmail', 'organizerName', 'startsAt', 'title']);
  });

  test('godtar bare https-bilder', async () => {
    const res = await call('/api/admin/events', {
      method: 'POST',
      body: eventInput({ imageUrl: 'javascript:alert(1)' }),
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
    const put = await call(`/api/admin/events/${slug}`, { method: 'PUT', body: eventInput({ isOpen: false }), headers: admin(adminKey) });
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
    assert.equal(lookup.data.contactName, 'Ola Nordmann');
    assert.deepEqual(lookup.data.persons.map((p) => p.name), ['Ola Nordmann']);

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
    assert.equal((await call(`/api/admin/events/${a.slug}`)).status, 401);
    assert.equal((await call(`/api/admin/events/${a.slug}`, { headers: admin('feil') })).status, 401);
    // Nøkkelen til ett arrangement gir ikke tilgang til et annet.
    assert.equal((await call(`/api/admin/events/${a.slug}`, { headers: admin(b.adminKey) })).status, 401);
    assert.equal((await call(`/api/admin/events/${a.slug}`, { headers: admin(a.adminKey) })).status, 200);
  });

  test('lister påmeldte, fjerner gjester og eksporterer CSV', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event, { name: '=Formel', answers: answersFor(event, { allergi: 'Gluten; laktose' }) });
    await register(slug, event, { name: 'Kari', email: 'kari2@example.com' });

    const list = await call(`/api/admin/events/${slug}`, { headers: admin(adminKey) });
    assert.equal(list.data.registrations.length, 2);
    assert.equal(list.data.event.organizerEmail, 'kari@example.com');

    const csv = await fetch(`${base}/api/admin/events/${slug}/registrations.csv`, { headers: admin(adminKey) });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="pameldte-/);
    // Leser rå bytes: response.text() fjerner BOM-en, som Excel trenger for å forstå UTF-8.
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString('utf8');
    assert.ok(text.startsWith('#;Påmeldt;Navn;E-post;Påmeldt av;Kontakt-e-post;Allergier;Middag;Samtykke;Etteranmelding;Innsjekket;Dørkode\r\n'));
    assert.match(text, /;'=Formel;/); // CSV-injection nøytralisert
    assert.match(text, /;"Gluten; laktose";/);

    const id = list.data.registrations[0].id;
    const del = await call(`/api/admin/events/${slug}/registrations/${id}`, { method: 'DELETE', headers: admin(adminKey) });
    assert.equal(del.status, 200);
    assert.equal(del.data.count, 1);
  });

  test('redigering beholder felt-id-er og svar', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event, { answers: answersFor(event, { allergi: 'Nøtter' }) });
    const fields = [...event.fields, { label: 'Telefon', type: 'tel' }];
    const put = await call(`/api/admin/events/${slug}`, { method: 'PUT', body: eventInput({ title: 'Nytt navn', fields }), headers: admin(adminKey) });
    assert.equal(put.status, 200);
    assert.equal(put.data.event.title, 'Nytt navn');
    assert.equal(put.data.event.fields[0].id, event.fields[0].id);
    assert.equal(put.data.event.fields.length, 4);

    const list = await call(`/api/admin/events/${slug}`, { headers: admin(adminKey) });
    assert.equal(list.data.registrations[0].answers[event.fields[0].id], 'Nøtter');
  });

  test('sletting fjerner arrangementet og påmeldingene', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event);
    assert.equal((await call(`/api/admin/events/${slug}`, { method: 'DELETE', headers: admin(adminKey) })).status, 200);
    assert.equal((await call(`/api/events/${slug}`)).status, 404);
  });
});

describe('påmelding av flere personer', () => {
  const guest = (event, name, extra = {}) => ({ name, answers: answersFor(event), ...extra });
  // Avmeldingslenken for hele påmeldingen står nederst; lenkene over den gjelder hver sin person.
  const cancelTokensFromMail = () => [...sent.find((m) => m.to === 'ola@example.com').text.matchAll(/avmelding#([\w-]+)/g)].map((m) => m[1]);
  const tokenFromMail = () => cancelTokensFromMail().at(-1);

  test('den som melder på kan legge til personer – hver person er én gjest', async () => {
    const { slug, event, adminKey } = await createEvent({ capacity: 10 });
    const res = await register(slug, event, {
      guests: [guest(event, 'Kari', { email: 'kari@example.com' }), guest(event, 'Per', { answers: answersFor(event, { allergi: 'Nøtter' }) })],
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.deepEqual(res.data.booking.persons.map((p) => p.name), ['Ola Nordmann', 'Kari', 'Per']);
    assert.equal(res.data.event.count, 3);
    assert.equal(res.data.event.spotsLeft, 7);

    // Én bekreftelse til den som meldte på, og ett varsel til arrangøren – ikke én per person.
    assert.deepEqual(sent.map((m) => m.to).sort(), ['kari@example.com', 'ola@example.com']);
    assert.match(sent.find((m) => m.to === 'kari@example.com').subject, /Ola Nordmann \+2/);

    const list = await call(`/api/admin/events/${slug}`, { headers: admin(adminKey) });
    const rows = list.data.registrations;
    assert.deepEqual(rows.map((r) => [r.name, r.email, r.position, r.contactName]), [
      ['Ola Nordmann', 'ola@example.com', 0, 'Ola Nordmann'],
      ['Kari', 'kari@example.com', 1, 'Ola Nordmann'],
      ['Per', '', 2, 'Ola Nordmann'],
    ]);
    assert.equal(new Set(rows.map((r) => r.bookingId)).size, 1);
    assert.equal(rows[2].answers[event.fields[0].id], 'Nøtter');
  });

  test('personer som legges til valideres med egne feltnøkler', async () => {
    const { slug, event } = await createEvent();
    const [, middag] = event.fields;
    const res = await register(slug, event, { guests: [{ name: '', email: 'ugyldig', answers: {} }] });
    assert.equal(res.status, 400);
    assert.ok(res.data.errors['guests.0.name']);
    assert.ok(res.data.errors['guests.0.email']);
    assert.ok(res.data.errors[`guests.0.field_${middag.id}`]);
    assert.equal((await call(`/api/events/${slug}`)).data.count, 0);
  });

  test('hele gruppen får plass, eller ingen', async () => {
    const { slug, event } = await createEvent({ capacity: 3 });
    await register(slug, event, { name: 'Først' });
    const res = await register(slug, event, { guests: [guest(event, 'Kari'), guest(event, 'Per')] });
    assert.equal(res.status, 409);
    assert.equal(res.data.status, 'not_enough');
    assert.equal(res.data.spotsLeft, 2);
    assert.match(res.data.error, /bare 2 ledige plasser/);
    assert.equal((await call(`/api/events/${slug}`)).data.count, 1);

    // Med skjult antall røpes ikke hvor mange plasser som er igjen.
    const hidden = await createEvent({ capacity: 2, showCount: false });
    const res2 = await register(hidden.slug, hidden.event, { guests: [guest(hidden.event, 'Kari'), guest(hidden.event, 'Per')] });
    assert.equal(res2.status, 409);
    assert.equal(res2.data.spotsLeft, undefined);
    assert.doesNotMatch(res2.data.error, /\d/);
  });

  test('tar aldri flere enn kapasiteten ved samtidige gruppepåmeldinger', async () => {
    const { slug, event } = await createEvent({ capacity: 5 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      register(slug, event, { name: `Gruppe ${i}`, guests: [guest(event, `Venn ${i}`)] })));
    assert.equal(results.filter((r) => r.status === 201).length, 2);
    assert.equal((await call(`/api/events/${slug}`)).data.count, 4);
  });

  test('arrangøren bestemmer hvor mange som kan meldes på om gangen', async () => {
    const { slug, event } = await createEvent({ maxPerBooking: 2 });
    assert.equal(event.maxPerBooking, 2);
    const tooMany = await register(slug, event, { guests: [guest(event, 'Kari'), guest(event, 'Per')] });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.errors.guests, /maks 2 personer/);
    assert.equal((await register(slug, event, { guests: [guest(event, 'Kari')] })).status, 201);

    const single = await createEvent({ maxPerBooking: 1 });
    const res = await register(single.slug, single.event, { guests: [guest(single.event, 'Kari')] });
    assert.equal(res.status, 400);
    assert.match(res.data.errors.guests, /bare melde på deg selv/);
  });

  test('standard er maks 10 per påmelding, og verdien valideres', async () => {
    const { event } = await createEvent();
    assert.equal(event.maxPerBooking, 10);
    const bad = await call('/api/admin/events', { method: 'POST', body: eventInput({ maxPerBooking: 0 }), });
    assert.equal(bad.status, 400);
    assert.ok(bad.data.errors.maxPerBooking);
  });

  test('avmeldingslenken lar deg melde av noen av personene, eller alle', async () => {
    const { slug, event } = await createEvent();
    await register(slug, event, { guests: [guest(event, 'Kari'), guest(event, 'Per')] });
    const token = tokenFromMail();
    sent = [];

    const lookup = await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } });
    assert.deepEqual(lookup.data.persons.map((p) => p.name), ['Ola Nordmann', 'Kari', 'Per']);
    const [, kari, per] = lookup.data.persons;

    const partial = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token, ids: [kari.id, per.id] } });
    assert.equal(partial.status, 200);
    assert.deepEqual(partial.data.cancelled.map((p) => p.name), ['Kari', 'Per']);
    assert.deepEqual(partial.data.remaining.map((p) => p.name), ['Ola Nordmann']);
    assert.equal(partial.data.event.count, 1);
    assert.match(sent.find((m) => m.to === 'kari@example.com').subject, /Avmelding: Kari og Per/);

    // Lenken virker fortsatt for den som er igjen. Uten ids meldes resten av.
    const rest = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token } });
    assert.equal(rest.status, 200);
    assert.equal(rest.data.event.count, 0);
    // Når alle er meldt av, er påmeldingen borte og lenken slutter å virke.
    assert.equal((await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } })).status, 404);
  });

  test('avmeldingslenken kan ikke melde av personer fra andres påmeldinger', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event, { name: 'Annen', email: 'annen@example.com' });
    await register(slug, event);
    const token = tokenFromMail();
    const list = await call(`/api/admin/events/${slug}`, { headers: admin(adminKey) });
    const other = list.data.registrations.find((r) => r.name === 'Annen');

    const res = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token, ids: [other.id] } });
    assert.equal(res.status, 400);
    assert.equal((await call(`/api/events/${slug}`)).data.count, 2);
    const bad = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token, ids: ['1'] } });
    assert.equal(bad.status, 400);
  });

  test('admin kan fjerne én person fra en gruppe', async () => {
    const { slug, event, adminKey } = await createEvent();
    await register(slug, event, { guests: [guest(event, 'Kari')] });
    const token = tokenFromMail();
    const { data } = await call(`/api/admin/events/${slug}`, { headers: admin(adminKey) });

    // Fjerner kontaktpersonen: Kari står fortsatt, og lenken virker for henne.
    await call(`/api/admin/events/${slug}/registrations/${data.registrations[0].id}`, { method: 'DELETE', headers: admin(adminKey) });
    const lookup = await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } });
    assert.deepEqual(lookup.data.persons.map((p) => p.name), ['Kari']);

    // Fjerner siste person: påmeldingen forsvinner.
    await call(`/api/admin/events/${slug}/registrations/${data.registrations[1].id}`, { method: 'DELETE', headers: admin(adminKey) });
    assert.equal((await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } })).status, 404);
  });

  test('hver person har sin egen avmeldingslenke, som bare melder av den personen', async () => {
    const { slug, event } = await createEvent();
    const res = await register(slug, event, { guests: [guest(event, 'Kari'), guest(event, 'Per')] });
    // Én lenke per person, og til slutt lenken for hele påmeldingen – den samme som siden viser.
    const tokens = cancelTokensFromMail();
    assert.equal(tokens.length, 4);
    assert.equal(new Set(tokens).size, 4);
    assert.equal(new URL(res.data.links.cancel).hash, `#${tokens[3]}`);
    sent = [];

    const lookup = await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token: tokens[1] } });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.data.personal, true);
    assert.deepEqual(lookup.data.persons.map((p) => p.name), ['Kari']);

    // Kari kan ikke melde av de andre med sin lenke.
    const all = await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token: tokens[3] } });
    const [ola, , per] = all.data.persons;
    const other = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token: tokens[1], ids: [ola.id, per.id] } });
    assert.equal(other.status, 400);

    const done = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token: tokens[1] } });
    assert.equal(done.status, 200);
    assert.deepEqual(done.data.cancelled.map((p) => p.name), ['Kari']);
    assert.deepEqual(done.data.remaining, []);
    assert.equal(done.data.event.count, 2);
    // Den som meldte på, får kvittering om at Kari er meldt av.
    assert.match(sent.find((m) => m.to === 'ola@example.com').text, /Nå er Kari meldt av/);
    assert.equal((await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token: tokens[1] } })).status, 404);
  });

  test('billettnøkkelen (QR-koden) og påmeldingsnøkkelen kan ikke brukes til avmelding', async () => {
    const { slug, event } = await createEvent();
    const res = await register(slug, event);
    const bookingToken = new URL(res.data.links.tickets).pathname.split('/')[2];
    const booking = await call(`/api/bookings/${bookingToken}`);
    const ticketToken = booking.data.tickets[0].path.split('/')[2];
    for (const token of [bookingToken, ticketToken]) {
      assert.equal((await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } })).status, 404);
      assert.equal((await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token } })).status, 404);
    }
    assert.equal((await call(`/api/events/${slug}`)).data.count, 1);
    // Siden med alle billettene har avmelding; hver billett har sin egen lenke til å videresende.
    assert.match(booking.data.links.cancel, new RegExp(`^/${slug}/avmelding#`));
    assert.match(booking.data.tickets[0].cancel, new RegExp(`/${slug}/avmelding#`));
    // Enkeltbilletten – det QR-koden peker på – har ingen avmelding.
    const ticket = await call(`/api/tickets/${ticketToken}`);
    assert.equal(ticket.data.links.cancel, null);
    assert.equal(ticket.data.tickets[0].cancel, undefined);
  });

  test('arrangøren kan slå av avmelding: ingen lenker, og API-et avviser', async () => {
    const { slug, event, adminKey } = await createEvent({ features: { selfCancel: false } });
    assert.equal((await call(`/api/admin/events/${slug}`, { headers: admin(adminKey) })).data.event.features.selfCancel, false);
    const res = await register(slug, event, { guests: [guest(event, 'Kari')] });
    assert.equal(res.data.links.cancel, null);
    const mail = sent.find((m) => m.to === 'ola@example.com');
    assert.doesNotMatch(mail.text, /avmelding#/);
    assert.doesNotMatch(mail.html, /avmelding#/);
    assert.match(mail.text, /Svar på denne e-posten/);
    const booking = await call(`/api/bookings/${new URL(res.data.links.tickets).pathname.split('/')[2]}`);
    assert.equal(booking.data.links.cancel, null);
    assert.equal(booking.data.tickets[0].cancel, null);

    // En lenke laget mens avmelding var på, virker ikke etter at den er slått av.
    const denied = await call(`/api/events/${slug}/cancel`, { method: 'POST', body: { token: 'x'.repeat(32) } });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.selfCancelDisabled, true);
    assert.equal((await call(`/api/events/${slug}/cancel/lookup`, { method: 'POST', body: { token: 'x' } })).status, 403);
    assert.equal((await call(`/api/events/${slug}`)).data.count, 2);
  });
});

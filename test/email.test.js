import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMailer, guestCancellation, guestConfirmation, organizerCancellation, organizerNotification } from '../src/email.js';

test('sender riktig forespørsel til Resend', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
  };
  const mailer = createMailer({ apiKey: 're_test', from: 'Påmelding <arrangement@example.com>', fetchImpl });
  const result = await mailer.send({ to: 'ola@example.com', subject: 'Hei', html: '<p>Hei</p>', text: 'Hei', replyTo: 'kari@example.com' });

  assert.equal(result.id, 'abc');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(request.body, {
    from: 'Påmelding <arrangement@example.com>',
    to: ['ola@example.com'],
    subject: 'Hei',
    html: '<p>Hei</p>',
    text: 'Hei',
    reply_to: 'kari@example.com',
  });
});

test('kaster feil når Resend svarer med feilkode', async () => {
  const fetchImpl = async () => new Response('{"message":"Invalid from"}', { status: 422 });
  const mailer = createMailer({ apiKey: 're_test', from: 'x@example.com', fetchImpl });
  await assert.rejects(mailer.send({ to: 'a@example.com', subject: 's', html: 'h', text: 't' }), /422/);
});

test('uten API-nøkkel logges e-posten i stedet for å sendes', async () => {
  const logged = [];
  const mailer = createMailer({ apiKey: '', from: 'x@example.com', fetchImpl: () => assert.fail('skal ikke kalle Resend'), logger: { log: (m) => logged.push(m) } });
  await mailer.send({ to: 'a@example.com', subject: 'Emne', html: 'h', text: 'Tekst' });
  assert.match(logged[0], /Emne/);
});

const event = {
  title: 'Kurs',
  startsAt: '2026-11-14T17:00:00Z',
  endsAt: null,
  location: '',
  organizerName: 'Kari',
  organizerEmail: 'k@example.com',
  capacity: 10,
  fields: [{ id: 'f1', label: 'Allergier', type: 'text' }],
};
const urls = { eventUrl: 'https://events.example.com/abc', cancelUrl: 'https://events.example.com/abc/avmelding#t', timeZone: 'Europe/Oslo' };

test('brukerinnhold escapes i HTML-e-posten', () => {
  const message = guestConfirmation({
    event,
    booking: { contactName: '<script>alert(1)</script>', contactEmail: 'ola@example.com', persons: [{ name: '<script>alert(1)</script>', email: 'ola@example.com', answers: {} }] },
    ...urls,
  });
  assert.ok(!message.html.includes('<script>'));
  assert.ok(message.html.includes('&lt;script&gt;'));
  assert.match(message.text, /lørdag 14\. november 2026 kl\. 18:00/);
});

const group = {
  contactName: 'Ola',
  contactEmail: 'ola@example.com',
  persons: [
    { name: 'Ola', email: 'ola@example.com', answers: { f1: '' } },
    { name: 'Kari', email: '', answers: { f1: 'Nøtter' } },
    { name: 'Per', email: 'per@example.com', answers: {} },
  ],
};

test('bekreftelsen til en gruppe går til kontaktpersonen og lister alle personene', () => {
  const message = guestConfirmation({ event, booking: group, ...urls });
  assert.equal(message.to, 'ola@example.com');
  assert.match(message.text, /Du har meldt på 3 personer: Ola, Kari og Per\./);
  assert.match(message.text, /Person 2\nNavn: Kari\nAllergier: Nøtter/);
  assert.match(message.text, /du velger selv hvem: https:\/\/events\.example\.com\/abc\/avmelding#t/);
});

test('arrangøren får én e-post for hele gruppen', () => {
  const message = organizerNotification({ event, booking: group, count: 3, adminHint: '' });
  assert.equal(message.subject, 'Ny påmelding: Ola +2 – Kurs');
  assert.equal(message.replyTo, 'ola@example.com');
  assert.match(message.text, /Ola \(ola@example\.com\) har meldt på 3 personer/);
  assert.match(message.text, /3 av 10 plasser er tatt/);
});

test('delvis avmelding forteller hvem som er meldt av og hvem som står igjen', () => {
  const [ola, kari, per] = group.persons;
  const guest = guestCancellation({ event, booking: group, cancelled: [kari, per], remaining: [ola], eventUrl: urls.eventUrl });
  assert.match(guest.text, /Nå er Kari og Per meldt av\./);
  assert.match(guest.text, /Fortsatt påmeldt: Ola\./);
  const organizer = organizerCancellation({ event, booking: group, cancelled: [kari, per], count: 1 });
  assert.equal(organizer.subject, 'Avmelding: Kari og Per – Kurs');
});

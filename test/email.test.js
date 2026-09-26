import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMailer, guestConfirmation } from '../src/email.js';

test('sender riktig forespørsel til Resend', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
  };
  const mailer = createMailer({ apiKey: 're_test', from: 'Påmelding <booking@example.com>', fetchImpl });
  const result = await mailer.send({ to: 'ola@example.com', subject: 'Hei', html: '<p>Hei</p>', text: 'Hei', replyTo: 'kari@example.com' });

  assert.equal(result.id, 'abc');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(request.body, {
    from: 'Påmelding <booking@example.com>',
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

test('brukerinnhold escapes i HTML-e-posten', () => {
  const message = guestConfirmation({
    event: { title: 'Kurs', startsAt: '2026-11-14T17:00:00Z', endsAt: null, location: '', organizerName: 'Kari', organizerEmail: 'k@example.com', fields: [] },
    registration: { name: '<script>alert(1)</script>', email: 'ola@example.com', answers: {} },
    eventUrl: 'https://booking.example.com/abc',
    cancelUrl: 'https://booking.example.com/abc/avmelding#t',
    timeZone: 'Europe/Oslo',
  });
  assert.ok(!message.html.includes('<script>'));
  assert.ok(message.html.includes('&lt;script&gt;'));
  assert.match(message.text, /lørdag 14\. november 2026 kl\. 18:00/);
});

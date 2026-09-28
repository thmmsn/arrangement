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
const urls = { eventUrl: 'https://events.example.com/abc', timeZone: 'Europe/Oslo', links: { cancel: 'https://events.example.com/abc/avmelding#t' } };

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

test('ved flere personer får den som meldte på alt for hver person, til å videresende', () => {
  const personLinks = (n) => ({
    ticket: `https://e.no/t/${n}`, apple: `https://e.no/t/${n}/apple`, google: `https://e.no/t/${n}/google`,
    pdf: `https://e.no/t/${n}/pdf`, cancel: `https://e.no/abc/avmelding#p${n}`,
  });
  const booking = { ...group, persons: group.persons.map((p, i) => ({ ...p, doorCode: `KODE${i}`, links: personLinks(i) })) };
  const links = {
    tickets: 'https://e.no/b/x', apple: 'https://e.no/b/x/apple', google: 'https://e.no/b/x/google', pdf: 'https://e.no/b/x/pdf',
    cancel: 'https://e.no/abc/avmelding#alle',
  };
  const message = guestConfirmation({ event, booking, ...urls, links });
  // Alle billettene samlet, med Wallet for alle.
  assert.match(message.text, /Vis billettene: https:\/\/e\.no\/b\/x\n/);
  assert.match(message.text, /Legg alle i Apple Wallet: https:\/\/e\.no\/b\/x\/apple/);
  assert.match(message.text, /Lagre alle i Google Wallet: https:\/\/e\.no\/b\/x\/google/);
  assert.match(message.text, /Videresend lenkene under/);
  // Hver person: dørkode, billett, Wallet, PDF og egen avmelding.
  assert.match(message.text, /Person 2\nNavn: Kari\nAllergier: Nøtter\nDørkode: KODE1\nBillett: https:\/\/e\.no\/t\/1\nLegg til i Apple Wallet: https:\/\/e\.no\/t\/1\/apple\nLagre i Google Wallet: https:\/\/e\.no\/t\/1\/google\nLast ned PDF: https:\/\/e\.no\/t\/1\/pdf\nMeld av: https:\/\/e\.no\/abc\/avmelding#p1/);
  // Wallet-knappene i HTML-en er tydelige knapper, ikke bare tekstlenker.
  assert.match(message.html, /<a href="https:\/\/e\.no\/b\/x\/apple" style="display:inline-block;background:#000000;/);
  assert.match(message.html, /href="https:\/\/e\.no\/abc\/avmelding#p2"/);
  assert.match(message.text, /du velger selv hvem: https:\/\/e\.no\/abc\/avmelding#alle$/);
});

test('uten avmelding på nettet står det at man svarer på e-posten', () => {
  const message = guestConfirmation({ event, booking: group, ...urls, links: {} });
  assert.doesNotMatch(message.text, /avmelding/);
  assert.match(message.text, /Svar på denne e-posten, så får arrangøren beskjed\.$/);
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

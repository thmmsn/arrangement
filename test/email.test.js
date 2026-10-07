import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deadlineReport, eventCancelledGuest, eventCancelledOrganizer, eventCreated, guestCancellation, guestConfirmation,
  organizerCancellation, organizerNotification,
} from '../src/email.js';

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
  // Wallet-knappene i HTML-en er tydelige knapper, ikke bare tekstlenker: lenken står i en svart
  // tabellcelle, så knappen også er en knapp i Outlook for Windows (som ignorerer padding på lenker).
  assert.match(message.html, /<td bgcolor="#000000" style="background:#000000;border-radius:8px;mso-padding-alt:11px 18px;">\s*<a href="https:\/\/e\.no\/b\/x\/apple"/);
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

// Outlook for Windows tegner e-post med Word, som ignorerer det meste av moderne CSS: max-width,
// border-radius og padding på <div>, padding og display på lenker, margin:0 auto på bilder og bakgrunn
// på <body>. Alle e-postene skal derfor bygges med tabeller etter de samme reglene.
test('alle e-postene er bygget for Outlook for Windows (tabeller, ikke div)', () => {
  const persons = [{ name: 'Ola', email: 'ola@example.com', answers: {}, doorCode: 'ABCDE', links: { ticket: 'https://e.no/t/1' } }];
  const deleteAt = new Date('2026-12-14T17:00:00Z');
  const messages = {
    bekreftelse: guestConfirmation({
      event, booking: { contactName: 'Ola', contactEmail: 'ola@example.com', persons }, ...urls,
      links: { tickets: 'https://e.no/b/x', apple: 'https://e.no/b/x/apple', google: 'https://e.no/b/x/google', pdf: 'https://e.no/b/x/pdf', cancel: 'https://e.no/abc/avmelding#p' },
    }),
    varsel: organizerNotification({ event, booking: { contactName: 'Ola', contactEmail: 'ola@example.com', persons }, count: 1 }),
    opprettet: eventCreated({
      event, eventUrl: 'https://e.no/abc', adminUrl: 'https://e.no/admin/abc#k', cancelEventUrl: 'https://e.no/admin/abc/avlys#k',
      scannerUrl: 'https://e.no/dorvakt/abc#d', reportAt: deleteAt, deleteAt, timeZone: 'Europe/Oslo',
    }),
    rapport: deadlineReport({
      event, registrations: [{ name: 'Ola', email: 'ola@example.com', position: 0, bookingId: 1 }], count: 1,
      scannerUrl: 'https://e.no/dorvakt/abc#d', deleteAt, timeZone: 'Europe/Oslo',
    }),
    avlyst: eventCancelledGuest({ event, booking: { contactName: 'Ola', contactEmail: 'ola@example.com' }, message: 'Beklager!', timeZone: 'Europe/Oslo' }),
    avlystKvittering: eventCancelledOrganizer({ event, notified: 1, deleteAt, timeZone: 'Europe/Oslo' }),
    avmelding: guestCancellation({ event, booking: { contactName: 'Ola', contactEmail: 'ola@example.com' }, cancelled: persons, remaining: [], eventUrl: 'https://e.no/abc' }),
    avmeldingVarsel: organizerCancellation({ event, booking: { contactName: 'Ola', contactEmail: 'ola@example.com' }, cancelled: persons, count: 0 }),
  };
  for (const [name, { html }] of Object.entries(messages)) {
    assert.doesNotMatch(html, /<div|<blockquote/, `${name}: ingen div eller blockquote`);
    // Hver tabell har cellpadding, cellspacing og border lik 0 – ellers legger Word på egne mellomrom.
    for (const table of html.match(/<table[^>]*>/g)) {
      assert.match(table, /role="presentation" cellpadding="0" cellspacing="0" border="0"/, `${name}: ${table}`);
    }
    // Bredden: 560 piksler i en tabell bare Outlook ser, max-width for alle andre.
    assert.match(html, /<!--\[if mso\]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" align="center">/, name);
    assert.match(html, /max-width:560px/, name);
    // Bakgrunnsfargen står på tabellen rundt alt, ikke bare på <body>.
    assert.match(html, /<table [^>]*width="100%" bgcolor="#f5efe4"/, name);
    // Ingen lenke har egen bakgrunnsfarge uten å stå i en celle med samme farge (ellers blir den en
    // markering bak teksten i Outlook).
    for (const [, cell, a] of html.matchAll(/(<td[^>]*>)?\s*<a [^>]*style="[^"]*background:(#[0-9a-f]{6})/gi)) {
      assert.ok(cell?.includes(`bgcolor="${a}"`), `${name}: lenke med bakgrunn ${a} utenfor en farget celle`);
    }
    // Avsnitt og overskrifter har egen margin og fast linjehøyde.
    for (const tag of html.match(/<(p|h1|h2|ul|ol) [^>]*>/g) ?? []) {
      assert.match(tag, /margin:/, `${name}: ${tag}`);
      assert.match(tag, /line-height:\d+px;mso-line-height-rule:exactly/, `${name}: ${tag}`);
    }
  }
  // Knappen «Vis billetten» er en farget celle med luft også i Outlook (mso-padding-alt).
  assert.match(messages.bekreftelse.html, /<td bgcolor="#8b2e2a" style="background:#8b2e2a;border-radius:4px;mso-padding-alt:12px 20px;">\s*<a href="https:\/\/e\.no\/b\/x"/);
});

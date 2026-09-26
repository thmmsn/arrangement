import { formatAnswer, formatEventTime } from './format.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Liten klient mot Resends REST-API (https://resend.com/docs/api-reference/emails/send-email).
// Uten API-nøkkel skrives e-posten til konsollen i stedet, slik at alt kan testes lokalt.
export function createMailer({ apiKey, from, fetchImpl = fetch, logger = console }) {
  return {
    async send({ to, subject, html, text, replyTo }) {
      if (!apiKey) {
        logger.log(`\n[e-post – ikke sendt, RESEND_API_KEY mangler]\nTil: ${to}\nEmne: ${subject}\n\n${text}\n`);
        return { id: 'dev' };
      }
      const res = await fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo && { reply_to: replyTo }) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend svarte ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}

// ---------- Maler ----------

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="nb"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f5efe4;font-family:Georgia,'Times New Roman',serif;color:#2b2420;">
  <div style="max-width:560px;margin:0 auto;background:#fffdf8;border:1px solid #e3d9c8;border-radius:6px;padding:32px 28px;">
    ${bodyHtml}
  </div>
</body></html>`;
}

function detailsTable(rows) {
  const html = rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr>
      <td style="padding:6px 16px 6px 0;color:#6b5e53;vertical-align:top;white-space:nowrap;font-family:Arial,sans-serif;font-size:14px;">${escapeHtml(label)}</td>
      <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:14px;">${escapeHtml(value)}</td>
    </tr>`)
    .join('');
  return `<table style="border-collapse:collapse;margin:16px 0;">${html}</table>`;
}

function detailsText(rows) {
  return rows.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
}

function button(href, label) {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#8b2e2a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:4px;font-family:Arial,sans-serif;font-size:15px;">${escapeHtml(label)}</a></p>`;
}

const p = (text) => `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;">${text}</p>`;
const h1 = (text) => `<h1 style="font-weight:normal;font-size:26px;margin:0 0 8px;">${escapeHtml(text)}</h1>`;

function eventRows(event, timeZone) {
  return [
    ['Når', formatEventTime(event.startsAt, event.endsAt, timeZone)],
    ['Hvor', event.location],
    ['Arrangør', event.organizerName],
  ];
}

function personRows(event, person) {
  return [
    ['Navn', person.name],
    ['E-post', person.email],
    ...event.fields.map((field) => [field.label, formatAnswer(field, person.answers)]),
  ];
}

// Én person vises som en enkel tabell; flere personer får hver sin overskrift («Person 1», «Person 2» …).
function personsHtml(event, persons) {
  if (persons.length === 1) return detailsTable(personRows(event, persons[0]));
  return persons.map((person, i) => `
    <h2 style="font-weight:normal;font-size:19px;margin:20px 0 0;">Person ${i + 1}</h2>
    ${detailsTable(personRows(event, person))}`).join('');
}

function personsText(event, persons) {
  if (persons.length === 1) return detailsText(personRows(event, persons[0]));
  return persons.map((person, i) => `Person ${i + 1}\n${detailsText(personRows(event, person))}`).join('\n\n');
}

/** «Ola», «Ola og Kari», «Ola, Kari og Per». */
export function nameList(persons) {
  return new Intl.ListFormat('nb', { type: 'conjunction' }).format(persons.map((p) => p.name));
}

function countText(event, count) {
  return event.capacity != null ? `${count} av ${event.capacity} plasser er tatt` : `${count} påmeldte`;
}

const small = (html) => p(`<span style="color:#6b5e53;font-size:13px;">${html}</span>`);

/**
 * Bekreftelse til den som meldte på. Én e-post for hele påmeldingen, med alle personene.
 * Svar på e-posten går til arrangøren.
 */
export function guestConfirmation({ event, booking, eventUrl, cancelUrl, timeZone }) {
  const { persons, contactName, contactEmail } = booking;
  const several = persons.length > 1;
  const subject = `Påmelding bekreftet: ${event.title}`;
  const intro = several
    ? `Du har meldt på ${persons.length} personer: ${nameList(persons)}.`
    : 'Du er påmeldt.';
  // «Kan du ikke komme likevel? Meld deg av her» – ved flere personer kan man velge hvem som meldes av.
  const cancelLead = several ? 'Kan noen av dere ikke komme likevel? Meld av' : 'Kan du ikke komme likevel? Meld deg av';
  const cancelTail = several ? ' – du velger selv hvem' : '';

  const html = layout(subject, `
    ${h1(event.title)}
    ${p(`Hei ${escapeHtml(contactName)}! ${escapeHtml(intro)}`)}
    ${detailsTable(eventRows(event, timeZone))}
    ${personsHtml(event, persons)}
    ${button(eventUrl, 'Se arrangementet')}
    ${p('Har du spørsmål, kan du svare direkte på denne e-posten.')}
    ${small(`${escapeHtml(cancelLead)} <a href="${escapeHtml(cancelUrl)}" style="color:#8b2e2a;">her</a>${escapeHtml(cancelTail)}, så får noen andre plassen.`)}
  `);
  const text = `Hei ${contactName}!

${intro}

${detailsText(eventRows(event, timeZone))}

${personsText(event, persons)}

Se arrangementet: ${eventUrl}

Har du spørsmål, kan du svare direkte på denne e-posten.

${cancelLead} her${cancelTail}: ${cancelUrl}`;
  return { to: contactEmail, subject, html, text, replyTo: event.organizerEmail };
}

/** Varsel til arrangøren om ny påmelding. Svar på e-posten går til den som meldte på. */
export function organizerNotification({ event, booking, count, adminHint }) {
  const { persons, contactName, contactEmail } = booking;
  const extra = persons.length > 1 ? ` +${persons.length - 1}` : '';
  const subject = `Ny påmelding: ${contactName}${extra} – ${event.title}`;
  const intro = persons.length > 1
    ? `${contactName} (${contactEmail}) har meldt på ${persons.length} personer til ${event.title}.`
    : `${contactName} har meldt seg på ${event.title}.`;

  const html = layout(subject, `
    ${h1('Ny påmelding')}
    ${p(escapeHtml(intro))}
    ${personsHtml(event, persons)}
    ${p(`Status: ${escapeHtml(countText(event, count))}.`)}
    ${small(escapeHtml(adminHint))}
  `);
  const text = `${intro}

${personsText(event, persons)}

Status: ${countText(event, count)}.

${adminHint}`;
  return { to: event.organizerEmail, subject, html, text, replyTo: contactEmail };
}

/** Kvittering til den som meldte på, etter at hele eller deler av påmeldingen er meldt av. */
export function guestCancellation({ event, booking, cancelled, remaining, eventUrl }) {
  const subject = `Avmeldt: ${event.title}`;
  const who = cancelled.length === 1 && cancelled[0].name === booking.contactName && !remaining.length
    ? 'Du er nå meldt av.'
    : `Nå er ${nameList(cancelled)} meldt av.`;
  const rest = remaining.length ? `Fortsatt påmeldt: ${nameList(remaining)}.` : '';
  const html = layout(subject, `
    ${h1(event.title)}
    ${p(`Hei ${escapeHtml(booking.contactName)}! ${escapeHtml(who)} Takk for at du ga beskjed.`)}
    ${rest ? p(escapeHtml(rest)) : ''}
    ${p(`Ombestemmer du deg, kan du melde på igjen <a href="${escapeHtml(eventUrl)}" style="color:#8b2e2a;">her</a> så lenge det er ledige plasser.`)}
  `);
  const text = `Hei ${booking.contactName}!

${who} Takk for at du ga beskjed.
${rest ? `\n${rest}\n` : ''}
Ombestemmer du deg, kan du melde på igjen så lenge det er ledige plasser: ${eventUrl}`;
  return { to: booking.contactEmail, subject, html, text, replyTo: event.organizerEmail };
}

/** Varsel til arrangøren om avmelding. */
export function organizerCancellation({ event, booking, cancelled, count }) {
  const names = nameList(cancelled);
  const subject = `Avmelding: ${names} – ${event.title}`;
  const intro = `${booking.contactName} (${booking.contactEmail}) har meldt av ${names} fra ${event.title}.`;
  const html = layout(subject, `
    ${h1('Avmelding')}
    ${p(escapeHtml(intro))}
    ${p(`Status: ${escapeHtml(countText(event, count))}.`)}
  `);
  const text = `${intro}

Status: ${countText(event, count)}.`;
  return { to: event.organizerEmail, subject, html, text, replyTo: booking.contactEmail };
}

/** Sendes til arrangøren når arrangementet opprettes – inneholder den hemmelige admin-lenken. */
export function eventCreated({ event, eventUrl, adminUrl, timeZone }) {
  const subject = `Arrangementet er opprettet: ${event.title}`;
  const html = layout(subject, `
    ${h1(event.title)}
    ${p('Arrangementet ditt er klart. Del denne lenken med dem som skal kunne melde seg på:')}
    ${p(`<a href="${escapeHtml(eventUrl)}" style="color:#8b2e2a;">${escapeHtml(eventUrl)}</a>`)}
    ${detailsTable(eventRows(event, timeZone))}
    ${p('Administrasjonslenken under gir tilgang til listen over påmeldte og lar deg endre arrangementet. <strong>Ikke del den</strong> – alle som har lenken, er administrator.')}
    ${button(adminUrl, 'Administrer arrangementet')}
  `);
  const text = `Arrangementet ${event.title} er klart.

Del denne lenken med dem som skal kunne melde seg på:
${eventUrl}

${detailsText(eventRows(event, timeZone))}

Administrasjonslenke (IKKE del denne – alle som har den, er administrator):
${adminUrl}`;
  return { to: event.organizerEmail, subject, html, text };
}

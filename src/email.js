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

function answerRows(event, registration) {
  return event.fields.map((field) => [field.label, formatAnswer(field, registration.answers)]);
}

function countText(event, count) {
  return event.capacity != null ? `${count} av ${event.capacity} plasser er tatt` : `${count} påmeldte`;
}

/** Bekreftelse til gjesten etter påmelding. Svar på e-posten går til arrangøren. */
export function guestConfirmation({ event, registration, eventUrl, cancelUrl, timeZone }) {
  const subject = `Påmelding bekreftet: ${event.title}`;
  const rows = [...eventRows(event, timeZone), ['Navn', registration.name], ...answerRows(event, registration)];
  const html = layout(subject, `
    ${h1(event.title)}
    ${p(`Hei ${escapeHtml(registration.name)}! Du er påmeldt. Her er detaljene:`)}
    ${detailsTable(rows)}
    ${button(eventUrl, 'Se arrangementet')}
    ${p(`Har du spørsmål, kan du svare direkte på denne e-posten.`)}
    ${p(`<span style="color:#6b5e53;font-size:13px;">Kan du ikke komme likevel? <a href="${escapeHtml(cancelUrl)}" style="color:#8b2e2a;">Meld deg av her</a>, så får noen andre plassen.</span>`)}
  `);
  const text = `Hei ${registration.name}!

Du er påmeldt ${event.title}.

${detailsText(rows)}

Se arrangementet: ${eventUrl}

Har du spørsmål, kan du svare direkte på denne e-posten.

Kan du ikke komme likevel? Meld deg av her: ${cancelUrl}`;
  return { to: registration.email, subject, html, text, replyTo: event.organizerEmail };
}

/** Varsel til arrangøren om ny påmelding. Svar på e-posten går til gjesten. */
export function organizerNotification({ event, registration, count, adminHint, timeZone }) {
  const subject = `Ny påmelding: ${registration.name} – ${event.title}`;
  const rows = [['Navn', registration.name], ['E-post', registration.email], ...answerRows(event, registration)];
  const html = layout(subject, `
    ${h1('Ny påmelding')}
    ${p(`<strong>${escapeHtml(registration.name)}</strong> har meldt seg på <strong>${escapeHtml(event.title)}</strong>.`)}
    ${detailsTable(rows)}
    ${p(`Status: ${escapeHtml(countText(event, count))}.`)}
    ${p(`<span style="color:#6b5e53;font-size:13px;">${escapeHtml(adminHint)}</span>`)}
  `);
  const text = `${registration.name} har meldt seg på ${event.title}.

${detailsText(rows)}

Status: ${countText(event, count)}.

${adminHint}`;
  return { to: event.organizerEmail, subject, html, text, replyTo: registration.email };
}

/** Kvittering til gjesten etter avmelding. */
export function guestCancellation({ event, registration, eventUrl }) {
  const subject = `Avmeldt: ${event.title}`;
  const html = layout(subject, `
    ${h1(event.title)}
    ${p(`Hei ${escapeHtml(registration.name)}! Du er nå meldt av. Takk for at du ga beskjed.`)}
    ${p(`Ombestemmer du deg, kan du melde deg på igjen <a href="${escapeHtml(eventUrl)}" style="color:#8b2e2a;">her</a> så lenge det er ledige plasser.`)}
  `);
  const text = `Hei ${registration.name}!

Du er nå meldt av ${event.title}. Takk for at du ga beskjed.

Ombestemmer du deg, kan du melde deg på igjen så lenge det er ledige plasser: ${eventUrl}`;
  return { to: registration.email, subject, html, text, replyTo: event.organizerEmail };
}

/** Varsel til arrangøren om avmelding. */
export function organizerCancellation({ event, registration, count }) {
  const subject = `Avmelding: ${registration.name} – ${event.title}`;
  const html = layout(subject, `
    ${h1('Avmelding')}
    ${p(`<strong>${escapeHtml(registration.name)}</strong> (${escapeHtml(registration.email)}) har meldt seg av <strong>${escapeHtml(event.title)}</strong>.`)}
    ${p(`Status: ${escapeHtml(countText(event, count))}.`)}
  `);
  const text = `${registration.name} (${registration.email}) har meldt seg av ${event.title}.

Status: ${countText(event, count)}.`;
  return { to: event.organizerEmail, subject, html, text, replyTo: registration.email };
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

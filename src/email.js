import { formatAnswer, formatEventTime, nameList as formatNames } from './format.js';
import { escapeHtml } from './html.js';
import { DEFAULT_COLORS } from './theme.js';
import { translator } from '../public/assets/i18n/index.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Liten klient mot Resends REST-API (https://resend.com/docs/api-reference/emails/send-email).
// Uten API-nøkkel skrives e-posten til konsollen i stedet, slik at alt kan testes lokalt.
// `from` er standardavsenderen; hver melding kan ha sin egen (nettstedets EMAIL_FROM).
export function createMailer({ apiKey, from: defaultFrom, fetchImpl = fetch, logger = console }) {
  return {
    async send({ from = defaultFrom, to, subject, html, text, replyTo }) {
      if (!apiKey) {
        logger.log(`\n[e-post – ikke sendt, RESEND_API_KEY mangler]\nFra: ${from}\nTil: ${to}\nEmne: ${subject}\n\n${text}\n`);
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
//
// Hver mal får `site` – nettstedet arrangementet hører til – og bruker dets språk (site.t),
// tema (farger og logo) og avsender (site.emailFrom). Lenkene lages av kalleren fra samme nettsted.

export { escapeHtml };

// Nettsted som brukes når ingen er gitt (f.eks. i enkle tester): norsk, standardtema.
const DEFAULT_SITE = {
  t: translator('nb'),
  lang: 'nb',
  emailFrom: undefined,
  theme: { colors: DEFAULT_COLORS, siteName: '', logoAbsoluteUrl: '', logoHeight: 44 },
};

// E-post-HTML må ha stilene inline – e-postklienter ignorerer stilark. Fargene kommer fra temaet
// og er allerede validert (se theme.js), så de kan trygt settes inn i style-attributter.
function emailUi(site) {
  const { theme, t, lang } = site;
  const c = theme.colors;
  const brand = theme.logoAbsoluteUrl
    ? `<img src="${escapeHtml(theme.logoAbsoluteUrl)}" alt="${escapeHtml(theme.siteName || '')}" height="${theme.logoHeight}" style="display:block;height:${theme.logoHeight}px;width:auto;margin:0 auto 20px;border:0;">`
    : theme.siteName
      ? `<p style="text-align:center;margin:0 0 20px;font-family:Arial,sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${c.accent};">${escapeHtml(theme.siteName)}</p>`
      : '';
  const p = (html) => `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;">${html}</p>`;
  const link = (href, labelHtml) => `<a href="${escapeHtml(href)}" style="color:${c.accent};">${labelHtml}</a>`;

  return {
    t,
    lang,
    p,
    link,
    h1: (text) => `<h1 style="font-weight:normal;font-size:26px;margin:0 0 8px;">${escapeHtml(text)}</h1>`,
    layout(title, bodyHtml) {
      return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:${c.background};font-family:Georgia,'Times New Roman',serif;color:${c.text};">
  <div style="max-width:560px;margin:0 auto;">
    ${brand}
    <div style="background:${c.surface};border:1px solid ${c.border};border-radius:6px;padding:32px 28px;">
      ${bodyHtml}
    </div>
  </div>
</body></html>`;
    },
    detailsTable(rows) {
      const html = rows
        .filter(([, value]) => value)
        .map(([label, value]) => `<tr>
          <td style="padding:6px 16px 6px 0;color:${c.muted};vertical-align:top;white-space:nowrap;font-family:Arial,sans-serif;font-size:14px;">${escapeHtml(label)}</td>
          <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:14px;">${escapeHtml(value)}</td>
        </tr>`)
        .join('');
      return `<table style="border-collapse:collapse;margin:16px 0;">${html}</table>`;
    },
    button(href, label) {
      return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:${c.accent};color:${c.accentText};text-decoration:none;padding:12px 20px;border-radius:4px;font-family:Arial,sans-serif;font-size:15px;">${escapeHtml(label)}</a></p>`;
    },
    small(html) {
      return p(`<span style="color:${c.muted};font-size:13px;">${html}</span>`);
    },
    /**
     * En oversatt setning med en lenke midt i: «Meld deg av {link}, så …». Teksten escapes,
     * lenken settes inn som HTML. Setningsbyggingen ligger i ordboken, så den passer hvert språk.
     */
    sentenceWithLink(key, vars, href, labelHtml) {
      const [before, after = ''] = t(key, { ...vars, link: '\u0000' }).split('\u0000');
      return `${escapeHtml(before)}${link(href, labelHtml)}${escapeHtml(after)}`;
    },
  };
}

function detailsText(rows) {
  return rows.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
}

function eventRows(ui, event, timeZone) {
  const { t } = ui;
  return [
    [t('email.when'), formatEventTime(event.startsAt, event.endsAt, timeZone, ui.lang)],
    [t('email.where'), event.location],
    [t('email.organizer'), event.organizerName],
  ];
}

function personRows(ui, event, person) {
  const { t } = ui;
  return [
    [t('email.name'), person.name],
    [t('email.email'), person.email],
    ...event.fields.map((field) => [field.label, formatAnswer(field, person.answers, ui.lang)]),
  ];
}

// Én person vises som en enkel tabell; flere personer får hver sin overskrift («Person 1», «Person 2» …).
function personsHtml(ui, event, persons) {
  if (persons.length === 1) return ui.detailsTable(personRows(ui, event, persons[0]));
  return persons.map((person, i) => `
    <h2 style="font-weight:normal;font-size:19px;margin:20px 0 0;">${escapeHtml(ui.t('email.person', { n: i + 1 }))}</h2>
    ${ui.detailsTable(personRows(ui, event, person))}`).join('');
}

function personsText(ui, event, persons) {
  if (persons.length === 1) return detailsText(personRows(ui, event, persons[0]));
  return persons
    .map((person, i) => `${ui.t('email.person', { n: i + 1 })}\n${detailsText(personRows(ui, event, person))}`)
    .join('\n\n');
}

/** «Ola», «Ola og Kari», «Ola, Kari og Per» – på nettstedets språk. */
export function nameList(persons, lang = 'nb') {
  return formatNames(persons.map((p) => p.name), lang);
}

function countText(ui, event, count) {
  return event.capacity != null
    ? ui.t('email.countWithCapacity', { count, capacity: event.capacity })
    : ui.t('email.countWithoutCapacity', { count });
}

/**
 * Bekreftelse til den som meldte på. Én e-post for hele påmeldingen, med alle personene.
 * Svar på e-posten går til arrangøren.
 */
export function guestConfirmation({ event, booking, eventUrl, cancelUrl, timeZone, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const { persons, contactName, contactEmail } = booking;
  const several = persons.length > 1;
  const subject = t('email.confirmation.subject', { title: event.title });
  const intro = several
    ? t('email.confirmation.introMany', { count: persons.length, names: nameList(persons, ui.lang) })
    : t('email.confirmation.introOne');
  const cancelKey = several ? 'email.confirmation.cancelMany' : 'email.confirmation.cancelOne';

  const html = ui.layout(subject, `
    ${ui.h1(event.title)}
    ${ui.p(`${escapeHtml(t('email.greeting', { name: contactName }))} ${escapeHtml(intro)}`)}
    ${ui.detailsTable(eventRows(ui, event, timeZone))}
    ${personsHtml(ui, event, persons)}
    ${ui.button(eventUrl, t('email.confirmation.viewEvent'))}
    ${ui.p(escapeHtml(t('email.confirmation.questions')))}
    ${ui.small(ui.sentenceWithLink(cancelKey, {}, cancelUrl, escapeHtml(t('email.linkHere'))))}
  `);
  const text = `${t('email.greeting', { name: contactName })}

${intro}

${detailsText(eventRows(ui, event, timeZone))}

${personsText(ui, event, persons)}

${t('email.confirmation.viewEventText', { url: eventUrl })}

${t('email.confirmation.questions')}

${t(`${cancelKey}Text`, { url: cancelUrl })}`;
  return { from: site.emailFrom, to: contactEmail, subject, html, text, replyTo: event.organizerEmail };
}

/** Varsel til arrangøren om ny påmelding. Svar på e-posten går til den som meldte på. */
export function organizerNotification({ event, booking, count, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const { persons, contactName, contactEmail } = booking;
  const extra = persons.length > 1 ? ` +${persons.length - 1}` : '';
  const subject = t('email.notification.subject', { name: contactName, extra, title: event.title });
  const intro = persons.length > 1
    ? t('email.notification.introMany', { name: contactName, email: contactEmail, count: persons.length, title: event.title })
    : t('email.notification.introOne', { name: contactName, title: event.title });
  const status = t('email.status', { text: countText(ui, event, count) });

  const html = ui.layout(subject, `
    ${ui.h1(t('email.notification.heading'))}
    ${ui.p(escapeHtml(intro))}
    ${personsHtml(ui, event, persons)}
    ${ui.p(escapeHtml(status))}
    ${ui.small(escapeHtml(t('email.notification.adminHint')))}
  `);
  const text = `${intro}

${personsText(ui, event, persons)}

${status}

${t('email.notification.adminHint')}`;
  return { from: site.emailFrom, to: event.organizerEmail, subject, html, text, replyTo: contactEmail };
}

/** Kvittering til den som meldte på, etter at hele eller deler av påmeldingen er meldt av. */
export function guestCancellation({ event, booking, cancelled, remaining, eventUrl, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const subject = t('email.guestCancellation.subject', { title: event.title });
  const who = cancelled.length === 1 && cancelled[0].name === booking.contactName && !remaining.length
    ? t('email.guestCancellation.self')
    : t('email.guestCancellation.others', { names: nameList(cancelled, ui.lang) });
  const rest = remaining.length ? t('email.guestCancellation.remaining', { names: nameList(remaining, ui.lang) }) : '';
  const thanks = t('email.guestCancellation.thanks');

  const html = ui.layout(subject, `
    ${ui.h1(event.title)}
    ${ui.p(escapeHtml(`${t('email.greeting', { name: booking.contactName })} ${who} ${thanks}`))}
    ${rest ? ui.p(escapeHtml(rest)) : ''}
    ${ui.p(ui.sentenceWithLink('email.guestCancellation.rebook', {}, eventUrl, escapeHtml(t('email.linkHere'))))}
  `);
  const text = `${t('email.greeting', { name: booking.contactName })}

${who} ${thanks}
${rest ? `\n${rest}\n` : ''}
${t('email.guestCancellation.rebookText', { url: eventUrl })}`;
  return { from: site.emailFrom, to: booking.contactEmail, subject, html, text, replyTo: event.organizerEmail };
}

/** Varsel til arrangøren om avmelding. */
export function organizerCancellation({ event, booking, cancelled, count, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const names = nameList(cancelled, ui.lang);
  const subject = t('email.organizerCancellation.subject', { names, title: event.title });
  const intro = t('email.organizerCancellation.intro', { name: booking.contactName, email: booking.contactEmail, names, title: event.title });
  const status = t('email.status', { text: countText(ui, event, count) });
  const html = ui.layout(subject, `
    ${ui.h1(t('email.organizerCancellation.heading'))}
    ${ui.p(escapeHtml(intro))}
    ${ui.p(escapeHtml(status))}
  `);
  const text = `${intro}

${status}`;
  return { from: site.emailFrom, to: event.organizerEmail, subject, html, text, replyTo: booking.contactEmail };
}

/** Sendes til arrangøren når arrangementet opprettes – inneholder den hemmelige admin-lenken. */
export function eventCreated({ event, eventUrl, adminUrl, timeZone, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const subject = t('email.eventCreated.subject', { title: event.title });
  // «… endre arrangementet. <strong>Ikke del den</strong> – alle som har lenken, er administrator.»
  const [before, after = ''] = t('email.eventCreated.adminInfo', { warning: '\u0000' }).split('\u0000');
  const adminInfo = `${escapeHtml(before)}<strong>${escapeHtml(t('email.eventCreated.adminWarning'))}</strong>${escapeHtml(after)}`;

  const html = ui.layout(subject, `
    ${ui.h1(event.title)}
    ${ui.p(escapeHtml(t('email.eventCreated.intro')))}
    ${ui.p(ui.link(eventUrl, escapeHtml(eventUrl)))}
    ${ui.detailsTable(eventRows(ui, event, timeZone))}
    ${ui.p(adminInfo)}
    ${ui.button(adminUrl, t('email.eventCreated.adminButton'))}
  `);
  const text = `${t('email.eventCreated.introText', { title: event.title })}

${t('email.eventCreated.shareText')}
${eventUrl}

${detailsText(eventRows(ui, event, timeZone))}

${t('email.eventCreated.adminLinkText')}
${adminUrl}`;
  return { from: site.emailFrom, to: event.organizerEmail, subject, html, text };
}

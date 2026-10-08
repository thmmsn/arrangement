import { formatAnswer, formatDateTime, formatEventTime, nameList as formatNames } from './format.js';
import { escapeHtml } from './html.js';
import { DEFAULT_COLORS } from './theme.js';
import { translator } from '../public/assets/i18n/index.js';

// ---------- Maler ----------
//
// Hver mal får `site` – nettstedet arrangementet hører til – og bruker dets språk (site.t),
// tema (farger og logo) og avsender (site.emailFrom). Lenkene lages av kalleren fra samme nettsted.
// Meldingen har med `site`, så logoen kan bygges inn før sending (se embedLogo). Mailer sender den ikke.

export { escapeHtml };

// Nettsted som brukes når ingen er gitt (f.eks. i enkle tester): norsk, standardtema.
const DEFAULT_SITE = {
  t: translator('nb'),
  lang: 'nb',
  emailFrom: undefined,
  theme: { colors: DEFAULT_COLORS, siteName: '', logoAbsoluteUrl: '', logoHeight: 44 },
};

// Logoen øverst i e-posten. Uten `logo` er den en lenke til bildet på nettstedet. Med `logo` (se
// emailLogo.js) er den et bilde bygget inn i e-posten (src="cid:…"), med bredde og høyde som
// attributter – Outlook for Windows ser bare på dem.
// Logoen står i en egen tabellcelle med align="center" (se layout), fordi Outlook for Windows
// ignorerer margin:0 auto på bilder.
function logoImg(theme, logo = null) {
  const alt = escapeHtml(theme.siteName || '');
  if (!logo) {
    return `<img src="${escapeHtml(theme.logoAbsoluteUrl)}" alt="${alt}" height="${theme.logoHeight}" style="display:block;height:${theme.logoHeight}px;width:auto;margin:0 auto;border:0;">`;
  }
  return `<img src="cid:${escapeHtml(logo.cid)}" alt="${alt}" width="${logo.width}" height="${logo.height}" style="display:block;width:${logo.width}px;height:${logo.height}px;margin:0 auto;border:0;">`;
}

/**
 * Bygger logoen inn i e-posten: lenken til logoen byttes med det innebygde bildet, som legges ved med
 * Content-ID. Uten `logo` (kunne ikke lages) eller uten logo i e-posten er meldingen uendret.
 */
export function embedLogo(message, logo) {
  const theme = message.site?.theme;
  if (!logo || !theme?.logoAbsoluteUrl) return message;
  const linked = logoImg(theme);
  if (!message.html?.includes(linked)) return message;
  return {
    ...message,
    html: message.html.replace(linked, () => logoImg(theme, logo)),
    attachments: [
      ...(message.attachments ?? []),
      { filename: `${logo.cid}.png`, content: logo.png, contentType: 'image/png', contentId: logo.cid },
    ],
  };
}

// E-post-HTML må ha stilene inline – e-postklienter ignorerer stilark. Fargene kommer fra temaet
// og er allerede validert (se theme.js), så de kan trygt settes inn i style-attributter.
//
// Outlook for Windows tegner e-post med Word, som bare forstår en liten del av CSS. Derfor:
// - Oppsettet er tabeller, ikke <div>: Word ignorerer max-width, border-radius og padding på <div>.
//   Bredden på 560 piksler settes i en tabell bare Outlook ser (<!--[if mso]>), andre bruker max-width.
// - Bakgrunnsfarger står på tabellceller (bgcolor og background) – ikke på <body> eller <a>. En farge
//   på <a> blir i Word bare en markering bak teksten.
// - Knappene er tabellceller med farge og luft (padding, og mso-padding-alt for Outlook), med lenken inni.
// - Alle tabeller har cellpadding="0" cellspacing="0" border="0", og tekst har fast linjehøyde i piksler
//   (mso-line-height-rule:exactly). Ellers legger Word på sine egne mellomrom mellom radene.
// - Avsnitt har egen margin, så mellomrommene er de samme i alle e-postklienter.
const SANS = 'Arial,Helvetica,sans-serif';
const SERIF = "Georgia,'Times New Roman',serif";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

function emailUi(site) {
  const { theme, t, lang } = site;
  const c = theme.colors;
  const brand = theme.logoAbsoluteUrl
    ? logoImg(theme)
    : theme.siteName
      ? `<p style="margin:0;font-family:${SANS};font-size:13px;line-height:18px;mso-line-height-rule:exactly;letter-spacing:2px;text-transform:uppercase;color:${c.accent};">${escapeHtml(theme.siteName)}</p>`
      : '';
  const p = (html) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:22px;mso-line-height-rule:exactly;color:${c.text};">${html}</p>`;
  const link = (href, labelHtml) => `<a href="${escapeHtml(href)}" style="color:${c.accent};text-decoration:underline;">${labelHtml}</a>`;
  // En knapp: fargen og luften ligger på tabellcellen, så Outlook tegner en ekte knapp.
  const buttonCell = (href, label, { background, color, radius, padding, fontSize, bold = false }) => `<table ${TABLE}><tr>
<td bgcolor="${background}" style="background:${background};border-radius:${radius}px;mso-padding-alt:${padding};">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:${padding};border-radius:${radius}px;background:${background};color:${color};text-decoration:none;font-family:${SANS};font-size:${fontSize}px;line-height:20px;mso-line-height-rule:exactly;${bold ? 'font-weight:bold;' : ''}"><span style="color:${color};">${escapeHtml(label)}</span></a>
</td></tr></table>`;

  return {
    t,
    lang,
    p,
    link,
    h1: (text) => `<h1 style="margin:0 0 16px;font-family:${SERIF};font-weight:normal;font-size:26px;line-height:32px;mso-line-height-rule:exactly;color:${c.text};">${escapeHtml(text)}</h1>`,
    h2: (text) => `<h2 style="margin:24px 0 8px;font-family:${SERIF};font-weight:normal;font-size:19px;line-height:26px;mso-line-height-rule:exactly;color:${c.text};">${escapeHtml(text)}</h2>`,
    layout(title, bodyHtml) {
      return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${c.background};">
<table ${TABLE} width="100%" bgcolor="${c.background}" style="width:100%;background:${c.background};">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table ${TABLE} width="560" align="center"><tr><td><![endif]-->
<table ${TABLE} width="100%" style="width:100%;max-width:560px;">
${brand ? `<tr><td align="center" style="padding:0 0 20px;">${brand}</td></tr>` : ''}
<tr><td bgcolor="${c.surface}" style="background:${c.surface};border:1px solid ${c.border};border-radius:6px;padding:32px 28px;font-family:${SERIF};color:${c.text};">
${bodyHtml}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body></html>`;
    },
    detailsTable(rows) {
      const cell = `font-family:${SANS};font-size:14px;line-height:20px;mso-line-height-rule:exactly;vertical-align:top;`;
      const html = rows
        .filter(([, value]) => value)
        .map(([label, value]) => `<tr><td style="${cell}padding:4px 16px 4px 0;color:${c.muted};white-space:nowrap;">${escapeHtml(label)}</td><td style="${cell}padding:4px 0;color:${c.text};">${escapeHtml(value)}</td></tr>`)
        .join('');
      return `<table ${TABLE} style="border-collapse:collapse;margin:0 0 16px;">${html}</table>`;
    },
    button(href, label) {
      const button = buttonCell(href, label, {
        background: c.accent, color: c.accentText, radius: 4, padding: '12px 20px', fontSize: 15,
      });
      return `<table ${TABLE}><tr><td style="padding:8px 0 24px;">${button}</td></tr></table>`;
    },
    small(html) {
      return `<p style="margin:0 0 16px;font-family:${SANS};font-size:13px;line-height:19px;mso-line-height-rule:exactly;color:${c.muted};">${html}</p>`;
    },
    /**
     * Svarte knapper for Apple Wallet og Google Wallet, side om side. Hver knapp er en tabell med
     * align="left", så de legger seg etter hverandre og brytes til neste linje på smale skjermer – også i
     * Outlook. Den ytre cellen holder på dem, så teksten under ikke legger seg ved siden av.
     */
    walletButtons(buttons) {
      if (!buttons.length) return '';
      const one = ([href, label]) => `<table ${TABLE} align="left"><tr><td style="padding:0 8px 8px 0;">${buttonCell(href, label, {
        background: '#000000', color: '#ffffff', radius: 8, padding: '11px 18px', fontSize: 14, bold: true,
      })}</td></tr></table>`;
      return `<table ${TABLE} width="100%" style="width:100%;"><tr><td style="padding:0 0 8px;">${buttons.map(one).join('')}</td></tr></table>`;
    },
    /** Sitat, f.eks. arrangørens melding ved avlysning: en celle med farget kant til venstre. */
    quote(text) {
      return `<table ${TABLE} width="100%" style="width:100%;margin:0 0 16px;"><tr><td bgcolor="${c.background}" style="background:${c.background};border-left:3px solid ${c.accent};padding:12px 16px;font-family:${SANS};font-size:15px;line-height:22px;mso-line-height-rule:exactly;color:${c.text};white-space:pre-line;">${escapeHtml(text)}</td></tr></table>`;
    },
    /** Punktliste (ul) eller nummerert liste (ol) med faste mellomrom. */
    list(tag, itemsHtml, fontSize = 15) {
      const lineHeight = fontSize === 15 ? 22 : 21;
      return `<${tag} style="margin:0 0 16px;padding-left:22px;font-family:${SANS};font-size:${fontSize}px;line-height:${lineHeight}px;mso-line-height-rule:exactly;color:${c.text};">${itemsHtml.map((item) => `<li style="margin:0 0 4px;">${item}</li>`).join('')}</${tag}>`;
    },
    /** Lenker på én linje, skilt med «·». */
    linkLine(items) {
      return items.length ? p(items.map(([href, label]) => link(href, escapeHtml(label))).join(' &nbsp;·&nbsp; ')) : '';
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
    // Bare i bekreftelsen til gjesten (når arrangementet har billetter): koden som tastes inn i døra.
    [t('ticket.doorCode'), person.doorCode],
  ];
}

// Lenkene for én person i bekreftelsen: billett, Wallet, PDF og avmelding (til å videresende).
function personLinkList(ui, links = {}) {
  const { t } = ui;
  return [
    [links.ticket, t('email.confirmation.ticketLink')],
    [links.apple, t('links.appleWallet')],
    [links.google, t('links.googleWallet')],
    [links.pdf, t('links.pdf')],
    [links.cancel, t('links.cancel')],
  ].filter(([href]) => href);
}

// Én person vises som en enkel tabell; flere personer får hver sin overskrift («Person 1», «Person 2» …)
// og, i bekreftelsen, sine egne lenker (person.links).
function personsHtml(ui, event, persons) {
  if (persons.length === 1) return ui.detailsTable(personRows(ui, event, persons[0]));
  return persons.map((person, i) => `
    ${ui.h2(ui.t('email.person', { n: i + 1 }))}
    ${ui.detailsTable(personRows(ui, event, person))}
    ${ui.linkLine(personLinkList(ui, person.links))}`).join('');
}

function personsText(ui, event, persons) {
  if (persons.length === 1) return detailsText(personRows(ui, event, persons[0]));
  return persons
    .map((person, i) => [
      ui.t('email.person', { n: i + 1 }),
      detailsText(personRows(ui, event, person)),
      ...personLinkList(ui, person.links).map(([href, label]) => `${label}: ${href}`),
    ].join('\n'))
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

// Lenkene under Wallet-knappene: PDF, kalender, veibeskrivelse og arrangementssiden.
function extraLinks(ui, links, eventUrl, several) {
  const { t } = ui;
  return [
    [links.pdf, t(several ? 'links.pdfAll' : 'links.pdf')],
    [links.ics, t('links.calendar')],
    [links.googleCalendar, t('links.googleCalendar')],
    [links.directions, t('links.directions')],
    [links.tickets ? eventUrl : null, t('email.confirmation.viewEvent')],
  ].filter(([href]) => href);
}

/**
 * Bekreftelse til den som meldte på. Én e-post for hele påmeldingen, med alle personene. Den som
 * melder på flere, får alt for hver person (billett, Wallet, PDF og avmelding i person.links) og
 * videresender selv. Svar på e-posten går til arrangøren.
 * `links`: billettside, Wallet, PDF, kalender, veibeskrivelse og avmelding for hele påmeldingen,
 * etter arrangementets brytere. Uten `links.cancel` (avmelding slått av) svarer gjesten på e-posten.
 */
export function guestConfirmation({ event, booking, eventUrl, timeZone, site = DEFAULT_SITE, links = {} }) {
  const ui = emailUi(site);
  const { t } = ui;
  const { persons, contactName, contactEmail } = booking;
  const several = persons.length > 1;
  const subject = t('email.confirmation.subject', { title: event.title });
  const intro = several
    ? t('email.confirmation.introMany', { count: persons.length, names: nameList(persons, ui.lang) })
    : t('email.confirmation.introOne');
  const ticketsLabel = t(several ? 'email.confirmation.viewTickets' : 'email.confirmation.viewTicket');
  const wallets = [
    [links.apple, t(several ? 'links.appleWalletAll' : 'links.appleWallet')],
    [links.google, t(several ? 'links.googleWalletAll' : 'links.googleWallet')],
  ].filter(([href]) => href);
  const extras = extraLinks(ui, links, eventUrl, several);
  const forward = several && links.tickets
    ? t(links.cancel ? 'email.confirmation.forwardInfo' : 'email.confirmation.forwardInfoNoCancel')
    : '';
  const cancelKey = several ? 'email.confirmation.cancelMany' : 'email.confirmation.cancelOne';
  const cancelHtml = links.cancel
    ? ui.sentenceWithLink(cancelKey, {}, links.cancel, escapeHtml(t('email.linkHere')))
    : escapeHtml(t('email.confirmation.cancelByReply'));
  const cancelText = links.cancel ? t(`${cancelKey}Text`, { url: links.cancel }) : t('email.confirmation.cancelByReply');

  const html = ui.layout(subject, `
    ${ui.h1(event.title)}
    ${ui.p(`${escapeHtml(t('email.greeting', { name: contactName }))} ${escapeHtml(intro)}`)}
    ${ui.detailsTable(eventRows(ui, event, timeZone))}
    ${links.tickets ? ui.button(links.tickets, ticketsLabel) : ui.button(eventUrl, t('email.confirmation.viewEvent'))}
    ${ui.walletButtons(wallets)}
    ${ui.linkLine(extras)}
    ${forward ? ui.p(escapeHtml(forward)) : ''}
    ${personsHtml(ui, event, persons)}
    ${ui.small(cancelHtml)}
  `);
  const text = `${t('email.greeting', { name: contactName })}

${intro}

${detailsText(eventRows(ui, event, timeZone))}

${[
    links.tickets ? `${ticketsLabel}: ${links.tickets}` : t('email.confirmation.viewEventText', { url: eventUrl }),
    ...wallets.map(([href, label]) => `${label}: ${href}`),
    ...extras.map(([href, label]) => `${label}: ${href}`),
  ].join('\n')}
${forward ? `\n${forward}\n` : ''}
${personsText(ui, event, persons)}

${cancelText}`;
  return { site, from: site.emailFrom, to: contactEmail, subject, html, text, replyTo: event.organizerEmail };
}

/** Varsel til arrangøren om ny påmelding. Svar på e-posten går til den som meldte på. */
// `late`: påmeldingen kom etter fristen (etteranmelding) – da står det tydelig i emne og overskrift.
export function organizerNotification({ event, booking, count, site = DEFAULT_SITE, late = false }) {
  const ui = emailUi(site);
  const { t } = ui;
  const { persons, contactName, contactEmail } = booking;
  const extra = persons.length > 1 ? ` +${persons.length - 1}` : '';
  const subject = t(late ? 'email.notification.subjectLate' : 'email.notification.subject', { name: contactName, extra, title: event.title });
  const intro = persons.length > 1
    ? t('email.notification.introMany', { name: contactName, email: contactEmail, count: persons.length, title: event.title })
    : t('email.notification.introOne', { name: contactName, title: event.title });
  const status = t('email.status', { text: countText(ui, event, count) });

  const html = ui.layout(subject, `
    ${ui.h1(t(late ? 'email.notification.headingLate' : 'email.notification.heading'))}
    ${ui.p(escapeHtml(intro))}
    ${personsHtml(ui, event, persons)}
    ${ui.p(escapeHtml(status))}
  `);
  const text = `${intro}

${personsText(ui, event, persons)}

${status}`;
  return { site, from: site.emailFrom, to: event.organizerEmail, subject, html, text, replyTo: contactEmail };
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
  return { site, from: site.emailFrom, to: booking.contactEmail, subject, html, text, replyTo: event.organizerEmail };
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
  return { site, from: site.emailFrom, to: event.organizerEmail, subject, html, text, replyTo: booking.contactEmail };
}

// «Dette skjer videre»: e-post per påmelding, rapport ved fristen, etteranmelding og sletting.
function lifecycleLines(ui, { event, timeZone, reportAt, deleteAt }) {
  const { t } = ui;
  const date = (d) => formatDateTime(d.toISOString(), timeZone, ui.lang);
  return [
    t('email.eventCreated.perRegistration'),
    t('email.eventCreated.report', { date: date(reportAt) }),
    event.allowLate ? t('email.eventCreated.lateAllowed') : t('email.eventCreated.lateNotAllowed'),
    t('email.eventCreated.deletion', { date: date(deleteAt) }),
  ];
}

/**
 * Sendes når arrangementet opprettes: til arrangøren, og (forAdmin) til tjenesteadministratoren.
 * Inneholder alt som trengs senere – påmeldingslenke, den hemmelige admin-lenken, dørvaktlenken,
 * lenken for å avlyse, når rapporten kommer og når dataene slettes. Admin-lenken finnes bare her:
 * appen lagrer bare en hash av nøkkelen og kan aldri vise den igjen.
 */
export function eventCreated({
  event, eventUrl, adminUrl, cancelEventUrl, scannerUrl, reportAt, deleteAt, timeZone, site = DEFAULT_SITE,
  forAdmin = false, createdBy = null,
}) {
  const ui = emailUi(site);
  const { t } = ui;
  const subject = t(forAdmin ? 'email.eventCreated.adminSubject' : 'email.eventCreated.subject', { title: event.title });
  // «… endre arrangementet. <strong>Ikke del den</strong> – alle som har lenken, er administrator.»
  const [before, after = ''] = t('email.eventCreated.adminInfo', { warning: '\u0000' }).split('\u0000');
  const adminInfo = `${escapeHtml(before)}<strong>${escapeHtml(t('email.eventCreated.adminWarning'))}</strong>${escapeHtml(after)}`;
  const intro = forAdmin
    ? t('email.eventCreated.adminIntro', { name: event.organizerName, email: event.organizerEmail, title: event.title })
    : t('email.eventCreated.intro');
  const by = forAdmin && createdBy ? t('email.eventCreated.createdBy', { email: createdBy }) : '';
  const lines = reportAt && deleteAt ? lifecycleLines(ui, { event, timeZone, reportAt, deleteAt }) : [];

  const html = ui.layout(subject, `
    ${ui.h1(event.title)}
    ${ui.p(escapeHtml(intro))}
    ${by ? ui.small(escapeHtml(by)) : ''}
    ${ui.p(ui.link(eventUrl, escapeHtml(eventUrl)))}
    ${ui.detailsTable(eventRows(ui, event, timeZone))}
    ${ui.p(adminInfo)}
    ${ui.button(adminUrl, t('email.eventCreated.adminButton'))}
    ${scannerUrl ? `${ui.h2(t('email.eventCreated.scannerHeading'))}${ui.p(escapeHtml(t('email.eventCreated.scannerInfo')))}${ui.p(ui.link(scannerUrl, escapeHtml(scannerUrl)))}` : ''}
    ${lines.length ? `${ui.h2(t('email.eventCreated.nextHeading'))}${ui.list('ul', lines.map(escapeHtml))}` : ''}
    ${cancelEventUrl ? ui.small(ui.sentenceWithLink('email.eventCreated.cancelEvent', {}, cancelEventUrl, escapeHtml(t('email.linkHere')))) : ''}
  `);
  const text = [
    forAdmin ? intro : t('email.eventCreated.introText', { title: event.title }),
    by,
    '',
    t('email.eventCreated.shareText'),
    eventUrl,
    '',
    detailsText(eventRows(ui, event, timeZone)),
    '',
    t('email.eventCreated.adminLinkText'),
    adminUrl,
    ...(scannerUrl ? ['', `${t('email.eventCreated.scannerHeading')}: ${t('email.eventCreated.scannerInfo')}`, scannerUrl] : []),
    ...(lines.length ? ['', `${t('email.eventCreated.nextHeading')}:`, ...lines.map((l) => `- ${l}`)] : []),
    ...(cancelEventUrl ? ['', t('email.eventCreated.cancelEventText', { url: cancelEventUrl })] : []),
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n').replace(/^\n+/, '');
  return { site, from: site.emailFrom, to: event.organizerEmail, subject, html, text };
}

/**
 * Rapport til arrangøren når påmeldingsfristen er nådd: antall, alle påmeldte og CSV med alle svar
 * (legges ved av kalleren). Admin-lenken kan ikke tas med – den finnes bare i den første e-posten.
 */
export function deadlineReport({ event, registrations, count, scannerUrl, deleteAt, timeZone, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const subject = t('email.report.subject', { title: event.title });
  const bookings = new Set(registrations.map((r) => r.bookingId)).size;
  const status = t('email.status', { text: countText(ui, event, count) });
  const summary = t('email.report.summary', { persons: count, bookings });
  const who = (r) => [r.name, r.email || (r.position > 0 ? t('email.report.bookedBy', { name: r.contactName }) : '')].filter(Boolean);
  const late = event.allowLate ? t('email.report.lateAllowed') : t('email.report.lateNotAllowed');
  const deletion = t('email.eventCreated.deletion', { date: formatDateTime(deleteAt.toISOString(), timeZone, ui.lang) });

  const list = registrations.length
    ? ui.list('ol', registrations.map((r) => {
      const [name, extra] = who(r);
      return `${escapeHtml(name)}${extra ? ` <span style="color:${site.theme.colors.muted};">– ${escapeHtml(extra)}</span>` : ''}`;
    }), 14)
    : ui.p(escapeHtml(t('email.report.none')));

  const html = ui.layout(subject, `
    ${ui.h1(event.title)}
    ${ui.p(escapeHtml(t('email.report.intro')))}
    ${ui.detailsTable(eventRows(ui, event, timeZone))}
    ${ui.p(`<strong>${escapeHtml(summary)}</strong> ${escapeHtml(status)}`)}
    ${list}
    ${registrations.length ? ui.small(escapeHtml(t('email.report.csv'))) : ''}
    ${ui.p(escapeHtml(late))}
    ${scannerUrl ? ui.p(`${escapeHtml(t('email.eventCreated.scannerHeading'))}: ${ui.link(scannerUrl, escapeHtml(scannerUrl))}`) : ''}
    ${ui.small(escapeHtml(deletion))}
  `);
  const text = [
    t('email.report.intro'),
    '',
    detailsText(eventRows(ui, event, timeZone)),
    '',
    `${summary} ${status}`,
    ...registrations.map((r, i) => `${i + 1}. ${who(r).join(' – ')}`),
    ...(registrations.length ? ['', t('email.report.csv')] : [t('email.report.none')]),
    '',
    late,
    ...(scannerUrl ? [`${t('email.eventCreated.scannerHeading')}: ${scannerUrl}`] : []),
    '',
    deletion,
  ].join('\n');
  return { site, from: site.emailFrom, to: event.organizerEmail, subject, html, text };
}

/** Til hver påmelding når arrangementet avlyses, med arrangørens melding. Svar går til arrangøren. */
export function eventCancelledGuest({ event, booking, message, timeZone, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const subject = t('email.eventCancelled.subject', { title: event.title });
  const intro = t('email.eventCancelled.intro', { title: event.title, when: formatEventTime(event.startsAt, event.endsAt, timeZone, ui.lang) });
  const quote = message ? ui.quote(message) : '';
  const html = ui.layout(subject, `
    ${ui.h1(event.title)}
    ${ui.p(`${escapeHtml(t('email.greeting', { name: booking.contactName }))} ${escapeHtml(intro)}`)}
    ${message ? ui.p(escapeHtml(t('email.eventCancelled.messageFrom', { name: event.organizerName }))) : ''}
    ${quote}
    ${ui.small(escapeHtml(t('email.eventCancelled.reply')))}
  `);
  const text = [
    t('email.greeting', { name: booking.contactName }),
    '',
    intro,
    ...(message ? ['', t('email.eventCancelled.messageFrom', { name: event.organizerName }), '', message] : []),
    '',
    t('email.eventCancelled.reply'),
  ].join('\n');
  return { site, from: site.emailFrom, to: booking.contactEmail, subject, html, text, replyTo: event.organizerEmail };
}

/** Kvittering til arrangøren (og tjenesteadministratoren) når arrangementet er avlyst. */
export function eventCancelledOrganizer({ event, notified, deleteAt, timeZone, site = DEFAULT_SITE }) {
  const ui = emailUi(site);
  const { t } = ui;
  const subject = t('email.eventCancelled.organizerSubject', { title: event.title });
  const result = notified > 0
    ? t('email.eventCancelled.notified', { count: notified })
    : t('email.eventCancelled.notNotified');
  const deletion = t('email.eventCreated.deletion', { date: formatDateTime(deleteAt.toISOString(), timeZone, ui.lang) });
  const html = ui.layout(subject, `
    ${ui.h1(t('email.eventCancelled.organizerHeading'))}
    ${ui.p(escapeHtml(t('email.eventCancelled.organizerIntro', { title: event.title, name: event.organizerName, email: event.organizerEmail })))}
    ${ui.p(escapeHtml(result))}
    ${ui.small(escapeHtml(deletion))}
  `);
  const text = [t('email.eventCancelled.organizerIntro', { title: event.title, name: event.organizerName, email: event.organizerEmail }), '', result, '', deletion].join('\n');
  return { site, from: site.emailFrom, to: event.organizerEmail, subject, html, text };
}

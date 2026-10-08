// Sending av e-post. Malene (src/email.js) bygger meldingen; her sendes den gjennom én av fire tjenester:
//
//   resend      Resends REST-API                     (RESEND_API_KEY)
//   cloudflare  Cloudflare Email Service, REST-API    (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_TOKEN)
//   microsoft   Microsoft 365 via Microsoft Graph     (MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)
//   smtp        Vanlig SMTP, f.eks. Microsoft 365-relé på kontorets IP, slik kopimaskiner sender (SMTP_*)
//
// Med flere tjenester (MAIL_PROVIDER=cloudflare,microsoft) prøves de i rekkefølge: feiler den første,
// sendes e-posten med den neste. Se loadMailConfig i mailConfig.js for innstillingene.
//
// En melding er { from, to, subject, html, text, replyTo, attachments }, der attachments er
// [{ filename, content: Buffer, contentType, contentId }]. Med contentId er vedlegget et innebygd bilde,
// vist i HTML-en med src="cid:<contentId>" (logoen, se emailLogo.js).
//
// Feil kastes som Error med tjenestens svar i meldingen. `senderRejected: true` betyr at tjenesten ikke
// godtar avsenderen (domenet er ikke verifisert, eller postkassen finnes ikke) – da prøver appen på nytt
// fra hovednettstedets avsender (se sendEmails i app.js).

import nodemailer from 'nodemailer';
import { PROVIDER_NAMES } from './mailConfig.js';

const TIMEOUT_MS = 10_000;

// Høyst så mange e-poster sendes samtidig. Microsoft Graph tillater fire samtidige forespørsler per
// postkasse, og Resend og Cloudflare begrenser hvor mange forespørsler som kan komme per sekund. Ved
// avlysning sendes én e-post per påmelding – de går ut tre og tre i stedet for alle på en gang.
const MAX_CONCURRENT = 3;

// Svarer tjenesten 429 (for mange forespørsler), er ingenting sendt. Da ventes det (Retry-After, eller
// 1, 2 og 4 sekunder) og prøves på nytt – høyst så mange ganger – før neste tjeneste tar over.
const RETRIES_ON_429 = 3;
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * Lager mailer-en appen bruker: `send(message)` og `verify()`.
 *
 * @param {object} options
 * @param {Array<{ id: string } & object>} options.providers  Tjenestene i rekkefølge (fra loadMailConfig).
 *   Tom liste: e-postene skrives til konsollen i stedet (lokal utvikling).
 * @param {string} [options.unavailable]  Når satt: MAIL_PROVIDER er satt, men ingen tjeneste er brukbar.
 *   Da feiler hver sending med denne forklaringen, i stedet for å late som e-posten er sendt.
 * @param {string} options.from  Standardavsenderen; hver melding kan ha sin egen (nettstedets EMAIL_FROM).
 */
export function createMailer({
  providers = [], unavailable = '', from: defaultFrom, fetchImpl = fetch, logger = console,
  createTransport = nodemailer.createTransport, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const post = (url, options) => postWithRetry(fetchImpl, url, options, sleep);
  const transports = providers.map((provider) => ({
    id: provider.id,
    name: PROVIDER_NAMES[provider.id],
    ...TRANSPORTS[provider.id](provider, { fetchImpl, post, createTransport }),
  }));
  const queue = limiter(MAX_CONCURRENT);

  // Tjenestene i rekkefølge: den første som lykkes, vinner. Feiler alle, kastes én feil med alle svarene.
  async function sendWithFallback(message) {
    const errors = [];
    for (const [i, transport] of transports.entries()) {
      try {
        const result = await transport.send(message);
        return { provider: transport.id, ...result };
      } catch (err) {
        errors.push(err);
        const next = transports[i + 1];
        if (next) logger.error(`E-post til ${message.to} via ${transport.name} feilet (${err.message}). Prøver ${next.name}.`);
      }
    }
    if (errors.length === 1) throw errors[0];
    const err = new Error(errors.map((e, i) => `${transports[i].name}: ${e.message}`).join(' | '));
    err.senderRejected = errors.some((e) => e.senderRejected);
    err.errors = errors;
    throw err;
  }

  return {
    async send({ from = defaultFrom, ...rest }) {
      const message = { from, ...rest, attachments: rest.attachments ?? [] };
      if (unavailable) throw new Error(`E-post kan ikke sendes: ${unavailable}`);
      if (!transports.length) return logToConsole(message, logger);
      return queue(() => sendWithFallback(message));
    },

    // Sjekker oppsettet uten å sende noe, der tjenesten har en måte å gjøre det på: logger inn hos Microsoft
    // og kobler til SMTP-tjeneren. Resend og Cloudflare har ingen slik sjekk – de svarer først når noe sendes.
    // Gir [{ provider, ok, message }] og kaster aldri.
    async verify() {
      return Promise.all(transports.map(async (transport) => {
        if (!transport.verify) return { provider: transport.id, ok: null, message: 'kan ikke sjekkes uten å sende' };
        try {
          return { provider: transport.id, ok: true, message: await transport.verify() };
        } catch (err) {
          return { provider: transport.id, ok: false, message: err.message };
        }
      }));
    },
  };
}

function logToConsole({ from, to, subject, text, attachments }, logger) {
  const files = attachments.length ? `\nVedlegg: ${attachments.map((a) => `${a.filename} (${a.content.length} byte)`).join(', ')}` : '';
  logger.log(`\n[e-post – ikke sendt, ingen e-posttjeneste er satt opp (MAIL_PROVIDER)]\nFra: ${from}\nTil: ${to}\nEmne: ${subject}${files}\n\n${text}\n`);
  return { provider: 'console', id: 'dev' };
}

const TRANSPORTS = { resend, cloudflare, microsoft, smtp };

// ---------- Resend ----------
// https://resend.com/docs/api-reference/emails/send-email

function resend({ apiKey }, { post }) {
  return {
    async send({ from, to, subject, html, text, replyTo, attachments }) {
      const res = await post('https://api.resend.com/emails', {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: [to], subject, html, text,
          ...(replyTo && { reply_to: replyTo }),
          // Resend vil ha innholdet som base64.
          ...(attachments.length && {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: base64(a.content),
              ...(a.contentType && { content_type: a.contentType }),
              ...(a.contentId && { content_id: a.contentId }),
            })),
          }),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        // Et domene som ikke er verifisert, gir 403 med «The … domain is not verified».
        throw providerError(`Resend svarte ${res.status}: ${body}`, res.status === 403 && /not verified/i.test(body));
      }
      return res.json();
    },
  };
}

// ---------- Cloudflare Email Service ----------
// POST /accounts/{account_id}/email/sending/send. Feltnavnene følger Cloudflares OpenAPI-beskrivelse
// (EmailSendingSendParams i Cloudflares offisielle Node-SDK): from som { address, name }, reply_to,
// og vedlegg med content (base64), filename, type, disposition og content_id for innebygde bilder.

function cloudflare({ accountId, apiToken }, { post }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`;
  return {
    async send({ from, to, subject, html, text, replyTo, attachments }) {
      const res = await post(url, {
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: addressObject(from, 'address'),
          to: [to],
          subject, html, text,
          ...(replyTo && { reply_to: replyTo }),
          ...(attachments.length && {
            attachments: attachments.map((a) => ({
              content: base64(a.content),
              filename: a.filename,
              type: contentTypeOf(a),
              ...(a.contentId ? { disposition: 'inline', content_id: a.contentId } : { disposition: 'attachment' }),
            })),
          }),
        }),
      });
      const body = await res.text();
      const json = parseJson(body);
      if (!res.ok || json?.success === false) {
        // Avsender på et domene som ikke er satt opp for sending i kontoen.
        throw providerError(`Cloudflare svarte ${res.status}: ${body}`, /sender|not.?verified|domain.?not|sending_disabled/i.test(body));
      }
      // Svaret sier for hver mottaker om e-posten ble levert, lagt i kø eller avvist for godt.
      const bounced = json?.result?.permanent_bounces ?? [];
      if (bounced.length) throw providerError(`Cloudflare: ${bounced.join(', ')} avviste e-posten for godt (permanent bounce).`);
      return { id: json?.result?.delivered?.length ? 'delivered' : 'queued', ...json?.result };
    },
  };
}

// ---------- Microsoft 365 (Microsoft Graph) ----------
// Appen logger inn som seg selv (OAuth 2.0 client credentials, app-registrering i Entra ID med
// applikasjonstillatelsen Mail.Send) og sender fra postkassen som er avsenderen:
//   POST https://graph.microsoft.com/v1.0/users/{avsenderadresse}/sendMail
// Avsenderen må altså være en postkasse i Microsoft 365, gjerne en delt postkasse (gratis, uten lisens).
// Hvert nettsted med egen avsender trenger sin egen postkasse.
//
// - saveToSentItems: false – appen lover at alle data slettes etter DELETE_AFTER_DAYS (se README), så
//   ingen kopi skal bli liggende i «Sendte elementer».
// - Graph tar bare én brødtekst. HTML-en sendes; tekstversjonen brukes ikke.
// - Hele forespørselen kan være på maks 4 MB (vedleggene teller med, som base64).

function microsoft({ tenantId, clientId, clientSecret }, { fetchImpl, post }) {
  let token = null; // { value, expiresAt }
  let pending = null;

  async function accessToken() {
    if (token && Date.now() < token.expiresAt) return token.value;
    // Flere e-poster samtidig deler én innlogging. Feiler den, prøver neste e-post på nytt.
    pending ??= login().finally(() => { pending = null; });
    return pending;
  }

  async function login() {
    const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    const json = parseJson(body);
    if (!res.ok || !json?.access_token) {
      // F.eks. AADSTS7000222: hemmeligheten (MICROSOFT_CLIENT_SECRET) er utløpt.
      throw providerError(`Microsoft-innlogging feilet (${res.status}): ${json?.error_description?.split(/\r?\n| Trace ID:/)[0].trim() ?? body}`);
    }
    // Fornyes fem minutter før det utløper.
    token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) - 300) * 1000 };
    return token.value;
  }

  return {
    async send({ from, to, subject, html, replyTo, attachments }) {
      const sender = addressObject(from, 'address');
      const res = await post(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender.address)}/sendMail`, {
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            from: { emailAddress: sender },
            toRecipients: [{ emailAddress: { address: to } }],
            ...(replyTo && { replyTo: [{ emailAddress: addressObject(replyTo, 'address') }] }),
            ...(attachments.length && {
              attachments: attachments.map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.filename,
                contentType: contentTypeOf(a),
                contentBytes: base64(a.content),
                ...(a.contentId && { contentId: a.contentId, isInline: true }),
              })),
            }),
          },
          saveToSentItems: false,
        }),
      });
      // 202 Accepted, uten innhold: Exchange har tatt imot e-posten og leverer den.
      if (!res.ok) {
        const body = await res.text();
        // 401: innloggingen gjelder ikke lenger (f.eks. tilbakekalt) – neste e-post logger inn på nytt.
        if (res.status === 401) token = null;
        // 404: postkassen finnes ikke. 403: appen har ikke lov til å sende fra den (ErrorAccessDenied,
        // ErrorSendAsDenied – f.eks. utenfor tilgangsomfanget i Exchange).
        throw providerError(`Microsoft 365 svarte ${res.status} for avsenderen ${sender.address}: ${body}`, res.status === 403 || res.status === 404);
      }
      return { id: res.headers?.get?.('request-id') ?? 'accepted' };
    },
    async verify() {
      await accessToken();
      return 'innlogging OK';
    },
  };
}

// ---------- SMTP ----------
// Vanlig SMTP med nodemailer. Typisk oppsett med Microsoft 365, slik kopimaskiner sender:
//   SMTP_HOST=<domene>.mail.protection.outlook.com, port 25, STARTTLS, uten brukernavn – Microsoft
//   kjenner igjen kontorets faste IP-adresse (kobling/connector i Exchange).
// Fungerer også med innlogging (SMTP_USER/SMTP_PASSWORD), f.eks. Cloudflares SMTP-tjener.
//
// tls: 'starttls' (standard) krever kryptert forbindelse – sier tjeneren ikke STARTTLS, sendes ingenting.
//      'tls' er kryptert fra første byte (port 465). 'none' sender ukryptert – bare for en tjener på
//      samme maskin eller et lukket nett.

function smtp({ host, port, tls, user, password }, { createTransport }) {
  const transport = createTransport({
    host,
    port,
    secure: tls === 'tls',
    requireTLS: tls === 'starttls',
    ignoreTLS: tls === 'none',
    ...(user && { auth: { user, pass: password } }),
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: 30_000,
  });
  return {
    async send({ from, to, subject, html, text, replyTo, attachments }) {
      try {
        const info = await transport.sendMail({
          from, to, subject, html, text,
          ...(replyTo && { replyTo }),
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: contentTypeOf(a),
            ...(a.contentId && { cid: a.contentId }),
          })),
        });
        return { id: info.messageId, response: info.response };
      } catch (err) {
        throw smtpError(err);
      }
    },
    async verify() {
      try {
        await transport.verify();
      } catch (err) {
        throw smtpError(err);
      }
      return `tilkobling til ${host}:${port} OK`;
    },
  };

  function smtpError(err) {
    const detail = err.response ?? err.message;
    // Med SMTP_TLS=starttls sendes ingenting før forbindelsen er kryptert.
    if (err.command === 'STARTTLS') {
      return providerError(`SMTP (${host}:${port}): tjeneren krypterer ikke forbindelsen (STARTTLS), så ingenting ble sendt – ${detail}. Bruk SMTP_TLS=tls for port 465.`);
    }
    // 550 5.7.60 (Microsoft 365): har ikke lov til å sende som denne avsenderen.
    // 550 5.7.1 «Sender denied» (Cloudflare): domenet er ikke satt opp for sending.
    return providerError(`SMTP (${host}:${port}): ${detail}`, /5\.7\.60|sender denied|send ?as/i.test(err.response ?? ''));
  }
}

// ---------- Hjelpere ----------

// POST med tidsavbrudd, og nye forsøk når tjenesten svarer 429 (se RETRIES_ON_429).
async function postWithRetry(fetchImpl, url, options, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, { method: 'POST', ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 429 || attempt >= RETRIES_ON_429) return res;
    await sleep(retryDelay(res.headers?.get?.('retry-after'), attempt));
  }
}

// Retry-After i sekunder, ellers 1, 2, 4 … sekunder. Aldri over MAX_RETRY_WAIT_MS.
export function retryDelay(retryAfter, attempt) {
  const seconds = Number(retryAfter);
  const ms = retryAfter != null && retryAfter !== '' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
}

// Høyst `max` oppgaver samtidig; resten venter i kø. En oppgave som blir ferdig, gir plassen sin direkte
// videre til den neste i køen, så ingen nykommer kan snike seg forbi og gjøre dem til flere enn `max`.
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active < max) active += 1;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function providerError(message, senderRejected = false) {
  const err = new Error(message);
  err.senderRejected = senderRejected;
  return err;
}

const base64 = (content) => Buffer.from(content).toString('base64');

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const TYPES = { ics: 'text/calendar', pdf: 'application/pdf', png: 'image/png', csv: 'text/csv' };

function contentTypeOf({ contentType, filename }) {
  return contentType || TYPES[String(filename).split('.').pop().toLowerCase()] || 'application/octet-stream';
}

/**
 * «Navn <adresse>» eller «adresse» som { [key]: adresse, name }. Navnet kan stå i anførselstegn
 * («"Thommesen, Arkitekter" <a@b.no>», se displayName i sites.js); de fjernes.
 */
export function addressObject(value, key = 'address') {
  const match = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(String(value));
  if (!match) return { [key]: String(value).trim() };
  let name = match[1];
  if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return name ? { [key]: match[2], name } : { [key]: match[2] };
}

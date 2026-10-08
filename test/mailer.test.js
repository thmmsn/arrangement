import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { loadMailConfig } from '../src/mailConfig.js';
import { addressObject, createMailer } from '../src/mailer.js';

const quiet = { log() {}, error() {}, warn() {} };
const FROM = 'Thommesen Arkitekter <arrangement@example.no>';
const LOGO = { filename: 'logo.png', content: Buffer.from('png'), contentType: 'image/png', contentId: 'logo' };
const ICS = { filename: 'kurs.ics', content: Buffer.from('ics'), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' };
const MESSAGE = {
  to: 'ola@example.com', subject: 'Påmelding: Kurs', html: '<img src="cid:logo"><p>Hei</p>', text: 'Hei', replyTo: 'kari@example.com',
};

// Falsk fetch som svarer etter tur og husker forespørslene (med JSON- eller skjemakroppen tolket).
function fakeFetch(...responses) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const type = options.headers['Content-Type'];
    const body = type === 'application/json' ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body));
    requests.push({ url, ...options, body });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    const { status = 200, json, headers = {} } = typeof next === 'function' ? next(url) : next;
    return new Response(json === undefined ? null : JSON.stringify(json), { status, headers });
  };
  return { fetchImpl, requests };
}

describe('Resend', () => {
  test('sender riktig forespørsel', async () => {
    const { fetchImpl, requests } = fakeFetch({ json: { id: 'abc' } });
    const mailer = createMailer({ providers: [{ id: 'resend', apiKey: 're_test' }], from: FROM, fetchImpl });
    const result = await mailer.send({ to: 'ola@example.com', subject: 'Hei', html: '<p>Hei</p>', text: 'Hei', replyTo: 'kari@example.com' });

    assert.equal(result.id, 'abc');
    assert.equal(result.provider, 'resend');
    const [request] = requests;
    assert.equal(request.url, 'https://api.resend.com/emails');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer re_test');
    assert.deepEqual(request.body, { from: FROM, to: ['ola@example.com'], subject: 'Hei', html: '<p>Hei</p>', text: 'Hei', reply_to: 'kari@example.com' });
  });

  test('kaster feil når Resend svarer med feilkode – domene som ikke er verifisert, er avvist avsender', async () => {
    const { fetchImpl } = fakeFetch(
      { status: 422, json: { message: 'Invalid from' } },
      { status: 403, json: { message: 'The example.no domain is not verified.' } },
    );
    const mailer = createMailer({ providers: [{ id: 'resend', apiKey: 're_test' }], from: FROM, fetchImpl });
    await assert.rejects(mailer.send(MESSAGE), (err) => /422/.test(err.message) && err.senderRejected === false);
    await assert.rejects(mailer.send(MESSAGE), (err) => /403/.test(err.message) && err.senderRejected === true);
  });
});

describe('Cloudflare', () => {
  const provider = { id: 'cloudflare', accountId: 'acc123', apiToken: 'cf_token' };
  const ok = { json: { success: true, errors: [], messages: [], result: { delivered: ['ola@example.com'], permanent_bounces: [], queued: [] } } };

  test('sender til Email Sending-API-et med avsendernavn, svar-til og innebygd logo', async () => {
    const { fetchImpl, requests } = fakeFetch(ok);
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    const result = await mailer.send({ ...MESSAGE, attachments: [LOGO, ICS, { filename: 'liste.csv', content: Buffer.from('a;b') }] });

    assert.equal(result.provider, 'cloudflare');
    assert.deepEqual(result.delivered, ['ola@example.com']);
    const [request] = requests;
    assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer cf_token');
    assert.deepEqual(request.body, {
      from: { address: 'arrangement@example.no', name: 'Thommesen Arkitekter' },
      to: ['ola@example.com'],
      subject: 'Påmelding: Kurs',
      html: MESSAGE.html,
      text: 'Hei',
      reply_to: 'kari@example.com',
      attachments: [
        { content: Buffer.from('png').toString('base64'), filename: 'logo.png', type: 'image/png', disposition: 'inline', content_id: 'logo' },
        { content: Buffer.from('ics').toString('base64'), filename: 'kurs.ics', type: ICS.contentType, disposition: 'attachment' },
        // Uten contentType: typen gjettes fra filnavnet.
        { content: Buffer.from('a;b').toString('base64'), filename: 'liste.csv', type: 'text/csv', disposition: 'attachment' },
      ],
    });
  });

  test('feil fra API-et kastes – avsender som ikke er satt opp, er avvist avsender', async () => {
    const { fetchImpl } = fakeFetch(
      { status: 500, json: { success: false, errors: [{ code: 10002, message: 'email.sending.error.internal_server' }] } },
      { status: 403, json: { success: false, errors: [{ code: 10203, message: 'email.sending.error.email.sending_disabled' }] } },
      { status: 200, json: { success: false, errors: [{ code: 10001, message: 'email.sending.error.invalid_request_schema' }] } },
    );
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    await assert.rejects(mailer.send(MESSAGE), (err) => /Cloudflare svarte 500/.test(err.message) && !err.senderRejected);
    await assert.rejects(mailer.send(MESSAGE), (err) => /sending_disabled/.test(err.message) && err.senderRejected);
    await assert.rejects(mailer.send(MESSAGE), /invalid_request_schema/);
  });

  test('en mottaker som avviser for godt (permanent bounce), gir feil', async () => {
    const { fetchImpl } = fakeFetch({ json: { success: true, result: { delivered: [], permanent_bounces: ['ola@example.com'], queued: [] } } });
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    await assert.rejects(mailer.send(MESSAGE), /ola@example\.com avviste e-posten for godt/);
  });
});

describe('Microsoft 365 (Graph)', () => {
  const provider = { id: 'microsoft', tenantId: 'tenant-id', clientId: 'client-id', clientSecret: 'hemmelig' };
  const TOKEN_URL = 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token';
  const token = (n = 1) => ({ json: { token_type: 'Bearer', expires_in: 3599, access_token: `token-${n}` } });

  test('logger inn med client credentials og sender fra avsenderens postkasse, uten kopi i Sendte elementer', async () => {
    const { fetchImpl, requests } = fakeFetch(token(), { status: 202, headers: { 'request-id': 'req-1' } });
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    const result = await mailer.send({ ...MESSAGE, attachments: [LOGO, ICS] });

    assert.equal(result.provider, 'microsoft');
    assert.equal(result.id, 'req-1');
    const [login, send] = requests;
    assert.equal(login.url, TOKEN_URL);
    assert.deepEqual(login.body, {
      client_id: 'client-id', client_secret: 'hemmelig', scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    });
    assert.equal(send.url, 'https://graph.microsoft.com/v1.0/users/arrangement%40example.no/sendMail');
    assert.equal(send.headers.Authorization, 'Bearer token-1');
    assert.deepEqual(send.body, {
      message: {
        subject: 'Påmelding: Kurs',
        body: { contentType: 'HTML', content: MESSAGE.html },
        from: { emailAddress: { address: 'arrangement@example.no', name: 'Thommesen Arkitekter' } },
        toRecipients: [{ emailAddress: { address: 'ola@example.com' } }],
        replyTo: [{ emailAddress: { address: 'kari@example.com' } }],
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', contentType: 'image/png',
            contentBytes: Buffer.from('png').toString('base64'), contentId: 'logo', isInline: true,
          },
          { '@odata.type': '#microsoft.graph.fileAttachment', name: 'kurs.ics', contentType: ICS.contentType, contentBytes: Buffer.from('ics').toString('base64') },
        ],
      },
      saveToSentItems: false,
    });
  });

  test('innloggingen gjenbrukes – også av e-poster som sendes samtidig', async () => {
    const { fetchImpl, requests } = fakeFetch((url) => (url === TOKEN_URL ? token() : { status: 202 }));
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    await Promise.all([mailer.send(MESSAGE), mailer.send({ ...MESSAGE, to: 'kari@example.com' })]);
    await mailer.send(MESSAGE);
    assert.equal(requests.filter((r) => r.url === TOKEN_URL).length, 1);
    assert.equal(requests.filter((r) => r.url.endsWith('/sendMail')).length, 3);
  });

  test('utløpt hemmelighet gir en forståelig feil, og neste forsøk logger inn på nytt', async () => {
    const expired = {
      status: 401,
      json: { error: 'invalid_client', error_description: "AADSTS7000222: The provided client secret keys for app 'client-id' are expired.\r\nTrace ID: x" },
    };
    const { fetchImpl, requests } = fakeFetch(expired, token(2), { status: 202 });
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    await assert.rejects(mailer.send(MESSAGE), /Microsoft-innlogging feilet \(401\): AADSTS7000222: The provided client secret keys for app 'client-id' are expired\.$/);
    await mailer.send(MESSAGE);
    assert.equal(requests.filter((r) => r.url === TOKEN_URL).length, 2);
  });

  test('401 fra Graph (innloggingen gjelder ikke lenger): neste e-post logger inn på nytt', async () => {
    const { fetchImpl, requests } = fakeFetch(token(1), { status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } }, token(2), { status: 202 });
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    await assert.rejects(mailer.send(MESSAGE), /401/);
    await mailer.send(MESSAGE);
    assert.equal(requests.filter((r) => r.url === TOKEN_URL).length, 2);
    assert.equal(requests.at(-1).headers.Authorization, 'Bearer token-2');
  });

  test('postkasse som ikke finnes eller ikke kan brukes, er avvist avsender', async () => {
    const { fetchImpl } = fakeFetch(
      token(),
      { status: 404, json: { error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } } },
      { status: 403, json: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } },
      { status: 503, json: { error: { code: 'ServiceUnavailable' } } },
    );
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    await assert.rejects(mailer.send(MESSAGE), (err) => /404 for avsenderen arrangement@example\.no/.test(err.message) && err.senderRejected);
    await assert.rejects(mailer.send(MESSAGE), (err) => /ErrorAccessDenied/.test(err.message) && err.senderRejected);
    await assert.rejects(mailer.send(MESSAGE), (err) => /503/.test(err.message) && !err.senderRejected);
  });

  test('verify() logger inn uten å sende noe', async () => {
    const { fetchImpl, requests } = fakeFetch(token());
    const mailer = createMailer({ providers: [provider], from: FROM, fetchImpl });
    assert.deepEqual(await mailer.verify(), [{ provider: 'microsoft', ok: true, message: 'innlogging OK' }]);
    assert.equal(requests.length, 1);
  });
});

// En liten SMTP-tjener for testene: svarer som en ekte tjener og husker hva den mottok.
// `reject` gir svaret på MAIL FROM (f.eks. en 550-feil); uten STARTTLS i EHLO-svaret.
const smtpServers = [];
after(() => smtpServers.forEach((s) => s.close()));

async function fakeSmtpServer({ reject } = {}) {
  const sessions = [];
  const server = net.createServer((socket) => {
    const session = { commands: [], data: '' };
    sessions.push(session);
    let buffer = '';
    let inData = false;
    socket.write('220 test.example ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          session.data = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 OK queued as 1\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        session.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write('250-test.example\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
        else if (verb === 'STARTTLS') socket.write('502 5.5.1 Unrecognized command\r\n');
        else if (verb === 'MAIL') socket.write(reject ? `${reject}\r\n` : '250 2.1.0 OK\r\n');
        else if (verb === 'RCPT') socket.write('250 2.1.5 OK\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 Go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 Bye\r\n'); return; }
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  smtpServers.push(server);
  return { port: server.address().port, sessions };
}

describe('SMTP', () => {
  test('sender en hel e-post: avsender, mottaker, svar-til, HTML og tekst, og logoen som innebygd bilde', async () => {
    const { port, sessions } = await fakeSmtpServer();
    const mailer = createMailer({ providers: [{ id: 'smtp', host: '127.0.0.1', port, tls: 'none', user: '', password: '' }], from: FROM });
    const result = await mailer.send({ ...MESSAGE, attachments: [LOGO, ICS] });

    assert.equal(result.provider, 'smtp');
    assert.match(result.response, /^250/);
    const [session] = sessions;
    assert.ok(session.commands.includes('MAIL FROM:<arrangement@example.no>'), session.commands.join('\n'));
    assert.ok(session.commands.includes('RCPT TO:<ola@example.com>'));
    assert.ok(!session.commands.some((c) => c.startsWith('AUTH')), 'uten brukernavn: ingen innlogging (slik kopimaskiner sender)');
    const mime = session.data;
    assert.match(mime, /^From: Thommesen Arkitekter <arrangement@example\.no>$/m);
    assert.match(mime, /^To: ola@example\.com$/m);
    assert.match(mime, /^Reply-To: kari@example\.com$/m);
    assert.match(mime, /^Subject: =\?UTF-8\?/m, 'æøå i emnet kodes etter RFC 2047');
    assert.match(mime, /multipart\/related/, 'logoen hører til HTML-en');
    assert.match(mime, /^Content-Id: <logo>$/im);
    assert.match(mime, /cid:logo/);
    assert.match(mime, /text\/plain/);
    assert.match(mime, /filename=kurs\.ics/);
  });

  test('med brukernavn logges det inn', async () => {
    const { port, sessions } = await fakeSmtpServer();
    const mailer = createMailer({ providers: [{ id: 'smtp', host: '127.0.0.1', port, tls: 'none', user: 'api_token', password: 'hemmelig' }], from: FROM });
    await mailer.send(MESSAGE);
    const auth = sessions[0].commands.find((c) => c.startsWith('AUTH'));
    assert.equal(auth, `AUTH PLAIN ${Buffer.from('\0api_token\0hemmelig').toString('base64')}`);
  });

  test('STARTTLS kreves som standard: tilbyr ikke tjeneren kryptering, sendes ingenting', async () => {
    const { port, sessions } = await fakeSmtpServer();
    const mailer = createMailer({ providers: [{ id: 'smtp', host: '127.0.0.1', port, tls: 'starttls', user: '', password: '' }], from: FROM });
    const started = Date.now();
    await assert.rejects(mailer.send(MESSAGE), (err) => {
      assert.match(err.message, /^SMTP \(127\.0\.0\.1:\d+\): .*STARTTLS/i);
      return true;
    });
    assert.ok(Date.now() - started < 5000, 'feiler med en gang, ikke etter en tidsavbrudd');
    assert.ok(!sessions.some((s) => s.commands.some((c) => c.startsWith('MAIL'))), 'ingen e-post sendt ukryptert');
  });

  test('Microsoft 365 avviser avsenderen (550 5.7.60): avvist avsender', async () => {
    const { port } = await fakeSmtpServer({ reject: '550 5.7.60 SMTP; Client does not have permissions to send as this sender' });
    const mailer = createMailer({ providers: [{ id: 'smtp', host: '127.0.0.1', port, tls: 'none', user: '', password: '' }], from: FROM });
    await assert.rejects(mailer.send(MESSAGE), (err) => /5\.7\.60/.test(err.message) && err.senderRejected);
  });

  test('verify() kobler til uten å sende', async () => {
    const { port, sessions } = await fakeSmtpServer();
    const mailer = createMailer({ providers: [{ id: 'smtp', host: '127.0.0.1', port, tls: 'none', user: '', password: '' }], from: FROM });
    const [result] = await mailer.verify();
    assert.equal(result.ok, true);
    assert.ok(!sessions.some((s) => s.commands.some((c) => c.startsWith('MAIL'))));
  });
});

describe('reserve og feiltilfeller', () => {
  test('feiler den første tjenesten, sendes e-posten med den neste – og loggen sier fra', async () => {
    const { fetchImpl, requests } = fakeFetch(
      { status: 500, json: { success: false, errors: [{ code: 10002, message: 'email.sending.error.internal_server' }] } },
      { json: { id: 'resend-1' } },
    );
    const errors = [];
    const mailer = createMailer({
      providers: [{ id: 'cloudflare', accountId: 'a', apiToken: 't' }, { id: 'resend', apiKey: 'r' }],
      from: FROM, fetchImpl, logger: { ...quiet, error: (m) => errors.push(m) },
    });
    const result = await mailer.send(MESSAGE);
    assert.equal(result.provider, 'resend');
    assert.equal(requests.length, 2);
    assert.match(errors[0], /^E-post til ola@example\.com via Cloudflare feilet \(Cloudflare svarte 500: .*\)\. Prøver Resend\.$/);
  });

  test('feiler alle, kastes én feil med alle svarene – avvist avsender hos én av dem teller', async () => {
    const { fetchImpl } = fakeFetch(
      { status: 403, json: { message: 'The example.no domain is not verified.' } },
      { status: 500, json: { success: false } },
    );
    const mailer = createMailer({ providers: [{ id: 'resend', apiKey: 'r' }, { id: 'cloudflare', accountId: 'a', apiToken: 't' }], from: FROM, fetchImpl, logger: quiet });
    await assert.rejects(mailer.send(MESSAGE), (err) => /^Resend: Resend svarte 403.* \| Cloudflare: Cloudflare svarte 500/.test(err.message) && err.senderRejected === true);
  });

  test('429 (for mange forespørsler): venter og prøver på nytt, med Retry-After når tjenesten oppgir det', async () => {
    const { fetchImpl, requests } = fakeFetch(
      { status: 429, json: { message: 'Too many requests' }, headers: { 'retry-after': '2' } },
      { status: 429, json: { message: 'Too many requests' } },
      { json: { id: 'ok' } },
    );
    const waits = [];
    const mailer = createMailer({ providers: [{ id: 'resend', apiKey: 'r' }], from: FROM, fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    assert.equal((await mailer.send(MESSAGE)).id, 'ok');
    assert.equal(requests.length, 3);
    assert.deepEqual(waits, [2000, 2000], 'Retry-After: 2 sekunder; deretter 1, 2, 4 … sekunder');
  });

  test('429 hele tiden: gir opp etter tre nye forsøk, så neste tjeneste kan ta over', async () => {
    const { fetchImpl, requests } = fakeFetch((url) => (url.includes('resend')
      ? { status: 429, json: { message: 'Too many requests' } }
      : { json: { success: true, result: { delivered: ['ola@example.com'], permanent_bounces: [], queued: [] } } }));
    const mailer = createMailer({
      providers: [{ id: 'resend', apiKey: 'r' }, { id: 'cloudflare', accountId: 'a', apiToken: 't' }],
      from: FROM, fetchImpl, logger: quiet, sleep: async () => {},
    });
    assert.equal((await mailer.send(MESSAGE)).provider, 'cloudflare');
    assert.equal(requests.filter((r) => r.url.includes('resend')).length, 4);
  });

  test('høyst tre e-poster sendes samtidig – f.eks. når et arrangement med mange påmeldte avlyses', async () => {
    let active = 0;
    let most = 0;
    const fetchImpl = async () => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    };
    const mailer = createMailer({ providers: [{ id: 'resend', apiKey: 'r' }], from: FROM, fetchImpl });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => mailer.send({ ...MESSAGE, to: `gjest${i}@example.com` })));
    assert.equal(results.length, 20);
    assert.equal(most, 3);
  });

  test('uten tjeneste skrives e-posten til konsollen', async () => {
    const logged = [];
    const mailer = createMailer({ providers: [], from: FROM, fetchImpl: () => assert.fail('skal ikke sende'), logger: { log: (m) => logged.push(m) } });
    const result = await mailer.send({ ...MESSAGE, subject: 'Emne' });
    assert.equal(result.provider, 'console');
    assert.match(logged[0], /Emne/);
  });

  test('MAIL_PROVIDER satt, men ingen tjeneste brukbar: sendingen feiler i stedet for å late som', async () => {
    const mailer = createMailer({ providers: [], unavailable: 'ingen e-posttjeneste er brukbar', from: FROM, logger: { log: () => assert.fail('skal ikke logge e-posten') } });
    await assert.rejects(mailer.send(MESSAGE), /E-post kan ikke sendes: ingen e-posttjeneste er brukbar/);
  });
});

test('avsenderadresser med og uten navn', () => {
  assert.deepEqual(addressObject('a@example.no'), { address: 'a@example.no' });
  assert.deepEqual(addressObject('Påmelding <a@example.no>'), { address: 'a@example.no', name: 'Påmelding' });
  assert.deepEqual(addressObject('"Thommesen, Arkitekter" <a@example.no>'), { address: 'a@example.no', name: 'Thommesen, Arkitekter' });
  assert.deepEqual(addressObject('"Si \\"hei\\"" <a@example.no>'), { address: 'a@example.no', name: 'Si "hei"' });
  assert.deepEqual(addressObject('<a@example.no>'), { address: 'a@example.no' });
});

describe('oppsett fra miljøvariabler', () => {
  const CF = { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_EMAIL_TOKEN: 'tok' };
  const MS = { MICROSOFT_TENANT_ID: 't', MICROSOFT_CLIENT_ID: 'c', MICROSOFT_CLIENT_SECRET: 's' };

  test('som før: RESEND_API_KEY alene gir Resend, ingenting gir konsollen', () => {
    assert.deepEqual(loadMailConfig({ RESEND_API_KEY: 're_1' }), { providers: [{ id: 'resend', apiKey: 're_1' }], unavailable: '', warnings: [] });
    assert.deepEqual(loadMailConfig({}), { providers: [], unavailable: '', warnings: [] });
  });

  test('uten MAIL_PROVIDER brukes tjenesten som er satt opp', () => {
    assert.deepEqual(loadMailConfig(CF).providers, [{ id: 'cloudflare', accountId: 'acc', apiToken: 'tok' }]);
    assert.deepEqual(loadMailConfig(MS).providers, [{ id: 'microsoft', tenantId: 't', clientId: 'c', clientSecret: 's' }]);
  });

  test('flere satt opp uten MAIL_PROVIDER: den første brukes, med advarsel', () => {
    const { providers, warnings } = loadMailConfig({ ...MS, ...CF });
    assert.deepEqual(providers.map((p) => p.id), ['cloudflare']);
    assert.match(warnings[0], /MAIL_PROVIDER=cloudflare,microsoft/);
  });

  test('MAIL_PROVIDER med reserve, i den rekkefølgen som er gitt', () => {
    const { providers, warnings } = loadMailConfig({ ...CF, ...MS, MAIL_PROVIDER: ' Microsoft , cloudflare ' });
    assert.deepEqual(providers.map((p) => p.id), ['microsoft', 'cloudflare']);
    assert.deepEqual(warnings, []);
  });

  test('ukjente navn og manglende innstillinger gir advarsler', () => {
    const { providers, warnings } = loadMailConfig({ ...CF, MAIL_PROVIDER: 'sendgrid,microsoft,cloudflare,cloudflare', MICROSOFT_TENANT_ID: 't' });
    assert.deepEqual(providers.map((p) => p.id), ['cloudflare']);
    assert.deepEqual(warnings, [
      'MAIL_PROVIDER: «sendgrid» er ukjent og ignoreres. Gyldige verdier: resend, cloudflare, microsoft, smtp.',
      'MAIL_PROVIDER: «cloudflare» står flere ganger; brukes bare én gang.',
      'E-post via Microsoft 365 er slått av: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET mangler.',
    ]);
  });

  test('MAIL_PROVIDER satt, men ingen tjeneste brukbar: e-post er utilgjengelig (ikke konsollen)', () => {
    const { providers, unavailable } = loadMailConfig({ MAIL_PROVIDER: 'microsoft' });
    assert.deepEqual(providers, []);
    assert.match(unavailable, /MAIL_PROVIDER=microsoft/);
  });

  test('SMTP: STARTTLS på port 587 som standard, porten følger SMTP_TLS', () => {
    const smtp = (env) => loadMailConfig({ MAIL_PROVIDER: 'smtp', SMTP_HOST: 'mx.example.no', ...env });
    assert.deepEqual(smtp({}).providers, [{ id: 'smtp', host: 'mx.example.no', port: 587, tls: 'starttls', user: '', password: '' }]);
    assert.equal(smtp({ SMTP_TLS: 'tls' }).providers[0].port, 465);
    assert.equal(smtp({ SMTP_TLS: 'none' }).providers[0].port, 25);
    assert.equal(smtp({ SMTP_PORT: '25' }).providers[0].port, 25);
    assert.deepEqual(smtp({ SMTP_USER: 'api_token', SMTP_PASSWORD: ' med mellomrom ' }).providers[0].password, ' med mellomrom ');
    assert.match(smtp({ SMTP_TLS: 'ssl' }).warnings[0], /SMTP_TLS="ssl" er ugyldig/);
    assert.match(smtp({ SMTP_PORT: '99999' }).warnings[0], /SMTP_PORT="99999" er ikke et portnummer/);
    assert.match(smtp({ SMTP_PASSWORD: 'x' }).warnings[0], /uten SMTP_USER/);
  });

  test('loadConfig tar med e-postoppsettet og advarslene', () => {
    const config = loadConfig({ MAIL_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'acc' });
    assert.deepEqual(config.mail.providers, []);
    assert.ok(config.mail.unavailable);
    assert.ok(config.warnings.includes('E-post via Cloudflare er slått av: CLOUDFLARE_EMAIL_TOKEN mangler.'));
  });
});

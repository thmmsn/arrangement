import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sharp from 'sharp';
import { embedLogo, guestConfirmation } from '../src/email.js';
import { createMailer } from '../src/mailer.js';
import { createEmailLogo, EMAIL_LOGO_CID, MAX_EMAIL_LOGO_WIDTH } from '../src/emailLogo.js';
import { loadConfig } from '../src/config.js';
import { ticketIcon } from '../src/png.js';
import { createEvent, register, startApp } from './helpers.js';

// Logoen i e-postene bygges inn som PNG (Content-ID), fordi e-postklienter ikke viser SVG og ofte
// ikke henter bilder fra nettet.

// Et lite SVG (20 × 5 i naturlig størrelse, tegnet i 200 × 50): blå venstre halvdel, rød høyre. Liten
// naturlig størrelse avslører om logoen forstørres fra et lite bilde (uskarp) i stedet for å tegnes stort.
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" width="20" height="5">'
  + '<rect width="100" height="50" fill="#0000ff"/><rect x="100" width="100" height="50" fill="#ff0000"/></svg>');
const quiet = { warn() {} };
const fixed = (logo) => () => Promise.resolve(logo);

async function pixel(png, x, y) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.subarray(i, i + 3)];
}

describe('logoen i e-postene', () => {
  test('SVG blir skarp PNG i dobbel oppløsning, med riktig forhold mellom bredde og høyde', async () => {
    const emailLogoFor = createEmailLogo({ logoFor: fixed({ type: 'svg', data: SVG }), logger: quiet });
    const logo = await emailLogoFor({ logoUrl: '/assets/custom/logo.svg', logoHeight: 44 });
    assert.equal(logo.cid, EMAIL_LOGO_CID);
    assert.deepEqual([logo.width, logo.height], [176, 44]); // forholdet 4 : 1 ved høyde 44
    const meta = await sharp(logo.png).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 352, 88]);
    // Tegnet i riktig størrelse, ikke forstørret: skarp overgang midt på, rene farger på hver side.
    assert.deepEqual(await pixel(logo.png, 174, 44), [0, 0, 255]);
    assert.deepEqual(await pixel(logo.png, 178, 44), [255, 0, 0]);
  });

  test('PNG virker også, og en svært bred logo begrenses til bredden på e-posten', async () => {
    const png = await createEmailLogo({ logoFor: fixed({ type: 'png', data: ticketIcon(40, [31, 78, 121]) }), logger: quiet })(
      { logoUrl: '/assets/custom/logo.png', logoHeight: 60 });
    assert.deepEqual([png.width, png.height], [60, 60]);
    assert.deepEqual([(await sharp(png.png).metadata()).width], [120]);

    const wide = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="10"><rect width="1000" height="10"/></svg>');
    const capped = await createEmailLogo({ logoFor: fixed({ type: 'svg', data: wide }), logger: quiet })({ logoUrl: '/x.svg', logoHeight: 44 });
    assert.deepEqual([capped.width, capped.height], [MAX_EMAIL_LOGO_WIDTH, 5]);
  });

  test('en JPEG-logo med EXIF-retning (tatt med mobilen) blir stående riktig vei', async () => {
    // Lagret 80 × 40, retning 6 = skal roteres 90°: vises 40 × 80.
    const jpeg = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#0000ff' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const logo = await createEmailLogo({ logoFor: fixed({ type: 'jpeg', data: jpeg }), logger: quiet })({ logoUrl: '/l.jpg', logoHeight: 44 });
    assert.deepEqual([logo.width, logo.height], [22, 44]);
    const meta = await sharp(logo.png).metadata();
    assert.deepEqual([meta.width, meta.height, meta.orientation], [44, 88, undefined]);
  });

  test('ingen logo, en logo som ikke kan leses, eller et ødelagt bilde gir null – og lages bare én gang', async () => {
    let calls = 0;
    assert.equal(await createEmailLogo({ logoFor: () => { calls++; return Promise.resolve(null); }, logger: quiet })({ logoUrl: '' }), null);
    assert.equal(calls, 0, 'uten LOGO_URL leses ingenting');
    assert.equal(await createEmailLogo({ logoFor: fixed(null), logger: quiet })({ logoUrl: '/x.png', logoHeight: 44 }), null);

    const warnings = [];
    let reads = 0;
    const emailLogoFor = createEmailLogo({
      logoFor: () => { reads++; return Promise.resolve({ type: 'png', data: Buffer.from('ikke et bilde') }); },
      logger: { warn: (m) => warnings.push(m) },
    });
    const theme = { logoUrl: '/assets/custom/ødelagt.png', logoHeight: 44 };
    assert.equal(await emailLogoFor(theme), null);
    assert.equal(await emailLogoFor(theme), null);
    assert.equal(reads, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ødelagt\.png kan ikke bygges inn i e-postene/);
  });

  test('embedLogo bytter lenken med det innebygde bildet og legger det ved med Content-ID', async () => {
    const { mainSite: site } = loadConfig({ DOMAIN: 'events.example.com', LOGO_URL: '/assets/custom/logo.svg', SITE_NAME: 'Eksempel' });
    const message = guestConfirmation({
      event: { title: 'Kurs', startsAt: '2026-11-14T17:00:00Z', location: '', organizerName: 'Kari', organizerEmail: 'k@example.com', fields: [] },
      booking: { contactName: 'Ola', contactEmail: 'ola@example.com', persons: [{ name: 'Ola', email: 'ola@example.com', answers: {} }] },
      eventUrl: 'https://events.example.com/abc', timeZone: 'Europe/Oslo', site,
    });
    assert.equal(embedLogo(message, null), message, 'uten innebygd logo: uendret');

    const logo = await createEmailLogo({ logoFor: fixed({ type: 'svg', data: SVG }), logger: quiet })(site.theme);
    const embedded = embedLogo(message, logo);
    assert.match(embedded.html, /<img src="cid:logo" alt="Eksempel" width="176" height="44" style="display:block;width:176px;height:44px;/);
    assert.doesNotMatch(embedded.html, /logo\.svg/, 'ingen lenke til SVG-en igjen');
    assert.deepEqual(embedded.attachments, [{ filename: 'logo.png', content: logo.png, contentType: 'image/png', contentId: 'logo' }]);
    assert.equal(message.attachments, undefined, 'den opprinnelige meldingen er ikke endret');
  });

  test('Resend får vedlegget som innebygd bilde (content_id)', async () => {
    let body;
    const mailer = createMailer({
      providers: [{ id: 'resend', apiKey: 'nøkkel' }], from: 'a@example.com',
      fetchImpl: async (url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ id: '1' }) }; },
    });
    await mailer.send({
      to: 'b@example.com', subject: 'x', html: '<img src="cid:logo">', text: 'x',
      attachments: [{ filename: 'logo.png', content: Buffer.from('png'), contentType: 'image/png', contentId: 'logo' }, { filename: 'a.ics', content: Buffer.from('ics') }],
    });
    assert.deepEqual(body.attachments, [
      { filename: 'logo.png', content: Buffer.from('png').toString('base64'), content_type: 'image/png', content_id: 'logo' },
      { filename: 'a.ics', content: Buffer.from('ics').toString('base64') },
    ]);
  });

  test('e-postene fra appen har logoen innebygd – og `site` sendes ikke videre', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', LOGO_URL: '/assets/custom/logo.svg', SITE_NAME: 'Eksempel' }, {
      logoFor: fixed({ type: 'svg', data: SVG }),
    });
    const { slug } = await createEvent(app);
    app.sent.length = 0;
    assert.equal((await register(app, slug)).status, 201);
    assert.ok(app.sent.length >= 1);
    for (const message of app.sent) {
      assert.match(message.html, /src="cid:logo"/, message.subject);
      assert.doesNotMatch(message.html, /logo\.svg/);
      const inline = message.attachments.filter((a) => a.contentId === 'logo');
      assert.equal(inline.length, 1);
      assert.equal((await sharp(inline[0].content).metadata()).format, 'png');
      assert.equal('site' in message, false);
    }
  });
});

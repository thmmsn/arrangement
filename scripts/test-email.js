// Sender en test-e-post gjennom hver e-posttjeneste som er satt opp (MAIL_PROVIDER), én tjeneste om gangen
// og fra hvert nettsteds avsender. Da ser du at alle virker – også reservene, som ellers bare brukes når
// den første feiler. E-posten har logoen innebygd og et lite vedlegg, som de ekte e-postene.
//
//   npm run test-email -- deg@domene.no
//   docker compose exec arrangement node scripts/test-email.js deg@domene.no
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createEmailLogo } from '../src/emailLogo.js';
import { escapeHtml } from '../src/html.js';
import { createLogoLoader } from '../src/logo.js';
import { PROVIDER_NAMES } from '../src/mailConfig.js';
import { createMailer } from '../src/mailer.js';

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Bruk: npm run test-email -- deg@domene.no');
  process.exit(2);
}

const config = loadConfig();
for (const warning of config.warnings) console.warn(`ADVARSEL: ${warning}`);
if (config.mail.unavailable) {
  console.error(`E-post kan ikke sendes – ${config.mail.unavailable}`);
  process.exit(1);
}
if (!config.mail.providers.length) {
  console.error('Ingen e-posttjeneste er satt opp. Sett MAIL_PROVIDER og innstillingene for tjenesten (se .env.example).');
  process.exit(1);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const logoFor = createLogoLoader({ brandingDir: path.join(ROOT, 'branding'), assetsDir: path.join(ROOT, 'public', 'assets') });
const emailLogoFor = createEmailLogo({ logoFor });

let failed = 0;
for (const site of config.sites) {
  const logo = await emailLogoFor(site.theme);
  for (const provider of config.mail.providers) {
    const name = PROVIDER_NAMES[provider.id];
    const mailer = createMailer({ providers: [provider], from: site.emailFrom });
    const subject = `Test fra arrangement: ${name}, nettstedet «${site.id}»`;
    const text = `Denne e-posten er sendt via ${name} fra ${site.emailFrom}.\nVedlegget test.txt skal ligge ved${logo ? ', og logoen skal vises øverst' : ''}.`;
    const html = `${logo ? `<p><img src="cid:${logo.cid}" alt="" width="${logo.width}" height="${logo.height}" style="display:block;width:${logo.width}px;height:${logo.height}px;border:0;"></p>` : ''}`
      + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    const attachments = [
      ...(logo ? [{ filename: `${logo.cid}.png`, content: logo.png, contentType: 'image/png', contentId: logo.cid }] : []),
      { filename: 'test.txt', content: Buffer.from(`Vedlegg sendt via ${name}.\n`), contentType: 'text/plain; charset=utf-8' },
    ];
    try {
      const result = await mailer.send({ to, subject, html, text, attachments });
      console.log(`OK    ${name} fra ${site.emailFrom} (${result.id ?? 'sendt'})`);
    } catch (err) {
      failed += 1;
      console.error(`FEIL  ${name} fra ${site.emailFrom}: ${err.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);

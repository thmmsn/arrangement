import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createLogoLoader, logoType } from '../src/logo.js';
import { ticketsPdf } from '../src/pdf.js';
import { ticketIcon } from '../src/png.js';
import { DEFAULT_COLORS } from '../src/theme.js';
import { translator } from '../public/assets/i18n/index.js';

// Logoen til PDF-billetten: hentes fra ./branding, ./public/assets eller over https.
const dir = mkdtempSync(join(tmpdir(), 'arrangement-logo-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const brandingDir = join(dir, 'branding');
const assetsDir = join(dir, 'assets');
mkdirSync(brandingDir);
mkdirSync(assetsDir);

const PNG = ticketIcon(40, [31, 78, 121]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]);

function loader(fetchImpl) {
  const warnings = [];
  const logoFor = createLogoLoader({ brandingDir, assetsDir, fetchImpl, logger: { warn: (m) => warnings.push(m) } });
  return { logoFor, warnings };
}

describe('logo til PDF-billetten', () => {
  test('filtypen avgjøres av innholdet: PNG, JPEG og SVG kan brukes, WebP ikke', () => {
    assert.equal(logoType(PNG), 'png');
    assert.equal(logoType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpeg');
    assert.equal(logoType(SVG), 'svg');
    assert.equal(logoType(Buffer.from('<svg viewBox="0 0 1 1"></svg>')), 'svg');
    assert.equal(logoType(WEBP), null);
    assert.equal(logoType(Buffer.from('<html><svg></svg></html>')), null);
  });

  test('/assets/custom/<fil> leses fra ./branding, og hentes bare én gang', async () => {
    writeFileSync(join(brandingDir, 'logo.svg'), SVG);
    let reads = 0;
    const { logoFor, warnings } = loader(() => { reads++; });
    const logo = await logoFor({ logoUrl: '/assets/custom/logo.svg' });
    assert.equal(logo.type, 'svg');
    assert.deepEqual(logo.data, SVG);
    assert.equal(await logoFor({ logoUrl: '/assets/custom/logo.svg' }), logo);
    assert.equal(reads, 0, 'lokale filer hentes ikke over nettet');
    assert.deepEqual(warnings, []);
    assert.equal(await logoFor({ logoUrl: '' }), null);
  });

  test('stier ut av mappen, ukjente stier, manglende filer og WebP gir null og en tydelig advarsel', async () => {
    writeFileSync(join(brandingDir, 'logo.webp'), WEBP);
    writeFileSync(join(dir, 'hemmelig.png'), PNG);
    const { logoFor, warnings } = loader();
    for (const logoUrl of ['/assets/custom/../hemmelig.png', '/assets/custom/%2e%2e/hemmelig.png', '/bilder/logo.png', '/assets/custom/finnes-ikke.png', '/assets/custom/logo.webp']) {
      assert.equal(await logoFor({ logoUrl }), null, logoUrl);
    }
    assert.equal(warnings.length, 5);
    assert.match(warnings[0], /LOGO_URL=\/assets\/custom\/\.\.\/hemmelig\.png kan ikke brukes i PDF-billetten: ugyldig sti/);
    assert.match(warnings[2], /må starte med \/assets\/custom\//);
    assert.match(warnings[3], /filen finnes ikke/);
    assert.match(warnings[4], /bare PNG, JPEG og SVG kan vises i PDF/);
  });

  test('https-logo hentes over nettet; feil prøves på nytt senere', async () => {
    let calls = 0;
    let ok = false;
    const fetchImpl = async (url) => {
      calls++;
      assert.equal(url, 'https://cdn.example.com/logo.png');
      return ok
        ? new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
        : new Response('nei', { status: 503 });
    };
    let clock = 0;
    const warnings = [];
    const logoFor = createLogoLoader({ brandingDir, assetsDir, fetchImpl, logger: { warn: (m) => warnings.push(m) }, now: () => clock });
    const theme = { logoUrl: 'https://cdn.example.com/logo.png' };
    assert.equal(await logoFor(theme), null);
    assert.match(warnings[0], /svarte 503/);
    assert.equal(await logoFor(theme), null, 'ikke nytt forsøk med én gang');
    assert.equal(calls, 1);
    ok = true;
    clock += 11 * 60_000;
    assert.equal((await logoFor(theme)).type, 'png');
    assert.equal(calls, 2);
  });

  test('logoen bygges inn i PDF-en én gang, uansett antall billetter', async () => {
    const site = { t: translator('nb'), lang: 'nb', theme: { colors: DEFAULT_COLORS, siteName: 'Laget' } };
    const tickets = ['Ola', 'Kari', 'Per'].map((name, i) => ({ name, code: 'abcdefghjk', doorCode: 'ABCDE', url: `https://e.no/t/${i}`, index: i + 1, total: 3 }));
    const event = { title: 'Fest', startsAt: '2030-10-26T16:00:00.000Z', location: 'Huset', organizerName: 'Kari' };
    const opts = { event, site, timeZone: 'Europe/Oslo', eventUrl: 'https://e.no/abc', tickets };
    // En PNG med gjennomsiktighet er to bildeobjekter (bildet og alfamasken) – like mange for én
    // billett som for tre, fordi bildet bygges inn én gang og brukes på alle sidene.
    const images = (pdf) => pdf.toString('latin1').match(/\/Subtype \/Image/g).length;
    const one = await ticketsPdf({ ...opts, tickets: tickets.slice(0, 1), logo: { type: 'png', data: PNG } });
    const three = await ticketsPdf({ ...opts, logo: { type: 'png', data: PNG } });
    assert.equal(three.toString('latin1').match(/\/Type \/Page\b/g).length, 3);
    assert.equal(images(three), images(one));
    const withSvg = await ticketsPdf({ ...opts, logo: { type: 'svg', data: SVG } });
    assert.equal(withSvg.subarray(0, 5).toString(), '%PDF-');
    const without = (await ticketsPdf(opts)).toString('latin1');
    assert.doesNotMatch(without, /\/Subtype \/Image/);
  });
});

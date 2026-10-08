import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { loadLegalTexts, MAX_LEGAL_BYTES } from '../src/legal.js';
import { loadTheme } from '../src/theme.js';
import { createEvent, startApp } from './helpers.js';

// En egen branding-mappe for testene, med filene appen skal lese.
const branding = mkdtempSync(join(tmpdir(), 'arrangement-legal-'));
after(() => rmSync(branding, { recursive: true, force: true }));
const write = (file, text) => {
  mkdirSync(join(branding, file, '..'), { recursive: true });
  writeFileSync(join(branding, file), text);
};

write('personvern.html', '<h2>Databehandlere</h2>\n<p>Resend sender e-post.</p>');
write('privacy.html', '<h2>Processors</h2><p>Resend sends e-mail.</p>');

const sitesOf = (env) => loadConfig(env).sites;

describe('LEGAL_FILE i temaet', () => {
  test('et filnavn i branding godtas, også som /assets/custom/-adresse og i en undermappe', () => {
    for (const [value, file] of [
      ['personvern.html', 'personvern.html'],
      [' juridisk/Personvern-2026.htm ', 'juridisk/Personvern-2026.htm'],
      ['/assets/custom/personvern.html', 'personvern.html'],
    ]) {
      const { theme, warnings } = loadTheme({ LEGAL_FILE: value }, { baseUrl: 'https://x' });
      assert.deepEqual(warnings, [], value);
      assert.equal(theme.legalFile, file, value);
    }
  });

  test('stier ut av mappen, skjulte filer, andre filtyper og adresser avvises med advarsel', () => {
    for (const value of ['../.env', '../hemmelig.html', 'a/../../b.html', '.skjult.html', 'a/.b/c.html',
      '/etc/passwd.html', 'personvern.txt', 'personvern', 'https://example.com/p.html', 'a\\b.html', 'p .html']) {
      const { theme, warnings } = loadTheme({ LEGAL_FILE: value }, { baseUrl: 'https://x' });
      assert.equal(theme.legalFile, '', value);
      assert.equal(warnings.length, 1, value);
      assert.match(warnings[0], /^LEGAL_FILE=.* ignoreres: må være navnet på en \.html-fil i mappen branding/);
    }
  });

  test('LEGAL_TITLE har en lengdegrense', () => {
    const { theme, warnings } = loadTheme({ LEGAL_TITLE: 'x'.repeat(101) }, { baseUrl: 'https://x' });
    assert.equal(theme.legalTitle, '');
    assert.equal(warnings.length, 1);
  });
});

describe('innlesing av filen (legal.js)', () => {
  test('uten LEGAL_FILE leses ingenting', () => {
    const reads = [];
    const { texts, warnings } = loadLegalTexts(sitesOf({}), { brandingDir: branding, readFile: (f) => reads.push(f) });
    assert.equal(texts.size, 0);
    assert.deepEqual(warnings, []);
    assert.deepEqual(reads, []);
  });

  test('tittelen er ordbokens, eller LEGAL_TITLE', () => {
    const standard = loadLegalTexts(sitesOf({ LEGAL_FILE: 'personvern.html' }), { brandingDir: branding });
    assert.deepEqual(standard.warnings, []);
    assert.deepEqual(standard.texts.get('main'), {
      title: 'Personvern og databehandling',
      html: '<h2>Databehandlere</h2>\n<p>Resend sender e-post.</p>',
    });
    const custom = loadLegalTexts(sitesOf({ LEGAL_FILE: 'personvern.html', LEGAL_TITLE: 'Vilkår' }), { brandingDir: branding });
    assert.equal(custom.texts.get('main').title, 'Vilkår');
  });

  test('en hel HTML-side gir bare innholdet i <body>, uten kommentarer og BOM', () => {
    write('hel-side.html', '\uFEFF<!doctype html><html><head><title>X</title><style>p{}</style></head>'
      + '<body class="x">\n<!-- notat til meg selv: <script> -->\n<p>Innhold</p>\n</body></html>');
    const { texts, warnings } = loadLegalTexts(sitesOf({ LEGAL_FILE: 'hel-side.html' }), { brandingDir: branding });
    assert.deepEqual(warnings, [], 'kommentaren og <style> i <head> gir ingen advarsel');
    assert.equal(texts.get('main').html, '<p>Innhold</p>');
  });

  test('en fil som mangler, er tom eller er for stor, gir advarsel og ingen lenke', () => {
    write('tom.html', '  \n<!-- bare en kommentar -->\n');
    write('stor.html', `<p>${'x'.repeat(MAX_LEGAL_BYTES)}</p>`);
    for (const [file, why] of [['finnes-ikke.html', 'finnes ikke'], ['tom.html', 'er tom'], ['stor.html', 'er for stor']]) {
      const { texts, warnings } = loadLegalTexts(sitesOf({ LEGAL_FILE: file }), { brandingDir: branding });
      assert.equal(texts.size, 0, file);
      assert.equal(warnings.length, 1, file);
      assert.match(warnings[0], new RegExp(`^LEGAL_FILE: branding/${file} ${why}`));
      assert.match(warnings[0], /lenken til personvern og databehandleravtaler vises ikke/);
    }
  });

  test('det Content-Security-Policy stopper, gir en advarsel – teksten vises likevel', () => {
    write('blokkert.html', '<p style="color:red" onclick="x()">Hei</p><script>alert(1)</script><style>p{}</style>');
    const { texts, warnings } = loadLegalTexts(sitesOf({ LEGAL_FILE: 'blokkert.html' }), { brandingDir: branding });
    assert.ok(texts.has('main'));
    assert.equal(warnings.length, 1);
    for (const part of ['<script> kjøres ikke', '<style> brukes ikke', 'style="…" brukes ikke', 'onclick="…" o.l. kjøres ikke']) {
      assert.ok(warnings[0].includes(part), part);
    }
  });

  test('vanlig tekst som ligner på attributter, gir ingen advarsel', () => {
    write('tekst.html', '<p>Vi er online = tilgjengelige, og style = stil.</p>');
    const { warnings } = loadLegalTexts(sitesOf({ LEGAL_FILE: 'tekst.html' }), { brandingDir: branding });
    assert.deepEqual(warnings, []);
  });

  test('en fil som deles av flere nettsteder, leses og varsles om bare én gang', () => {
    const reads = [];
    const env = { DOMAIN: 'a.example.no', LEGAL_FILE: 'mangler.html', SITE_B_DOMAIN: 'b.example.no' };
    const { warnings } = loadLegalTexts(sitesOf(env), {
      brandingDir: branding,
      readFile: (file) => {
        reads.push(file);
        throw Object.assign(new Error('nei'), { code: 'ENOENT' });
      },
    });
    assert.equal(reads.length, 1);
    assert.equal(warnings.length, 1);
  });
});

describe('vinduet på sidene', () => {
  const env = { ADMIN_NO_AUTH: 'true' };
  const open = async (extraEnv) => {
    const app = await startApp({ ...env, ...extraEnv }, { configOverrides: { brandingDir: branding } });
    const { slug } = await createEvent(app);
    return { app, page: await app.request({ path: `/${slug}` }) };
  };

  test('uten LEGAL_FILE er det verken knapp, vindu eller skript', async () => {
    const { page } = await open({});
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /legal-dialog|legal\.js|commandfor/);
  });

  test('med LEGAL_FILE har bunnteksten en knapp som åpner vinduet med teksten', async () => {
    const { app, page } = await open({ LEGAL_FILE: 'personvern.html', FOOTER_TEXT: 'Bunntekst', PRIVACY_URL: 'https://example.com/p' });
    assert.equal(page.status, 200);
    const footer = /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(page.text)[0];
    assert.match(footer, /Bunntekst · <a href="https:\/\/example\.com\/p"[^>]*>Personvern<\/a> · <button type="button" class="link-button" commandfor="legal-dialog" command="show-modal" aria-haspopup="dialog">Personvern og databehandling<\/button>/);

    // Vinduet: modal <dialog> med overskrift, rullbar tekst og to lukkeknapper.
    assert.match(page.text, /<dialog id="legal-dialog" class="legal-dialog" aria-labelledby="legal-dialog-title" closedby="any">/);
    assert.match(page.text, /<h2 id="legal-dialog-title">Personvern og databehandling<\/h2>/);
    assert.match(page.text, /<div class="legal-dialog-body" tabindex="0">\s*<h2>Databehandlere<\/h2>\n<p>Resend sender e-post\.<\/p>\s*<\/div>/);
    assert.equal(page.text.match(/command="close"/g).length, 2);
    assert.match(page.text, /aria-label="Lukk">×<\/button>/);
    assert.ok(page.text.indexOf('<dialog') > page.text.indexOf('</footer>'), 'vinduet står etter bunnteksten');

    // Skriptet (for nettlesere uten commandfor/closedby) ligger på /assets og er tillatt av CSP.
    const src = /<script type="module" src="(\/assets\/js\/legal\.js\?v=[^"]*)"><\/script>/.exec(page.text)?.[1];
    assert.ok(src, 'siden laster legal.js');
    const script = await app.request({ path: src });
    assert.equal(script.status, 200);
    assert.match(script.headers['content-type'], /javascript/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  });

  test('vinduet finnes på alle sidene med bunntekst, også admin', async () => {
    const app = await startApp({ ...env, LEGAL_FILE: 'personvern.html' }, { configOverrides: { brandingDir: branding } });
    const page = await app.request({ path: '/admin/ny' });
    assert.equal(page.status, 200);
    assert.match(page.text, /<dialog id="legal-dialog"/);
  });

  test('LEGAL_TITLE escapes, og eierens HTML settes inn uten at {{…}} eller $& tolkes', async () => {
    write('spesial.html', '<p>Pris: $& og $\' og {{SITE_NAME}} og {{t:legal.close}}</p>');
    const { page } = await open({ LEGAL_FILE: 'spesial.html', LEGAL_TITLE: 'Vilkår <&> "sitat"', SITE_NAME: 'Navn' });
    assert.match(page.text, /aria-haspopup="dialog">Vilkår &lt;&amp;&gt; &quot;sitat&quot;<\/button>/);
    assert.match(page.text, /<h2 id="legal-dialog-title">Vilkår &lt;&amp;&gt; &quot;sitat&quot;<\/h2>/);
    assert.ok(page.text.includes('<p>Pris: $& og $\' og {{SITE_NAME}} og {{t:legal.close}}</p>'), 'teksten er uendret');
    // Resten av siden er fylt inn som før.
    assert.match(page.text, /<title>Navn<\/title>/);
    assert.doesNotMatch(page.text.replace(/<dialog[\s\S]*<\/dialog>/, ''), /<!--|\{\{/);
  });

  test('en fil som mangler, gir en side uten vinduet – ikke en feil', async () => {
    const { page } = await open({ LEGAL_FILE: 'finnes-ikke.html' });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /legal-dialog/);
  });
});

describe('LEGAL_FILE og flere nettsteder', () => {
  const MAIN = 'arrangement.example.no';
  const COM = 'events.example.com';
  const TWO = { ADMIN_NO_AUTH: 'true', DOMAIN: MAIN, SITE_COM_DOMAIN: COM, SITE_COM_LANG: 'en', LEGAL_FILE: 'personvern.html' };
  const pages = async (extraEnv) => {
    const app = await startApp({ ...TWO, ...extraEnv }, { configOverrides: { brandingDir: branding } });
    const no = await createEvent(app);
    const en = await createEvent(app, { site: 'com', title: 'English event' });
    return {
      no: (await app.request({ path: `/${no.slug}`, headers: { host: MAIN } })).text,
      en: (await app.request({ path: `/${en.slug}`, headers: { host: COM } })).text,
    };
  };

  test('en norsk tekst arves ikke til et engelsk nettsted', async () => {
    const { no, en } = await pages({});
    assert.match(no, /Databehandlere/);
    assert.doesNotMatch(en, /legal-dialog|Databehandlere/);
  });

  test('et nettsted kan ha sin egen fil, med tittelen på sitt eget språk', async () => {
    const { no, en } = await pages({ SITE_COM_LEGAL_FILE: 'privacy.html' });
    assert.match(no, /Personvern og databehandling[\s\S]*Databehandlere/);
    assert.match(en, /aria-haspopup="dialog">Privacy and data processing<\/button>/);
    assert.match(en, /<h2>Processors<\/h2>/);
    assert.match(en, /aria-label="Close">×<\/button>/);
    assert.doesNotMatch(en, /Databehandlere/);
  });

  test('et nettsted med samme språk arver filen', () => {
    const sites = sitesOf({ DOMAIN: MAIN, SITE_NET_DOMAIN: 'arrangement.example.net', LEGAL_FILE: 'personvern.html' });
    const { texts } = loadLegalTexts(sites, { brandingDir: branding });
    assert.deepEqual([...texts.keys()], ['main', 'net']);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createRepository, openDatabase } from '../src/db.js';
import { guestConfirmation } from '../src/email.js';
import { googleFontsUrl, loadTheme, themeCss } from '../src/theme.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function start(env) {
  const config = { ...loadConfig({ BASE_URL: 'https://booking.example.com', ...env }), rateLimits: {} };
  const server = createApp({ repo: createRepository(openDatabase(':memory:')), mailer: { send: async () => ({}) }, config }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  return async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
}

// Leser en .env-fil slik `docker run --env-file` gjør: bokstavelig, uten å tolke anførselstegn
// eller kommentarer på slutten av linjen. Den strengeste av måtene appen kan startes på.
function parseEnvLikeDocker(text) {
  return Object.fromEntries(text.split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

test('.env.example gir ingen advarsler, selv når den leses bokstavelig av docker run', () => {
  const env = parseEnvLikeDocker(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  const config = loadConfig(env);
  assert.deepEqual(config.warnings, []);
  assert.equal(config.emailFrom, 'Påmelding <booking@domain.com>');
  assert.equal(config.baseUrl, 'https://booking.domain.com');
});

test('standardtemaet gir det opprinnelige uttrykket', () => {
  const { theme, warnings } = loadTheme({}, { baseUrl: 'https://x' });
  assert.deepEqual(warnings, []);
  const css = themeCss(theme);
  assert.match(css, /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Cormorant\+Garamond:wght@500;600&family=Source\+Sans\+3:wght@400;600&display=swap"\)/);
  assert.match(css, /--serif: 'Cormorant Garamond', Georgia/);
  assert.doesNotMatch(css, /--accent:/, 'standardfargene ligger i style.css og skal ikke overstyres');
});

test('farger, fonter og radius fra miljøvariabler havner i theme.css', () => {
  const { theme, warnings } = loadTheme({
    COLOR_ACCENT: '#1f4e79',
    COLOR_BACKGROUND: 'white',
    COLOR_TEXT: 'rgb(20, 20, 20)',
    FONT_HEADING: 'Playfair Display:wght@600;700',
    FONT_BODY: 'Inter',
    RADIUS: '0',
    SHOW_BAND: 'false',
    LOGO_HEIGHT: '60',
  }, { baseUrl: 'https://x' });
  assert.deepEqual(warnings, []);
  const css = themeCss(theme);
  assert.match(css, /--accent: #1f4e79;/);
  assert.match(css, /--bg: white;/);
  assert.match(css, /--ink: rgb\(20, 20, 20\);/);
  assert.match(css, /--serif: 'Playfair Display', Georgia/);
  assert.match(css, /--sans: 'Inter', 'Segoe UI'/);
  assert.match(css, /--radius: 0px;/);
  assert.match(css, /--logo-height: 60px;/);
  assert.match(css, /\.band \{ display: none; \}/);
  assert.equal(googleFontsUrl(theme), 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter&display=swap');
});

test('ugyldige verdier ignoreres med advarsel – ingen CSS- eller HTML-injeksjon', () => {
  const { theme, warnings } = loadTheme({
    COLOR_ACCENT: 'red; } body { display: none',
    FONT_HEADING: "Evil'; } * { color: red",
    LOGO_URL: 'javascript:alert(1)',
    PRIVACY_URL: '//evil.example.com',
    RADIUS: '999',
    SHOW_BAND: 'kanskje',
  }, { baseUrl: 'https://x' });
  assert.equal(warnings.length, 6, warnings.join('\n'));
  const css = themeCss(theme);
  assert.doesNotMatch(css, /display: none|Evil|color: red/);
  assert.equal(theme.logoUrl, '');
  assert.equal(theme.privacyUrl, '');
  assert.equal(theme.showBand, true);
});

test('navn, logo, tekster og bunntekst flettes inn i sidene – escapet', async () => {
  const get = await start({
    SITE_NAME: 'Reinhekla <påmelding>',
    LOGO_URL: '/assets/custom/logo.svg',
    FAVICON_URL: 'https://cdn.example.com/favicon.png',
    HOME_TITLE: 'Hei & velkommen',
    HOME_TEXT: 'Linje én',
    PRIVACY_URL: 'https://example.com/personvern',
  });
  const home = await get('/');
  assert.match(home.text, /<title>Reinhekla &lt;påmelding&gt;<\/title>/);
  assert.match(home.text, /<img src="\/assets\/custom\/logo\.svg" alt="Reinhekla &lt;påmelding&gt;">/);
  assert.match(home.text, /<link rel="icon" href="https:\/\/cdn\.example\.com\/favicon\.png">/);
  assert.match(home.text, /<h1>Hei &amp; velkommen<\/h1>/);
  assert.match(home.text, /<a href="https:\/\/example\.com\/personvern"[^>]*>Personvern<\/a>/);
  assert.doesNotMatch(home.text, /<!--|\{\{/, 'alle plassholdere er fylt inn');

  const css = await get('/theme.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('uten Google Fonts slipper Content-Security-Policy heller ikke Google inn', async () => {
  const withGoogle = await start({});
  assert.match((await withGoogle('/')).headers.get('content-security-policy'), /fonts\.googleapis\.com/);

  const without = await start({ GOOGLE_FONTS: 'false' });
  const page = await without('/');
  assert.doesNotMatch(page.headers.get('content-security-policy'), /google/);
  assert.doesNotMatch(page.text, /fonts\.googleapis/);
  assert.doesNotMatch((await without('/theme.css')).text, /@import/);
});

test('eget stilark på et annet domene tillates i Content-Security-Policy', async () => {
  const get = await start({ CUSTOM_CSS_URL: 'https://cdn.example.com/stil.css' });
  const page = await get('/');
  assert.match(page.headers.get('content-security-policy'), /style-src 'self' https:\/\/fonts\.googleapis\.com https:\/\/cdn\.example\.com/);
  assert.match(page.text, /<link rel="stylesheet" href="https:\/\/cdn\.example\.com\/stil\.css">/);
});

test('e-postene bruker temaets farger, logo (med full adresse) og navn', () => {
  const { theme } = loadTheme({ COLOR_ACCENT: '#1f4e79', COLOR_ACCENT_TEXT: '#000', LOGO_URL: '/assets/custom/logo.png', SITE_NAME: 'Reinhekla' }, { baseUrl: 'https://booking.example.com' });
  const message = guestConfirmation({
    event: { title: 'Kurs', startsAt: '2026-11-14T17:00:00Z', location: '', organizerName: 'Kari', organizerEmail: 'k@example.com', fields: [] },
    booking: { contactName: 'Ola', contactEmail: 'ola@example.com', persons: [{ name: 'Ola', email: 'ola@example.com', answers: {} }] },
    eventUrl: 'https://booking.example.com/abc',
    cancelUrl: 'https://booking.example.com/abc/avmelding#t',
    timeZone: 'Europe/Oslo',
    theme,
  });
  assert.match(message.html, /<img src="https:\/\/booking\.example\.com\/assets\/custom\/logo\.png" alt="Reinhekla"/);
  assert.match(message.html, /background:#1f4e79;color:#000;/);
  assert.doesNotMatch(message.html, /#8b2e2a/);
});

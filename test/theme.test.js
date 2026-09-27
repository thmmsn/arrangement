import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { guestConfirmation } from '../src/email.js';
import { googleFontsUrl, loadTheme, themeCss } from '../src/theme.js';
import { createEvent, startApp } from './helpers.js';

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

test('farger, fonter og radius fra miljøvariabler havner i temastilarket', () => {
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

// Hjelper: åpner arrangementssiden og henter nettstedets temastilark som siden lenker til.
async function eventPageWithCss(env) {
  const app = await startApp({ ADMIN_PASSWORD: 'hemmelig', ...env });
  const { slug } = await createEvent(app);
  const page = await app.request({ path: `/${slug}` });
  assert.equal(page.status, 200);
  const href = /<link rel="stylesheet" href="(\/assets\/theme\/[0-9a-f]{20}\.css)">/.exec(page.text)?.[1];
  assert.ok(href, 'siden lenker til temastilarket');
  const css = await app.request({ path: href });
  return { app, page, css };
}

test('navn, logo, favicon og bunntekst flettes inn i arrangementssiden – escapet', async () => {
  const { page, css } = await eventPageWithCss({
    SITE_NAME: 'Eksempel <påmelding>',
    LOGO_URL: '/assets/custom/logo.svg',
    FAVICON_URL: 'https://cdn.example.com/favicon.png',
    FOOTER_TEXT: 'Bunntekst & mer',
    PRIVACY_URL: 'https://example.com/personvern',
    COLOR_ACCENT: '#1f4e79',
  });
  assert.match(page.text, /<html lang="nb">/);
  assert.match(page.text, /<title>Eksempel &lt;påmelding&gt;<\/title>/);
  assert.match(page.text, /<img src="\/assets\/custom\/logo\.svg" alt="Eksempel &lt;påmelding&gt;">/);
  assert.match(page.text, /<link rel="icon" href="https:\/\/cdn\.example\.com\/favicon\.png">/);
  assert.match(page.text, /Bunntekst &amp; mer · <a href="https:\/\/example\.com\/personvern"[^>]*>Personvern<\/a>/);
  assert.match(page.text, /Laster arrangementet …/);
  assert.doesNotMatch(page.text, /<!--|\{\{/, 'alle plassholdere er fylt inn');

  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.match(css.text, /--accent: #1f4e79;/);
});

test('uten Google Fonts slipper Content-Security-Policy heller ikke Google inn', async () => {
  const withGoogle = await eventPageWithCss({});
  assert.match(withGoogle.page.headers['content-security-policy'], /fonts\.googleapis\.com/);
  assert.match(withGoogle.page.text, /fonts\.googleapis\.com/);
  assert.match(withGoogle.css.text, /@import/);

  const without = await eventPageWithCss({ GOOGLE_FONTS: 'false' });
  assert.doesNotMatch(without.page.headers['content-security-policy'], /google/);
  assert.doesNotMatch(without.page.text, /fonts\.googleapis/);
  assert.equal(without.css.status, 200);
  assert.doesNotMatch(without.css.text, /@import/);
});

test('eget stilark på et annet domene tillates i Content-Security-Policy', async () => {
  const { page } = await eventPageWithCss({ CUSTOM_CSS_URL: 'https://cdn.example.com/stil.css' });
  assert.match(page.headers['content-security-policy'], /style-src 'self' https:\/\/fonts\.googleapis\.com https:\/\/cdn\.example\.com/);
  assert.match(page.text, /<link rel="stylesheet" href="https:\/\/cdn\.example\.com\/stil\.css">/);
});

test('e-postene bruker temaets farger, logo (med full adresse) og navn', () => {
  const { mainSite: site } = loadConfig({
    DOMAIN: 'booking.example.com', COLOR_ACCENT: '#1f4e79', COLOR_ACCENT_TEXT: '#000', LOGO_URL: '/assets/custom/logo.png', SITE_NAME: 'Eksempel',
  });
  const message = guestConfirmation({
    event: { title: 'Kurs', startsAt: '2026-11-14T17:00:00Z', location: '', organizerName: 'Kari', organizerEmail: 'k@example.com', fields: [] },
    booking: { contactName: 'Ola', contactEmail: 'ola@example.com', persons: [{ name: 'Ola', email: 'ola@example.com', answers: {} }] },
    eventUrl: 'https://booking.example.com/abc',
    cancelUrl: 'https://booking.example.com/abc/avmelding#t',
    timeZone: 'Europe/Oslo',
    site,
  });
  assert.match(message.html, /<img src="https:\/\/booking\.example\.com\/assets\/custom\/logo\.png" alt="Eksempel"/);
  assert.match(message.html, /background:#1f4e79;color:#000;/);
  assert.doesNotMatch(message.html, /#8b2e2a/);
});

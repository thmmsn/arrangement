import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextVersion, readVersion, VERSION_PATTERN } from '../src/version.js';
import { createEvent, startApp } from './helpers.js';

// Versjonsnummeret: år.måned.dag.løpenummer, vist nederst til høyre på sidene.

test('VERSION i prosjektet har riktig format', () => {
  assert.match(readVersion(), VERSION_PATTERN);
});

test('formatet: uten ledende nuller, gyldig måned og dag, løpenummer fra 1', () => {
  for (const ok of ['2026.9.28.1', '2026.12.31.12', '2027.1.1.1']) assert.match(ok, VERSION_PATTERN, ok);
  for (const bad of ['2026.09.28.1', '2026.9.28', '2026.13.1.1', '2026.9.32.1', '2026.9.28.0', '26.9.28.1', 'v2026.9.28.1', '']) {
    assert.doesNotMatch(bad, VERSION_PATTERN, bad);
  }
});

test('neste versjon: samme dag øker løpenummeret, ny dag starter på 1 – i norsk tid', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  assert.equal(nextVersion(null, { now }), '2026.9.28.1');
  assert.equal(nextVersion('2026.9.28.1', { now }), '2026.9.28.2');
  assert.equal(nextVersion('2026.9.28.9', { now }), '2026.9.28.10');
  assert.equal(nextVersion('2026.9.27.4', { now }), '2026.9.28.1');
  assert.equal(nextVersion('ugyldig', { now }), '2026.9.28.1');
  // 23:30 UTC 30. september er allerede 1. oktober i Norge.
  assert.equal(nextVersion('2026.9.30.3', { now: new Date('2026-09-30T23:30:00Z') }), '2026.10.1.1');
  assert.equal(nextVersion('2026.9.30.3', { now: new Date('2026-09-30T23:30:00Z'), timeZone: 'UTC' }), '2026.9.30.4');
});

test('readVersion: manglende fil eller feil format gir null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arrangement-versjon-'));
  try {
    const file = join(dir, 'VERSION');
    assert.equal(readVersion(file), null);
    writeFileSync(file, '1.0.0\n');
    assert.equal(readVersion(file), null);
    writeFileSync(file, '2026.9.28.3\n');
    assert.equal(readVersion(file), '2026.9.28.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('versjonen står nederst til høyre på sidene – også uten bunntekst', async () => {
  const version = readVersion();
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const { slug } = await createEvent(app);
  for (const path of [`/${slug}`, `/${slug}/avmelding`, '/admin/ny', `/admin/${slug}`]) {
    const html = (await app.request({ path })).text;
    assert.ok(html.includes(`<div class="site-version">${version}</div>`), path);
    assert.ok(html.indexOf('site-version') > html.indexOf('<footer'), `${path}: i bunnteksten`);
  }
  // Tomt tema (ingen SITE_NAME, FOOTER_TEXT eller personvernlenke): bunnteksten har bare versjonen.
  const bare = await startApp({ ADMIN_NO_AUTH: 'true', SITE_NAME: '', FOOTER_TEXT: '' });
  const html = (await bare.request({ path: `/${(await createEvent(bare)).slug}` })).text;
  assert.match(html, /<div class="site-version">[\d.]+<\/div>/);
  // Den nakne 404-siden røper ingenting – heller ikke versjonen.
  assert.doesNotMatch((await app.request({ path: '/' })).text, /site-version|\d{4}\.\d+\.\d+\.\d+/);
});

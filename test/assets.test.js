import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.js';

// Skript, ordbøker og stilark under /assets skal alltid sjekkes mot serveren («no-cache» med ETag).
// Hovedskriptet har versjonen i adressen, men filene det importerer har den ikke. Med en fast levetid
// (før 2026.10.8.6: én time) kunne en ny versjon kjørt med en gammel ordbok og vist «overview.manage».

test('skript, ordbøker og stilark: no-cache, med ETag og 304 når filen ikke er endret', async () => {
  const app = await startApp({ DOMAIN: 'arrangement.example.no' });
  for (const path of ['/assets/js/common.js', '/assets/js/overview.js?v=1', '/assets/i18n/nb.js', '/assets/i18n/index.js', '/assets/css/style.css']) {
    const res = await app.request({ path });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['cache-control'], 'no-cache', path);
    assert.ok(res.headers.etag, `${path} har ETag`);
    const again = await app.request({ path, headers: { 'if-none-match': res.headers.etag } });
    assert.equal(again.status, 304, `${path}: uendret fil gir 304`);
  }
});

test('filer med innholdshash i navnet kan fortsatt mellomlagres for alltid', async () => {
  const app = await startApp({ DOMAIN: 'arrangement.example.no' });
  const page = await app.request({ path: '/admin/ny', headers: { host: 'arrangement.example.no' } });
  const theme = /href="(\/assets\/theme\/[0-9a-f]+\.css)"/.exec(page.text)?.[1];
  assert.ok(theme, 'siden lenker til temastilarket');
  assert.equal((await app.request({ path: theme })).headers['cache-control'], 'public, max-age=31536000, immutable');
});

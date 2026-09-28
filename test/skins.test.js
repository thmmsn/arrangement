import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadSkins, parseSkinMeta } from '../src/skins.js';
import { createEvent, startApp } from './helpers.js';

// Skins: innebygde og egne (./skins), valgt per arrangement.

const BUILTIN = fileURLToPath(new URL('../public/assets/skins', import.meta.url));

test('de innebygde skinnene har navn på begge språk og forhåndsvisningsfarger', () => {
  const { skins, warnings } = loadSkins({ dirs: [BUILTIN] });
  assert.deepEqual(warnings, []);
  assert.deepEqual([...skins.keys()].sort(), ['contrast', 'dark', 'fjord', 'glass', 'glow', 'light']);
  for (const skin of skins.values()) {
    assert.ok(skin.names.default && skin.names.en, `${skin.id} mangler navn`);
    assert.equal(skin.preview.length, 4, `${skin.id} mangler forhåndsvisning`);
    assert.match(skin.href, new RegExp(`^/assets/skins/${skin.id}-[0-9a-f]{12}\\.css$`));
  }
  assert.equal(skins.get('glow').names.default, 'Glød');
  assert.equal(skins.get('glow').names.en, 'Glow');
});

test('egne skins legges til, erstatter innebygde med samme navn, og feil gir advarsler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skins-'));
  try {
    writeFileSync(join(dir, 'min-skin.css'), '/*\n  name: Min skin\n  preview: #000 #fff zzz\n*/\n:root { --accent: #123456; }');
    writeFileSync(join(dir, 'dark.css'), '/* name: Egen mørk */\n:root { --bg: #000; }');
    writeFileSync(join(dir, 'Ugyldig Navn.css'), ':root {}');
    writeFileSync(join(dir, 'import.css'), '@import url("https://cdn.example.com/x.css");');
    writeFileSync(join(dir, 'README.md'), 'ikke css');
    const { skins, warnings } = loadSkins({ dirs: [BUILTIN, dir] });
    assert.equal(skins.get('min-skin').names.default, 'Min skin');
    assert.deepEqual(skins.get('min-skin').preview, ['#000', '#fff'], 'ugyldige farger ignoreres');
    assert.equal(skins.get('dark').names.default, 'Egen mørk');
    assert.ok(!skins.has('Ugyldig Navn'));
    assert.ok(warnings.some((w) => w.includes('Ugyldig Navn.css')));
    assert.ok(warnings.some((w) => w.includes('cdn.example.com') && w.includes('blokkeres')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(parseSkinMeta('ingen kommentar'), { names: {}, preview: [] });
});

test('arrangøren velger skin, og arrangementets sider får stilarket', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const config = await app.request({ path: '/api/admin/config' });
  const glass = config.json.skins.find((s) => s.id === 'glass');
  assert.equal(glass.name, 'Glass');
  assert.equal(config.json.deleteAfterDays, 30);

  const bad = await app.request({ method: 'POST', path: '/api/admin/events', body: { title: 'X', startsAt: '2030-01-01T10:00:00Z', organizerName: 'A', organizerEmail: 'a@example.com', skin: 'finnes-ikke' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors.skin, 'Ukjent utseende');

  const { slug } = await createEvent(app, { skin: 'glass' });
  const page = await app.request({ path: `/${slug}` });
  const href = /<link rel="stylesheet" href="(\/assets\/skins\/glass-[0-9a-f]+\.css)">/.exec(page.text)?.[1];
  assert.ok(href, 'arrangementssiden har skinnen');
  // Skinnen kommer etter nettstedets tema, så den vinner.
  assert.ok(page.text.indexOf(href) > page.text.indexOf('/assets/theme/'));
  const css = await app.request({ path: href });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.match(css.headers['cache-control'], /immutable/);
  assert.equal((await app.request({ path: '/assets/skins/glass-000000000000.css' })).status, 404);

  // Uten skin: ingen ekstra stilark. Admin-sidene bruker aldri arrangementets skin.
  const plain = await createEvent(app);
  assert.doesNotMatch((await app.request({ path: `/${plain.slug}` })).text, /\/assets\/skins\//);
  assert.doesNotMatch((await app.request({ path: `/admin/${slug}` })).text, /\/assets\/skins\//);
});

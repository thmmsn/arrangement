import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DICTIONARIES, LANGUAGES, translator } from '../public/assets/i18n/index.js';

const ROOT = new URL('..', import.meta.url).pathname;

// Alle stier til tekster i en ordbok: «form.thanks», «event.registered» (flertallsobjekt) …
function leaves(node, prefix = '') {
  if (typeof node === 'string') return [[prefix, node]];
  if (node && typeof node === 'object' && 'other' in node) return [[prefix, node.other], [`${prefix}#one`, node.one ?? '']];
  return Object.entries(node).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key));
}
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('alle språk har nøyaktig de samme nøklene og de samme plassholderne', () => {
  const [first, ...others] = LANGUAGES;
  const reference = new Map(leaves(DICTIONARIES[first]));
  for (const lang of others) {
    const entries = new Map(leaves(DICTIONARIES[lang]));
    assert.deepEqual([...entries.keys()].sort(), [...reference.keys()].sort(), `${lang} har andre nøkler enn ${first}`);
    for (const [key, text] of entries) {
      // Flertallsformen «one» kan utelate {count} («1 person» / «one person»), så den sjekkes ikke.
      if (key.endsWith('#one')) continue;
      assert.deepEqual(placeholders(text), placeholders(reference.get(key)), `${lang}: ${key}`);
    }
  }
});

test('flertall velges etter språkets regler', () => {
  assert.equal(translator('nb')('event.registered', { count: 1 }), 'påmeldt');
  assert.equal(translator('nb')('event.registered', { count: 2 }), 'påmeldte');
  assert.equal(translator('en')('cancel.buttonSome', { count: 1 }), 'Cancel 1 person');
  assert.equal(translator('en')('cancel.buttonSome', { count: 3 }), 'Cancel 3 people');
  assert.equal(translator('xx').lang, 'nb', 'ukjent språk faller tilbake til norsk');
});

// Finner alle tekstnøkler koden bruker direkte: t('…'), req.t('…'), {{t:…}} og msg('…') i valideringen.
function sourceFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)]);
}

test('hver tekstnøkkel som brukes i koden, finnes i ordbøkene', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('views'), ...sourceFiles('public/assets/js')]
    .filter((f) => /\.(js|html)$/.test(f));
  const used = new Set();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/\b(?:t|adminT)\(\s*'([a-zA-Z_]+(?:\.[a-zA-Z_]+)+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/\{\{t:([\w.]+)\}\}/g)) used.add(m[1]);
    if (file.endsWith('validation.js')) for (const m of text.matchAll(/\bmsg\('(\w+)'/g)) used.add(`validation.${m[1]}`);
  }
  // Nøkler som settes sammen i koden (f.eks. `status.${status}`):
  for (const status of ['closed', 'deadline_passed', 'full']) used.add(`status.${status}`);
  for (const status of ['open', 'closed', 'deadline_passed', 'full']) used.add(`event.badge.${status}`).add(`admin.state.${status}`);
  for (const type of ['text', 'textarea', 'tel', 'number', 'select', 'checkbox']) used.add(`eventForm.types.${type}`);
  for (const key of ['cancelOne', 'cancelMany']) used.add(`email.confirmation.${key}Text`);

  assert.ok(used.size > 150, `fant bare ${used.size} nøkler – sjekk mønstrene i testen`);
  for (const lang of LANGUAGES) {
    const t = translator(lang);
    const missing = [...used].filter((key) => t.raw(key) === undefined);
    assert.deepEqual(missing, [], `${lang} mangler nøkler`);
  }
});

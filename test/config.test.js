import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('lenkene bygges fra DOMAIN når BASE_URL mangler', () => {
  assert.equal(loadConfig({ DOMAIN: 'arrangement.domain.no' }).baseUrl, 'https://arrangement.domain.no');
  assert.equal(loadConfig({ DOMAIN: 'arrangement.domain.no', BASE_URL: 'https://annet.no/' }).baseUrl, 'https://annet.no');
  assert.equal(loadConfig({ PORT: '4000' }).baseUrl, 'http://localhost:4000');
});

// `docker run --env-file` beholder anførselstegn bokstavelig – de skal ikke havne i avsenderadressen.
test('omsluttende anførselstegn fjernes', () => {
  const config = loadConfig({ EMAIL_FROM: '"Påmelding <arrangement@domain.no>"', TIME_ZONE: "'Europe/Oslo'" });
  assert.equal(config.emailFrom, 'Påmelding <arrangement@domain.no>');
  assert.equal(config.timeZone, 'Europe/Oslo');
  // Anførselstegn inne i verdien, eller bare på én side, røres ikke.
  assert.equal(loadConfig({ RESEND_API_KEY: 'a"b"' }).resendApiKey, 'a"b"');
  assert.equal(loadConfig({ RESEND_API_KEY: '"' }).resendApiKey, '"');
});

test('TRUST_PROXY tolkes som tall eller boolsk verdi', () => {
  assert.equal(loadConfig({}).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, true);
});

test('DELETE_AFTER_DAYS: 30 som standard, ugyldige verdier gir advarsel', () => {
  assert.equal(loadConfig({}).deleteAfterDays, 30);
  assert.equal(loadConfig({ DELETE_AFTER_DAYS: '90' }).deleteAfterDays, 90);
  const bad = loadConfig({ DELETE_AFTER_DAYS: '0' });
  assert.equal(bad.deleteAfterDays, 30);
  assert.ok(bad.warnings.some((w) => w.startsWith('DELETE_AFTER_DAYS="0" ignoreres')));
});

test('ADMIN_EMAIL: én eller flere adresser skilt med komma', () => {
  assert.deepEqual(loadConfig({}).adminEmails, []);
  assert.deepEqual(loadConfig({ ADMIN_EMAIL: 'a@example.com, b@example.com' }).adminEmails, ['a@example.com', 'b@example.com']);
});

test('alle innstillingene appen leser, er beskrevet i .env.example', async () => {
  const { readFileSync } = await import('node:fs');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of ['ADMIN_EMAIL', 'DELETE_AFTER_DAYS', 'APPLE_WALLET_PASS_TYPE_ID', 'APPLE_WALLET_TEAM_ID', 'APPLE_WALLET_CERT_FILE',
    'APPLE_WALLET_CERT_PASSWORD', 'APPLE_WALLET_WWDR_FILE', 'GOOGLE_WALLET_ISSUER_ID', 'GOOGLE_WALLET_KEY_FILE']) {
    assert.match(example, new RegExp(`^#? ?${key}=`, 'm'), key);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('lenkene bygges fra DOMAIN når BASE_URL mangler', () => {
  assert.equal(loadConfig({ DOMAIN: 'booking.domain.com' }).baseUrl, 'https://booking.domain.com');
  assert.equal(loadConfig({ DOMAIN: 'booking.domain.com', BASE_URL: 'https://annet.no/' }).baseUrl, 'https://annet.no');
  assert.equal(loadConfig({ PORT: '4000' }).baseUrl, 'http://localhost:4000');
});

// `docker run --env-file` beholder anførselstegn bokstavelig – de skal ikke havne i avsenderadressen.
test('omsluttende anførselstegn fjernes', () => {
  const config = loadConfig({ EMAIL_FROM: '"Påmelding <booking@domain.com>"', TIME_ZONE: "'Europe/Oslo'" });
  assert.equal(config.emailFrom, 'Påmelding <booking@domain.com>');
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

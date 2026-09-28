import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, test } from 'node:test';
import forge from 'node-forge';
import { applePass, applePasses, passJson } from '../src/appleWallet.js';
import { googleClaims, googleSaveUrl } from '../src/googleWallet.js';
import { loadWalletConfig, readCertificate, readSignerCertificate } from '../src/walletConfig.js';
import { translator } from '../public/assets/i18n/index.js';
import { DEFAULT_COLORS } from '../src/theme.js';
import { createEvent, register, startApp } from './helpers.js';

// Apple Wallet og Google Wallet, med egne testsertifikater og -nøkler (ingen kontakt med Apple/Google).

const site = { t: translator('nb'), lang: 'nb', theme: { colors: DEFAULT_COLORS, siteName: 'Eksempel', logoAbsoluteUrl: '' } };
const event = {
  slug: 'abcdefghjkmn',
  title: 'Sensommerfest',
  location: 'Grendehuset, Nordbygda',
  geo: { lat: 63.1, lon: 9.8 },
  startsAt: '2030-08-26T16:00:00.000Z',
  endsAt: '2030-08-26T21:00:00.000Z',
  organizerName: 'Arrangør',
};
const tickets = [
  { name: 'Ola Nordmann', code: 'k7hq2mxpr9', doorCode: 'KMRTW', url: 'https://booking.example.com/t/k7hq2mxpr9AAAA', index: 1, total: 2 },
  { name: 'Kari Nordmann', code: 'p3wn8zqrt2', doorCode: 'PLSXB', url: 'https://booking.example.com/t/p3wn8zqrt2BBBB', index: 2, total: 2 },
];

// ---------- Testsertifikater: en «WWDR»-CA og et kortsertifikat utstedt av den ----------

function certificates() {
  const make = (subject, issuer, issuerKey, isCa) => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Math.floor(Math.random() * 1e9));
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
    cert.setSubject([{ name: 'commonName', value: subject }]);
    cert.setIssuer([{ name: 'commonName', value: issuer }]);
    cert.setExtensions([{ name: 'basicConstraints', cA: isCa }, { name: 'keyUsage', digitalSignature: true, keyCertSign: isCa }]);
    cert.sign(issuerKey ?? keys.privateKey, forge.md.sha256.create());
    return { cert, key: keys.privateKey };
  };
  const ca = make('Test WWDR', 'Test WWDR', null, true);
  const signer = make('Pass Type ID: pass.no.example.booking', 'Test WWDR', ca.key, false);
  return { ca, signer };
}

/** Leser vår egen ZIP (lagret eller komprimert) → { filnavn: Buffer }. */
function unzip(buffer) {
  const files = {};
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extra = buffer.readUInt16LE(offset + 30);
    const comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(data) : data;
    offset += 46 + nameLength + extra + comment;
  }
  return files;
}

describe('Apple Wallet', () => {
  const { ca, signer } = certificates();
  const config = { passTypeId: 'pass.no.example.booking', teamId: 'ABCDE12345', cert: signer.cert, key: signer.key, wwdr: ca.cert };
  const opts = { config, event, site, timeZone: 'Europe/Oslo', eventUrl: 'https://booking.example.com/abcdefghjkmn' };

  test('pass.json: QR med billettlenken, tid og sted så kortet dukker opp av seg selv', () => {
    const pass = passJson({ ...opts, ticket: tickets[0] });
    assert.equal(pass.formatVersion, 1);
    assert.equal(pass.passTypeIdentifier, 'pass.no.example.booking');
    assert.equal(pass.teamIdentifier, 'ABCDE12345');
    assert.equal(pass.serialNumber, 'k7hq2mxpr9');
    // Under QR-koden står dørkoden, som dørvakten kan taste inn.
    assert.deepEqual(pass.barcodes, [{ format: 'PKBarcodeFormatQR', message: tickets[0].url, messageEncoding: 'iso-8859-1', altText: 'KMRTW' }]);
    assert.equal(pass.eventTicket.secondaryFields.find((f) => f.key === 'door').value, 'KMRTW');
    assert.equal(pass.eventTicket.backFields.find((f) => f.key === 'code').value, 'K7HQ-2MXP-R9');
    // Tid: vises på låseskjermen fra tre timer før start til slutt.
    assert.equal(pass.relevantDate, event.startsAt);
    assert.deepEqual(pass.relevantDates, [{ startDate: '2030-08-26T13:00:00.000Z', endDate: event.endsAt }]);
    // Sted: vises når man er i nærheten, og semantics gir kart og veibeskrivelse.
    assert.deepEqual(pass.locations, [{ latitude: 63.1, longitude: 9.8, relevantText: 'Sensommerfest' }]);
    assert.deepEqual(pass.semantics.venueLocation, { latitude: 63.1, longitude: 9.8 });
    assert.equal(pass.semantics.venueName, 'Grendehuset, Nordbygda');
    assert.equal(pass.semantics.eventName, 'Sensommerfest');
    const directions = pass.eventTicket.backFields.find((f) => f.key === 'directions');
    assert.equal(directions.value, 'https://maps.apple.com/?daddr=63.1%2C9.8&q=Grendehuset%2C+Nordbygda');
    assert.match(directions.attributedValue, /^<a href="https:\/\/maps\.apple\.com\//);
    assert.match(pass.backgroundColor, /^rgb\(\d+, \d+, \d+\)$/);
    assert.deepEqual(pass.eventTicket.auxiliaryFields.find((f) => f.key === 'position').value, '1 / 2');
  });

  test('uten kartpunkt: ingen locations, men fortsatt tid', () => {
    const pass = passJson({ ...opts, event: { ...event, geo: null }, ticket: tickets[0] });
    assert.equal(pass.locations, undefined);
    assert.equal(pass.semantics.venueLocation, undefined);
    assert.ok(pass.relevantDates.length);
  });

  test('.pkpass: riktige filer, manifest med SHA-1 og en signatur som verifiseres av OpenSSL', () => {
    const files = unzip(applePass({ ...opts, ticket: tickets[0] }));
    assert.deepEqual(Object.keys(files).sort(), ['icon.png', 'icon@2x.png', 'icon@3x.png', 'manifest.json', 'pass.json', 'signature']);
    const manifest = JSON.parse(files['manifest.json']);
    for (const [name, hash] of Object.entries(manifest)) {
      assert.equal(createHash('sha1').update(files[name]).digest('hex'), hash, name);
    }
    assert.deepEqual(Object.keys(manifest).sort(), ['icon.png', 'icon@2x.png', 'icon@3x.png', 'pass.json']);
    assert.equal(files['icon.png'].subarray(1, 4).toString(), 'PNG');

    const dir = mkdtempSync(join(tmpdir(), 'pkpass-'));
    try {
      writeFileSync(join(dir, 'manifest.json'), files['manifest.json']);
      writeFileSync(join(dir, 'signature'), files.signature);
      writeFileSync(join(dir, 'ca.pem'), forge.pki.certificateToPem(ca.cert));
      const out = execFileSync('openssl', [
        'smime', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'signature'),
        '-content', join(dir, 'manifest.json'), '-CAfile', join(dir, 'ca.pem'), '-purpose', 'any', '-out', '/dev/null',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      assert.ok(out !== undefined);
      // Signaturen må også inneholde mellomsertifikatet, ellers avviser iPhone kortet.
      const certs = execFileSync('openssl', ['pkcs7', '-inform', 'DER', '-in', join(dir, 'signature'), '-print_certs'], { encoding: 'utf8' });
      assert.match(certs, /subject=CN\s*=\s*Test WWDR/);
      assert.match(certs, /subject=CN\s*=\s*Pass Type ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flere billetter blir én .pkpasses med ett kort per person', () => {
    const one = applePasses({ ...opts, tickets: [tickets[0]] });
    assert.equal(one.type, 'application/vnd.apple.pkpass');
    const many = applePasses({ ...opts, tickets });
    assert.equal(many.type, 'application/vnd.apple.pkpasses');
    const inner = unzip(many.data);
    assert.deepEqual(Object.keys(inner), ['01-k7hq2mxpr9.pkpass', '02-p3wn8zqrt2.pkpass']);
    assert.equal(JSON.parse(unzip(inner['02-p3wn8zqrt2.pkpass'])['pass.json']).serialNumber, 'p3wn8zqrt2');
  });

  test('oppsett fra filer: PEM, .p12 med passord, og WWDR som DER', () => {
    const pem = forge.pki.certificateToPem(signer.cert) + forge.pki.privateKeyToPem(signer.key);
    assert.equal(readSignerCertificate(Buffer.from(pem)).cert.subject.getField('CN').value, 'Pass Type ID: pass.no.example.booking');
    const p12 = forge.pkcs12.toPkcs12Asn1(signer.key, [signer.cert], 'hemmelig', { algorithm: '3des' });
    const p12Buffer = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
    assert.ok(readSignerCertificate(p12Buffer, 'hemmelig').key);
    assert.throws(() => readSignerCertificate(p12Buffer, 'feil'), /passord|APPLE_WALLET_CERT_PASSWORD/i);
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes(), 'binary');
    assert.equal(readCertificate(der).subject.getField('CN').value, 'Test WWDR');

    const files = { '/c.pem': Buffer.from(pem), '/w.cer': der };
    const readFile = (path) => {
      if (!files[path]) throw new Error(`ENOENT: ${path}`);
      return files[path];
    };
    const env = { APPLE_WALLET_PASS_TYPE_ID: 'pass.x', APPLE_WALLET_TEAM_ID: 'T', APPLE_WALLET_CERT_FILE: '/c.pem', APPLE_WALLET_WWDR_FILE: '/w.cer' };
    const loaded = loadWalletConfig(env, { readFile });
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.apple.passTypeId, 'pass.x');
    assert.equal(loaded.google, null);
    // Ufullstendig oppsett slår Wallet av med en tydelig advarsel.
    const partial = loadWalletConfig({ APPLE_WALLET_TEAM_ID: 'T' }, { readFile });
    assert.equal(partial.apple, null);
    assert.match(partial.warnings[0], /Apple Wallet er slått av: .*APPLE_WALLET_PASS_TYPE_ID/);
    const missingFile = loadWalletConfig({ ...env, APPLE_WALLET_CERT_FILE: '/finnes-ikke' }, { readFile });
    assert.match(missingFile.warnings[0], /Apple Wallet er slått av: ENOENT/);
  });
});

describe('Google Wallet', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { issuerId: '3388000000012345678', clientEmail: 'wallet@prosjekt.iam.gserviceaccount.com', privateKey };
  const opts = { config, event, site, eventUrl: 'https://booking.example.com/abcdefghjkmn', tickets };

  test('lagre-lenken er en RS256-JWT signert med tjenestekontoens nøkkel', () => {
    const url = googleSaveUrl(opts);
    assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\/[\w-]+\.[\w-]+\.[\w-]+$/);
    const [header, body, signature] = url.slice('https://pay.google.com/gp/v/save/'.length).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    assert.ok(verify('sha256', Buffer.from(`${header}.${body}`), publicKey, Buffer.from(signature, 'base64url')));
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    assert.equal(claims.iss, 'wallet@prosjekt.iam.gserviceaccount.com');
    assert.equal(claims.aud, 'google');
    assert.equal(claims.typ, 'savetowallet');
    assert.deepEqual(claims.origins, ['https://booking.example.com']);
  });

  test('klassen har tid, sted og veibeskrivelse; hvert objekt har QR med billettlenken', () => {
    const { payload } = googleClaims({ ...opts, heroImage: 'https://booking.example.com/abcdefghjkmn/bilde/0123456789abcdef.jpg' });
    assert.deepEqual(payload.eventTicketClasses[0].heroImage, { sourceUri: { uri: 'https://booking.example.com/abcdefghjkmn/bilde/0123456789abcdef.jpg' } });
    assert.equal(googleClaims({ ...opts, heroImage: 'http://localhost:3000/x.jpg' }).payload.eventTicketClasses[0].heroImage, undefined);
    const [cls] = payload.eventTicketClasses;
    assert.equal(cls.id, '3388000000012345678.event-abcdefghjkmn');
    assert.deepEqual(cls.dateTime, { start: event.startsAt, end: event.endsAt });
    assert.equal(cls.venue.name.defaultValue.value, 'Grendehuset, Nordbygda');
    assert.deepEqual(cls.linksModuleData.uris[0], {
      id: 'directions', uri: 'https://www.google.com/maps/dir/?api=1&destination=63.1%2C9.8', description: 'Veibeskrivelse',
    });
    assert.equal(payload.eventTicketObjects.length, 2);
    const [obj] = payload.eventTicketObjects;
    assert.equal(obj.id, '3388000000012345678.ticket-k7hq2mxpr9');
    assert.equal(obj.classId, cls.id);
    assert.deepEqual(obj.barcode, { type: 'QR_CODE', value: tickets[0].url, alternateText: 'KMRTW' });
    assert.equal(obj.ticketNumber, 'KMRTW');
    assert.equal(obj.ticketHolderName, 'Ola Nordmann');
  });
});

describe('Wallet i appen', () => {
  test('lenkene finnes bare når Wallet er satt opp og slått på for arrangementet', async () => {
    const { ca, signer } = certificates();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wallet = {
      apple: { passTypeId: 'pass.x', teamId: 'T', cert: signer.cert, key: signer.key, wwdr: ca.cert },
      google: { issuerId: '123', clientEmail: 'a@b.iam.gserviceaccount.com', privateKey },
    };
    const app = await startApp({ ADMIN_NO_AUTH: 'true' }, { configOverrides: { wallet } });
    const config = await app.request({ path: '/api/admin/config' });
    assert.deepEqual(config.json.wallets, { apple: true, google: true });

    const { slug } = await createEvent(app);
    const res = await register(app, slug, { guests: ['Kari'] });
    const path = new URL(res.json.ticketsUrl).pathname;
    const data = await app.request({ path: path.replace('/b/', '/api/bookings/') });
    assert.equal(data.json.links.apple, `${path}/apple`);
    assert.equal(data.json.links.google, `${path}/google`);
    const apple = await app.request({ path: `${path}/apple` });
    assert.equal(apple.status, 200);
    assert.equal(apple.headers['content-type'], 'application/vnd.apple.pkpasses');
    const single = await app.request({ path: `${data.json.tickets[0].path}/apple` });
    assert.equal(single.headers['content-type'], 'application/vnd.apple.pkpass');
    const google = await app.request({ path: `${path}/google` });
    assert.equal(google.status, 302);
    assert.match(google.headers.location, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    const mail = app.sent.find((m) => m.to === 'ola@example.com');
    assert.match(mail.text, /Legg til i Apple Wallet: http:\/\/localhost:3000\/b\/.+\/apple/);
    assert.match(mail.text, /Lagre i Google Wallet: http:\/\/localhost:3000\/b\/.+\/google/);

    const off = await createEvent(app, { features: { appleWallet: false, googleWallet: false } });
    const r2 = await register(app, off.slug, { email: 'ingen@example.com' });
    const p2 = new URL(r2.json.ticketsUrl).pathname;
    assert.equal((await app.request({ path: `${p2}/apple` })).status, 404);
    assert.equal((await app.request({ path: `${p2}/google` })).status, 404);
  });
});

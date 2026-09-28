import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { describe, test } from 'node:test';
import { detectImageType, ImageError, MAX_IMAGE_BYTES, processImage, readOrientation } from '../src/images.js';
import { encodePng } from '../src/png.js';
import { createEvent, startApp } from './helpers.js';

// Opplastede forsidebilder: filtype fra innholdet, størrelsesgrenser og fjerning av metadata (GPS o.l.).

const GPS = 'GPS-POSISJON-59.9139N-10.7522E';

// ---------- Testbilder ----------

function segment(marker, payload) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** TIFF-blokk (little-endian) med retning og en «GPS»-tekst, slik mobilkameraer lager dem. */
function exif(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from(GPS)]);
}

/** En JPEG-struktur: JFIF, EXIF med retning og «GPS», kommentar, SOF (bredde × høyde) og bildedata. */
function jpeg({ width = 640, height = 480, orientation = 6 } = {}) {
  const sof = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xe1, exif(orientation)),
    segment(0xed, Buffer.from(`Photoshop 3.0\0${GPS}`, 'latin1')),
    segment(0xfe, Buffer.from(`Kommentar ${GPS}`)),
    segment(0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
  ]);
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Ekte PNG (fra png.js) med en tekstbit og en eXIf-bit satt inn etter IHDR. */
function png(width = 4, height = 3) {
  const clean = encodePng(width, height, Buffer.alloc(width * height * 4, 200));
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([
    clean.subarray(0, ihdrEnd),
    pngChunk('tEXt', Buffer.from(`Comment\0${GPS}`, 'latin1')),
    pngChunk('eXIf', Buffer.from(GPS)),
    clean.subarray(ihdrEnd),
  ]);
}

/** WebP (VP8X) med EXIF- og XMP-biter og flaggene for dem satt. */
function webp(width = 300, height = 200) {
  const chunk = (fourcc, data) => {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF, XMP og alfa
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([
    chunk('VP8X', vp8x),
    chunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0, 1, 2])),
    chunk('EXIF', Buffer.from(GPS)),
    chunk('XMP ', Buffer.from(`<x>${GPS}</x>`)),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

const hasGps = (buf) => buf.includes(Buffer.from(GPS)) || buf.includes(Buffer.from('59.9139N'));

describe('bildebehandling', () => {
  test('filtypen avgjøres av innholdet', () => {
    assert.equal(detectImageType(jpeg()), 'image/jpeg');
    assert.equal(detectImageType(png()), 'image/png');
    assert.equal(detectImageType(webp()), 'image/webp');
    assert.equal(detectImageType(Buffer.from('GIF89a......')), null);
    assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  });

  test('JPEG: EXIF, Photoshop-data og kommentarer fjernes – retningen beholdes', () => {
    const input = jpeg({ width: 640, height: 480, orientation: 6 });
    assert.ok(hasGps(input));
    const out = processImage(input);
    assert.equal(out.type, 'image/jpeg');
    assert.equal(out.ext, 'jpg');
    assert.ok(!hasGps(out.data), 'ingen metadata igjen');
    // Retning 6 = rotert 90°: bildet vises 480 × 640.
    assert.deepEqual([out.width, out.height], [480, 640]);
    const app1 = out.data.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    assert.ok(app1 > 0, 'en minimal EXIF-blokk med retningen');
    assert.equal(readOrientation(out.data.subarray(app1 + 6)), 6);
    // JFIF først, bildedataene uendret til slutt.
    assert.equal(out.data.toString('latin1', 6, 10), 'JFIF');
    assert.ok(out.data.subarray(-7).equals(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9])));
    assert.match(out.hash, /^[0-9a-f]{16}$/);
  });

  test('JPEG med normal retning får ingen EXIF-blokk', () => {
    const out = processImage(jpeg({ orientation: 1 }));
    assert.equal(out.data.indexOf(Buffer.from('Exif', 'latin1')), -1);
    assert.deepEqual([out.width, out.height], [640, 480]);
  });

  test('PNG: tekst- og eXIf-biter fjernes, resten er uendret', () => {
    const out = processImage(png(4, 3));
    assert.ok(!hasGps(out.data));
    assert.deepEqual(out.data, encodePng(4, 3, Buffer.alloc(4 * 3 * 4, 200)));
    assert.deepEqual([out.width, out.height], [4, 3]);
  });

  test('WebP: EXIF og XMP fjernes, og flaggene i VP8X oppdateres', () => {
    const out = processImage(webp(300, 200));
    assert.ok(!hasGps(out.data));
    assert.equal(out.data.readUInt32LE(4), out.data.length - 8, 'RIFF-størrelsen stemmer');
    assert.equal(out.data[20] & 0x0c, 0, 'EXIF- og XMP-flaggene er av');
    assert.equal(out.data[20] & 0x10, 0x10, 'alfa-flagget beholdes');
    assert.deepEqual([out.width, out.height], [300, 200]);
  });

  test('ugyldige, for store og «bildebomber» avvises', () => {
    const reason = (fn) => { try { fn(); } catch (err) { assert.ok(err instanceof ImageError); return err.message; } return null; };
    assert.equal(reason(() => processImage(Buffer.from('GIF89a'))), 'type');
    assert.equal(reason(() => processImage(Buffer.alloc(0))), 'empty');
    assert.equal(reason(() => processImage(Buffer.concat([jpeg(), Buffer.alloc(MAX_IMAGE_BYTES)]))), 'tooLarge');
    assert.equal(reason(() => processImage(jpeg().subarray(0, 30))), 'corrupt');
    assert.equal(reason(() => processImage(jpeg({ width: 10_000, height: 10_000 }))), 'tooManyPixels');
  });
});

describe('opplasting i appen', () => {
  const upload = (app, slug, key, body, type = 'image/jpeg') => app.request({
    method: 'PUT', path: `/api/admin/events/${slug}/image`,
    headers: { 'content-type': type, 'content-length': body.length, authorization: `Bearer ${key}` }, raw: body,
  });

  test('last opp, vis på arrangementet, bytt, fjern – og bildet slettes med arrangementet', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const { slug, adminKey } = await createEvent(app, { imageUrl: 'https://bilder.example.com/lenke.jpg' });
    assert.equal((await app.request({ path: `/api/events/${slug}` })).json.imageUrl, 'https://bilder.example.com/lenke.jpg');

    // Uten admin-nøkkel: nei.
    assert.equal((await upload(app, slug, 'feil', jpeg())).status, 401);
    // Ikke et bilde, selv om Content-Type sier det.
    const fake = await upload(app, slug, adminKey, Buffer.from('<svg onload="alert(1)"/>'), 'image/png');
    assert.equal(fake.status, 400);
    assert.match(fake.json.error, /Ugyldig bilde/);
    assert.equal((await upload(app, slug, adminKey, Buffer.from('tekst'), 'text/plain')).status, 400);

    const res = await upload(app, slug, adminKey, jpeg());
    assert.equal(res.status, 200);
    assert.match(res.json.uploadedImage, new RegExp(`^http://localhost:3000/${slug}/bilde/[0-9a-f]{16}\\.jpg$`));
    // Det opplastede bildet går foran lenken.
    const event = await app.request({ path: `/api/events/${slug}` });
    assert.equal(event.json.imageUrl, res.json.uploadedImage);
    const admin = await app.request({ path: `/api/admin/events/${slug}`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(admin.json.event.imageUrl, 'https://bilder.example.com/lenke.jpg');
    assert.equal(admin.json.event.uploadedImage, res.json.uploadedImage);

    const path = new URL(res.json.uploadedImage).pathname;
    const image = await app.request({ path });
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/jpeg');
    assert.match(image.headers['cache-control'], /^private/);
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.ok(!image.text.includes(GPS), 'metadata er fjernet før lagring');
    assert.equal((await app.request({ path: path.replace(/[0-9a-f]{16}/, '0'.repeat(16)) })).status, 404);

    // Nytt bilde = ny adresse; den gamle virker ikke lenger.
    const second = await upload(app, slug, adminKey, png(), 'image/png');
    assert.match(second.json.uploadedImage, /\.png$/);
    assert.equal((await app.request({ path })).status, 404);

    const removed = await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}/image`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(removed.json.uploadedImage, null);
    assert.equal((await app.request({ path: `/api/events/${slug}` })).json.imageUrl, 'https://bilder.example.com/lenke.jpg');

    await upload(app, slug, adminKey, webp(), 'image/webp');
    const eventId = app.repo.findEvent(slug).id;
    assert.ok(app.repo.imageMeta(eventId));
    await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(app.repo.imageMeta(eventId), null, 'bildet slettes sammen med arrangementet');
  });

  test('bildet vises bare på arrangementets eget domene', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: 'booking.example.no', SITE_COM_DOMAIN: 'booking.example.com' });
    const { slug, adminKey } = await createEvent(app, { site: 'com' }, { host: 'booking.example.no' });
    const res = await app.request({
      method: 'PUT', path: `/api/admin/events/${slug}/image`, raw: png(),
      headers: { host: 'booking.example.no', 'content-type': 'image/png', 'content-length': png().length, authorization: `Bearer ${adminKey}` },
    });
    const path = new URL(res.json.uploadedImage).pathname;
    assert.match(res.json.uploadedImage, /^https:\/\/booking\.example\.com\//);
    const wrong = await app.request({ path, headers: { host: 'booking.example.no' } });
    assert.equal(wrong.status, 301);
    assert.equal(wrong.headers.location, `https://booking.example.com${path}`);
    assert.equal((await app.request({ path: `/abcdefghjkmn/bilde/${path.split('/').pop()}` })).text, 'Not Found');
  });
});

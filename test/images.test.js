import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { describe, test } from 'node:test';
import sharp from 'sharp';
import { detectImageType, ImageError, MAX_IMAGE_BYTES, processImage, readOrientation } from '../src/images.js';
import { createOgImage, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, OgImageError } from '../src/ogImage.js';
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

// Bildene over har riktig oppbygning, men ingen ekte bildedata – nok for images.js, som aldri leser
// selve bildet. Delingsbildet må dekode bildet, så til det trengs ekte bilder.

/** RGB-piksler: øvre halvdel i fargen `top`, nedre i `bottom` (slik bildet er lagret, før EXIF-retning). */
function halves(width, height, top, bottom) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(y < height / 2 ? top : bottom, (y * width + x) * 3);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

/** Ekte JPEG (rød over blå), med de samme metadataene som jpeg() satt inn rett etter SOI. */
async function realJpeg({ width = 640, height = 480, orientation = 6 } = {}) {
  const clean = await halves(width, height, RED, BLUE).jpeg({ quality: 90 }).toBuffer();
  return Buffer.concat([
    clean.subarray(0, 2),
    segment(0xe1, exif(orientation)),
    segment(0xed, Buffer.from(`Photoshop 3.0\0${GPS}`, 'latin1')),
    segment(0xfe, Buffer.from(`Kommentar ${GPS}`)),
    clean.subarray(2),
  ]);
}

const realWebp = (width = 300, height = 200) => halves(width, height, RED, BLUE).webp().toBuffer();

/** Fargen [r, g, b] i punktet (x, y) av et bilde. */
async function pixel(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.subarray(i, i + 3)];
}
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;

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

    // Riktig oppbygning, men bildedataene kan ikke leses: avvises (nettleseren kunne heller ikke vist det).
    const unreadable = await upload(app, slug, adminKey, jpeg());
    assert.equal(unreadable.status, 400);
    assert.match(unreadable.json.error, /Ugyldig bilde/);
    assert.equal(app.repo.imageMeta(app.repo.findEvent(slug).id), null);

    const res = await upload(app, slug, adminKey, await realJpeg());
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

    assert.equal((await upload(app, slug, adminKey, await realWebp(), 'image/webp')).status, 200);
    const eventId = app.repo.findEvent(slug).id;
    assert.ok(app.repo.imageMeta(eventId));
    await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(app.repo.imageMeta(eventId), null, 'bildet slettes sammen med arrangementet');
  });

  test('bildet vises bare på arrangementets eget domene', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true', DOMAIN: 'arrangement.example.no', SITE_COM_DOMAIN: 'events.example.com' });
    const { slug, adminKey } = await createEvent(app, { site: 'com' }, { host: 'arrangement.example.no' });
    const res = await app.request({
      method: 'PUT', path: `/api/admin/events/${slug}/image`, raw: png(),
      headers: { host: 'arrangement.example.no', 'content-type': 'image/png', 'content-length': png().length, authorization: `Bearer ${adminKey}` },
    });
    const path = new URL(res.json.uploadedImage).pathname;
    assert.match(res.json.uploadedImage, /^https:\/\/events\.example\.com\//);
    const wrong = await app.request({ path, headers: { host: 'arrangement.example.no' } });
    assert.equal(wrong.status, 301);
    assert.equal(wrong.headers.location, `https://events.example.com${path}`);
    // Det samme gjelder delingsbildet.
    const ogPath = new URL(res.json.ogImage).pathname;
    assert.match(res.json.ogImage, /^https:\/\/events\.example\.com\/.*-deling\.jpg$/);
    const wrongOg = await app.request({ path: ogPath, headers: { host: 'arrangement.example.no' } });
    assert.equal(wrongOg.status, 301);
    assert.equal(wrongOg.headers.location, `https://events.example.com${ogPath}`);
    assert.equal((await app.request({ path: ogPath, headers: { host: 'events.example.com' } })).status, 200);
    assert.equal((await app.request({ path: `/abcdefghjkmn/bilde/${path.split('/').pop()}` })).text, 'Not Found');
  });
});

// ---------- Delingsbildet (og:image) ----------

describe('delingsbilde', () => {
  test('1200 × 630 JPEG uten metadata, rotert etter EXIF og beskåret fra midten', async () => {
    // Lagret 640 × 480 med rødt øverst og blått nederst, retning 6 (skal roteres 90° med klokka).
    // Vist riktig er bildet 480 × 640 med blått til venstre og rødt til høyre. Utsnittet fra midten
    // har derfor blått på venstre halvdel og rødt på høyre. Uten rotering ville det vært rødt over blått.
    const og = await createOgImage(processImage(await realJpeg({ orientation: 6 })).data);
    const meta = await sharp(og).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.deepEqual([meta.width, meta.height], [OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT]);
    assert.equal(meta.exif, undefined, 'ingen EXIF');
    assert.equal(meta.xmp, undefined, 'ingen XMP');
    assert.equal(meta.orientation, undefined, 'retningen er brukt, ikke bare skrevet med');
    assert.ok(!hasGps(og));
    assert.ok(isBlue(await pixel(og, 100, 315)), 'venstre er blått');
    assert.ok(isRed(await pixel(og, 1100, 315)), 'høyre er rødt');

    // Et liggende bilde uten retning: rødt over blått, beskåret fra midten.
    const flat = await createOgImage(processImage(await realJpeg({ orientation: 1 })).data);
    assert.ok(isRed(await pixel(flat, 600, 50)));
    assert.ok(isBlue(await pixel(flat, 600, 580)));
  });

  test('gjennomsiktighet blir hvit, og WebP og små bilder gir også 1200 × 630', async () => {
    const transparent = encodePng(40, 30, Buffer.alloc(40 * 30 * 4, 0)); // helt gjennomsiktig
    const og = await createOgImage(transparent);
    assert.deepEqual(await pixel(og, 600, 315), [255, 255, 255]);
    const meta = await sharp(await createOgImage(await realWebp(300, 200))).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT]);
  });

  test('bildedata som ikke kan leses, gir OgImageError', async () => {
    await assert.rejects(createOgImage(processImage(jpeg()).data), OgImageError);
    await assert.rejects(createOgImage(processImage(webp()).data), OgImageError);
  });

  const upload = (app, slug, key, body, type = 'image/jpeg') => app.request({
    method: 'PUT', path: `/api/admin/events/${slug}/image`,
    headers: { 'content-type': type, 'content-length': body.length, authorization: `Bearer ${key}` }, raw: body,
  });
  const metaTags = (html) => Object.fromEntries(
    [...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[\w:]+)" content="([^"]*)">/g)].map((m) => [m[1], m[2]]),
  );

  test('arrangementssiden får og:image fra det opplastede bildet – ikke fra en lenke', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const title = 'Sommerfest <b>"Kos"</b> & $& $\' moro';
    const { slug, adminKey } = await createEvent(app, { title, imageUrl: 'https://bilder.example.com/lenke.jpg' });
    const eventUrl = `http://localhost:3000/${slug}`;

    // Bare en lenke til et bilde: tittel og adresse, men ikke noe bilde.
    let tags = metaTags((await app.request({ path: `/${slug}` })).text);
    assert.equal(tags['og:title'], 'Sommerfest &lt;b&gt;&quot;Kos&quot;&lt;/b&gt; &amp; $&amp; $&#39; moro', 'escapet, og $& tolkes ikke');
    assert.equal(tags['og:url'], eventUrl);
    assert.equal(tags['og:type'], 'website');
    assert.ok(tags['og:site_name']);
    assert.equal(tags['og:image'], undefined);
    assert.equal(tags['twitter:card'], 'summary');

    const res = await upload(app, slug, adminKey, await realJpeg());
    const hash = new URL(res.json.uploadedImage).pathname.match(/([0-9a-f]{16})\.jpg$/)[1];
    assert.equal(res.json.ogImage, `${eventUrl}/bilde/${hash}-deling.jpg`);
    const admin = await app.request({ path: `/api/admin/events/${slug}`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(admin.json.event.ogImage, res.json.ogImage);

    const page = await app.request({ path: `/${slug}` });
    tags = metaTags(page.text);
    assert.equal(tags['og:image'], res.json.ogImage);
    assert.equal(tags['og:image:type'], 'image/jpeg');
    assert.equal(tags['og:image:width'], '1200');
    assert.equal(tags['og:image:height'], '630');
    assert.equal(tags['twitter:card'], 'summary_large_image');
    assert.ok(page.text.indexOf('og:image') < page.text.indexOf('</head>'), 'taggene står i <head>');
    // Avmeldingssiden er personlig og skal ikke ha delingstagger.
    assert.doesNotMatch((await app.request({ path: `/${slug}/avmelding` })).text, /og:/);

    const og = await app.request({ path: new URL(res.json.ogImage).pathname });
    assert.equal(og.status, 200);
    assert.equal(og.headers['content-type'], 'image/jpeg');
    assert.match(og.headers['cache-control'], /^private/);
    const ogBytes = app.repo.ogImage(app.repo.findEvent(slug).id).data;
    const meta = await sharp(ogBytes).metadata();
    assert.deepEqual([meta.width, meta.height], [1200, 630]);
    assert.ok(!hasGps(ogBytes));
    // Feil hash eller filtype: 404.
    assert.equal((await app.request({ path: `/${slug}/bilde/${'0'.repeat(16)}-deling.jpg` })).status, 404);
    assert.equal((await app.request({ path: `/${slug}/bilde/${hash}-deling.png` })).status, 404);

    // Nytt bilde: nytt delingsbilde med ny adresse; det gamle virker ikke lenger.
    const second = await upload(app, slug, adminKey, await realWebp(), 'image/webp');
    assert.notEqual(second.json.ogImage, res.json.ogImage);
    assert.equal(metaTags((await app.request({ path: `/${slug}` })).text)['og:image'], second.json.ogImage);
    assert.equal((await app.request({ path: new URL(res.json.ogImage).pathname })).status, 404);

    // Fjernes bildet, forsvinner også delingsbildet.
    const removed = await app.request({ method: 'DELETE', path: `/api/admin/events/${slug}/image`, headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(removed.json.ogImage, null);
    assert.equal((await app.request({ path: new URL(second.json.ogImage).pathname })).status, 404);
    assert.equal(metaTags((await app.request({ path: `/${slug}` })).text)['og:image'], undefined);
  });

  test('bilder lastet opp før delingsbildet fantes, får det ved vedlikehold', async () => {
    const app = await startApp({ ADMIN_NO_AUTH: 'true' });
    const good = await createEvent(app);
    const bad = await createEvent(app);
    const goodId = app.repo.findEvent(good.slug).id;
    const badId = app.repo.findEvent(bad.slug).id;
    // Slik en rad ser ut etter migreringen: bildet finnes, delingsbildet ikke (NULL).
    app.repo.setImage(goodId, { ...processImage(await realJpeg()), ogData: null });
    app.repo.setImage(badId, { ...processImage(jpeg()), ogData: null });
    assert.equal(app.repo.imageMeta(goodId).hasOg, false);
    assert.equal(metaTags((await app.request({ path: `/${good.slug}` })).text)['og:image'], undefined);

    const { ogImages } = await app.app.runMaintenance();
    assert.equal(ogImages, 1);
    assert.equal(app.repo.imageMeta(goodId).hasOg, true);
    const tags = metaTags((await app.request({ path: `/${good.slug}` })).text);
    assert.match(tags['og:image'], /-deling\.jpg$/);
    assert.equal((await app.request({ path: new URL(tags['og:image']).pathname })).status, 200);

    // Bildet som ikke kunne leses, er merket og prøves ikke igjen – og får ingen og:image.
    assert.equal(app.repo.imageMeta(badId).hasOg, false);
    assert.deepEqual(app.repo.imagesWithoutOg(), []);
    assert.equal((await app.app.runMaintenance()).ogImages, 0);
    assert.equal(metaTags((await app.request({ path: `/${bad.slug}` })).text)['og:image'], undefined);
  });
});

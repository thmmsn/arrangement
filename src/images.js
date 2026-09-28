// Opplastede forsidebilder: gjenkjenning av filtype, størrelsessjekk og fjerning av metadata.
//
// Bilder fra mobilen har ofte EXIF-data med GPS-posisjon, tidspunkt og kameramodell. Det skal ikke
// publiseres på en arrangementsside. Vi fjerner derfor alle metadata før bildet lagres:
//   JPEG: APP1 (EXIF/XMP), APP3–APP13, APP15 og kommentarer fjernes. APP0 (JFIF), APP2 (fargeprofil)
//         og APP14 (Adobe, trengs for CMYK) beholdes. Bildets retning (EXIF Orientation) legges
//         tilbake i en minimal EXIF-blokk, ellers ville mobilbilder vist seg liggende.
//   PNG:  tekstbiter (tEXt, zTXt, iTXt), eXIf og tIME fjernes.
//   WebP: EXIF- og XMP-bitene fjernes, og flaggene i VP8X oppdateres.
// Selve bildedataene endres ikke, så kvaliteten er den samme.
//
// Filtypen avgjøres av innholdet (de første bytene), aldri av filnavnet eller Content-Type.

import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Et lite bilde i bytes kan likevel være enormt i piksler og få nettleseren til å gå tom for minne.
export const MAX_IMAGE_PIXELS = 40_000_000;
export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export class ImageError extends Error {}

/** image/jpeg, image/png, image/webp – eller null. */
export function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Sjekker og renser et opplastet bilde.
 * @returns {{ type: string, ext: string, data: Buffer, hash: string, width: number, height: number }}
 */
export function processImage(input) {
  const buf = Buffer.from(input);
  if (!buf.length) throw new ImageError('empty');
  if (buf.length > MAX_IMAGE_BYTES) throw new ImageError('tooLarge');
  const type = detectImageType(buf);
  if (!type) throw new ImageError('type');
  let result;
  try {
    result = type === 'image/jpeg' ? cleanJpeg(buf) : type === 'image/png' ? cleanPng(buf) : cleanWebp(buf);
  } catch (err) {
    if (err instanceof ImageError) throw err;
    throw new ImageError('corrupt');
  }
  const { data, width, height } = result;
  if (!width || !height) throw new ImageError('corrupt');
  if (width * height > MAX_IMAGE_PIXELS) throw new ImageError('tooManyPixels');
  return { type, ext: IMAGE_TYPES[type], data, width, height, hash: createHash('sha256').update(data).digest('hex').slice(0, 16) };
}

// ---------- JPEG ----------

// SOF-markører (bildestørrelse). C4 (DHT), C8 (JPG) og CC (DAC) er ikke SOF.
const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
const KEEP_APP = new Set([0xe0, 0xe2, 0xee]); // JFIF, ICC-fargeprofil, Adobe

function cleanJpeg(buf) {
  const out = [buf.subarray(0, 2)]; // SOI
  let offset = 2;
  let orientation = 1;
  let width = 0;
  let height = 0;
  let wroteOrientationAfter = -1; // indeks i `out` etter APP0, der EXIF-blokken settes inn
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new ImageError('corrupt');
    const marker = buf[offset + 1];
    if (marker === 0xff) { offset++; continue; } // utfyllingsbyte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === 0xd9) { // EOI
      out.push(buf.subarray(offset, offset + 2));
      break;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buf.length) throw new ImageError('corrupt');
    const segment = buf.subarray(offset, offset + 2 + length);
    const data = buf.subarray(offset + 4, offset + 2 + length);

    if (marker === 0xda) { // SOS: selve bildedataene – resten av filen kopieres uendret
      out.push(buf.subarray(offset));
      break;
    }
    if (marker === 0xe1) {
      if (data.toString('latin1', 0, 6) === 'Exif\0\0') orientation = readOrientation(data.subarray(6)) || orientation;
    } else if ((marker >= 0xe0 && marker <= 0xef && !KEEP_APP.has(marker)) || marker === 0xfe) {
      // Andre applikasjonsbiter og kommentarer: fjernes.
    } else {
      if (isSof(marker)) {
        height = data.readUInt16BE(1);
        width = data.readUInt16BE(3);
      }
      out.push(segment);
      if (marker === 0xe0) wroteOrientationAfter = out.length;
    }
    offset += 2 + length;
  }
  if (orientation !== 1) {
    // Rett etter JFIF-blokken hvis den finnes, ellers rett etter SOI.
    out.splice(wroteOrientationAfter > 0 ? wroteOrientationAfter : 1, 0, orientationSegment(orientation));
  }
  // Retning 5–8 betyr at bildet vises rotert 90°: bredde og høyde bytter plass.
  return { data: Buffer.concat(out), width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height };
}

/** EXIF-retningen (1–8) fra en TIFF-blokk, eller 0. */
export function readOrientation(tiff) {
  if (tiff.length < 8) return 0;
  const little = tiff.toString('latin1', 0, 2) === 'II';
  if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return 0;
  const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return 0;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 0;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 0;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/** En minimal APP1/EXIF-blokk med bare retningen (big-endian TIFF, ett felt i IFD0). */
function orientationSegment(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 starter rett etter headeren
  tiff.writeUInt16BE(1, 8); // ett felt
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // type SHORT
  tiff.writeUInt32BE(1, 14); // antall
  tiff.writeUInt16BE(orientation, 18); // verdien, venstrejustert i 4 byte
  tiff.writeUInt32BE(0, 22); // ingen flere IFD-er
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// ---------- PNG ----------

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function cleanPng(buf) {
  const out = [buf.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buf.length) throw new ImageError('corrupt');
    if (offset === 8) {
      if (type !== 'IHDR') throw new ImageError('corrupt');
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
    }
    if (!PNG_DROP.has(type)) out.push(buf.subarray(offset, end));
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new ImageError('corrupt');
  return { data: Buffer.concat(out), width, height };
}

// ---------- WebP ----------

function cleanWebp(buf) {
  const chunks = [];
  let offset = 12;
  let width = 0;
  let height = 0;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2); // biter er fylt ut til et partall byte
    if (offset + 8 + size > buf.length) throw new ImageError('corrupt');
    const data = buf.subarray(offset + 8, offset + 8 + size);
    if (fourcc === 'VP8X' && size >= 10) {
      width = 1 + data.readUIntLE(4, 3);
      height = 1 + data.readUIntLE(7, 3);
      const copy = Buffer.from(buf.subarray(offset, Math.min(end, buf.length)));
      copy[8] &= ~(0x08 | 0x04); // flaggene for EXIF og XMP
      chunks.push(copy);
    } else if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      // fjernes
    } else {
      if (fourcc === 'VP8 ' && !width && size >= 10) {
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
      } else if (fourcc === 'VP8L' && !width && size >= 5) {
        const bits = data.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      }
      chunks.push(buf.subarray(offset, Math.min(end, buf.length)));
    }
    offset = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return { data: Buffer.concat([head, body]), width, height };
}

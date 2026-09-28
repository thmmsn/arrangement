// Minimal PNG-koder og ikonet til Apple Wallet-kortene (Wallet krever icon.png).
// Ikonet lages fra nettstedets aksentfarge, så ingen bildefil trengs.
import { crc32, deflateSync } from 'node:zlib';

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA-piksler (width × height × 4 byte) → PNG. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit per kanal
  header[9] = 6; // RGBA
  // 10–12: komprimering, filter og interlace = 0
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filtertype 0 (ingen) for hver rad
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** «#8b2e2a» / «#abc» → [139, 46, 42], ellers null. */
export function hexToRgb(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value || '');
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * Et rundt ikon i fargen `rgb`, med en hvit billett-stripe i midten. Kantene glattes ved å
 * regne dekning i 4 × 4 punkter per piksel.
 */
export function ticketIcon(size, rgb) {
  const pixels = Buffer.alloc(size * size * 4);
  const r = size / 2;
  const inStripe = (x, y) => Math.abs(y - r) < size * 0.1 && Math.abs(x - r) < size * 0.28;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let circle = 0;
      let stripe = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const x = px + (sx + 0.5) / 4;
          const y = py + (sy + 0.5) / 4;
          if ((x - r) ** 2 + (y - r) ** 2 <= r * r) {
            circle++;
            if (inStripe(x, y)) stripe++;
          }
        }
      }
      const i = (py * size + px) * 4;
      const white = stripe / Math.max(circle, 1);
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(rgb[c] * (1 - white) + 255 * white);
      pixels[i + 3] = Math.round((circle / 16) * 255);
    }
  }
  return encodePng(size, size, pixels);
}

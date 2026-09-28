// QR-koder til billettene: som SVG (nettsiden) og som rutenett (PDF-en tegner rutene selv).
import QRCode from 'qrcode';

// Feilretting M (15 %) tåler litt riper og refleks i skjermen, uten at koden blir unødig tett.
const OPTIONS = { errorCorrectionLevel: 'M' };
// Den hvite rammen rundt koden. Standarden krever 4 ruter; uten den sliter mange lesere.
const QUIET_ZONE = 4;

/** { size, dark(x, y) } for teksten – brukes til å tegne koden selv. */
export function qrMatrix(text) {
  const { modules } = QRCode.create(text, OPTIONS);
  return { size: modules.size, dark: (x, y) => modules.get(y, x) === 1 };
}

/**
 * QR-koden som et selvstendig SVG-bilde med hvit bakgrunn (også i mørk modus – svart på hvitt leses
 * best). Hver rad tegnes som én sti med sammenhengende biter, så filen blir liten.
 */
export function qrSvg(text) {
  const { size, dark } = qrMatrix(text);
  const total = size + QUIET_ZONE * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!dark(x, y)) continue;
      let run = 1;
      while (x + run < size && dark(x + run, y)) run++;
      path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  // width/height gir bildet en naturlig størrelse (8 px per rute), så det blir skarpt også uten CSS.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * 8}" height="${total * 8}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
}

// PDF-billett: én side (A5) per person, formet som en billett med avrivningskant.
//
//   ┌──────────────────────────────┐  bånd i aksentfargen
//   │ [logo]              BILLETT  │  topp i nettstedets bakgrunnsfarge – samme kontrast som logoen
//   │                      1 av 3  │  har på nettsiden
//   ├──────────────────────────────┤
//   │ Tittel, tid og sted          │
//   │ NAVN  Ola Nordmann           │
//   ├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤  avrivningskant med hakk i sidene
//   │          [QR-kode]           │
//   │     DØRKODE  ABCDE           │
//   │  Arrangør · lenke            │
//   └──────────────────────────────┘
//
// Logoen (PNG, JPEG eller SVG) hentes av logo.js. Uten logo står nettstedsnavnet øverst.
// Legges ved bekreftelses-e-posten og kan lastes ned fra billettsiden.
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { formatEventTime } from './format.js';
import { formatCode } from './ids.js';
import { qrMatrix } from './qr.js';

// PDF-ens innebygde fonter (Helvetica, Courier) trenger ingen fontfiler, men kan bare vise tegnene i
// Windows-1252: hele det vestlige alfabetet med æ, ø, å, é, ü osv., pluss € – “ ” … og noen til.
// Andre tegn byttes mot nærmeste bokstav uten aksent (ł → l, ő → o), eller «?» som siste utvei,
// slik at PDF-en aldri får uleselige tegn.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const TRANSLITERATE = { ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', ħ: 'h', Ħ: 'H', ŋ: 'n', Ŋ: 'N', ŧ: 't', Ŧ: 'T' };

const isWinAnsi = (char) => {
  const code = char.codePointAt(0);
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char) || char === '\n';
};

export function pdfSafe(text) {
  let out = '';
  for (const char of String(text ?? '')) {
    if (isWinAnsi(char)) out += char;
    else if (TRANSLITERATE[char]) out += TRANSLITERATE[char];
    else {
      const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += base && [...base].every(isWinAnsi) ? base : '?';
    }
  }
  return out;
}

// Temafarger kan være alt CSS forstår (hsl(), oklch() …); PDF-en bruker bare vanlige heksfarger.
const hexColor = (value, fallback) => (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value || '') ? value : fallback);

// Kontrast etter WCAG, så teksten er lesbar også når temaet har mørk bakgrunn eller lys tekst
// (billetten er hvit, og skal kunne skrives ut).
function luminance(hex) {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `color` hvis den er lesbar mot `background`, ellers svart eller hvit. */
const readable = (color, background, min) => (contrast(color, background) >= min ? color
  : luminance(background) > 0.4 ? '#1e1e1e' : '#ffffff');

const PAGE_MARGIN = 24;
const PAD = 22;
const BAND = 6;
const HEADER = 76;
const LOGO_BOX = { width: 170, height: 40 };
const QR_SIZE = 170;
const NOTCH = 9;

/**
 * @param {object} opts
 * @param {object} opts.event
 * @param {object} opts.site       Nettstedet (språk, tema)
 * @param {string} opts.timeZone
 * @param {string} opts.eventUrl
 * @param {{ name: string, code: string, doorCode: string, url: string }[]} opts.tickets  Én side per billett
 * @param {{ type: 'png' | 'jpeg' | 'svg', data: Buffer } | null} [opts.logo]  Fra logo.js
 * @returns {Promise<Buffer>}
 */
export function ticketsPdf({ event, site, timeZone, eventUrl, tickets, logo = null }) {
  const { t, theme } = site;
  const white = '#ffffff';
  const headerBg = hexColor(theme.colors.background, '#f5efe4');
  const colors = {
    accent: hexColor(theme.colors.accent, '#8b2e2a'),
    text: readable(hexColor(theme.colors.text, '#2b2420'), white, 4.5),
    muted: readable(hexColor(theme.colors.muted, '#6b5e53'), white, 4.5),
    border: hexColor(theme.colors.border, '#e3d9c8'),
  };
  const onHeader = {
    kicker: readable(colors.accent, headerBg, 3),
    text: readable(hexColor(theme.colors.text, '#2b2420'), headerBg, 4.5),
    muted: readable(hexColor(theme.colors.muted, '#6b5e53'), headerBg, 4.5),
  };
  const doc = new PDFDocument({
    size: 'A5',
    margin: 0,
    autoFirstPage: false,
    info: { Title: pdfSafe(event.title), Author: pdfSafe(theme.siteName || event.organizerName), Creator: pdfSafe(theme.siteName || 'Arrangement') },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Bildet bygges inn én gang og brukes på alle sidene.
  const image = logo && logo.type !== 'svg' ? doc.openImage(logo.data) : null;
  const svg = logo?.type === 'svg' ? logo.data.toString('utf8') : null;
  const when = formatEventTime(event.startsAt, event.endsAt, timeZone, site.lang);

  const drawLogo = (x, y) => {
    if (image) {
      doc.image(image, x, y, { fit: [LOGO_BOX.width, LOGO_BOX.height], valign: 'center' });
    } else if (svg) {
      SVGtoPDF(doc, svg, x, y, { ...LOGO_BOX, preserveAspectRatio: 'xMinYMid meet' });
    } else if (theme.siteName) {
      doc.font('Helvetica-Bold').fontSize(13).fillColor(onHeader.text)
        .text(pdfSafe(theme.siteName), x, y + LOGO_BOX.height / 2 - 8, { width: LOGO_BOX.width, height: 18, lineBreak: false, ellipsis: true });
    }
  };

  tickets.forEach((ticket, index) => {
    doc.addPage();
    const { width, height } = doc.page;
    const card = { x: PAGE_MARGIN, y: PAGE_MARGIN, w: width - 2 * PAGE_MARGIN, h: height - 2 * PAGE_MARGIN };
    const left = card.x + PAD;
    const inner = card.w - 2 * PAD;
    const bottom = card.y + card.h;

    // Kortet: hvitt med avrundede hjørner. Toppen (bånd og logofelt) klippes til hjørnene.
    doc.roundedRect(card.x, card.y, card.w, card.h, 12).fill(white);
    doc.save();
    doc.roundedRect(card.x, card.y, card.w, card.h, 12).clip();
    doc.rect(card.x, card.y, card.w, HEADER).fill(headerBg);
    doc.rect(card.x, card.y, card.w, BAND).fill(colors.accent);
    doc.restore();
    doc.moveTo(card.x, card.y + HEADER).lineTo(card.x + card.w, card.y + HEADER).lineWidth(1).strokeColor(colors.border).stroke();

    // Topp: logo til venstre, «BILLETT» og nummeret i påmeldingen til høyre.
    const headerMid = card.y + BAND + (HEADER - BAND) / 2;
    drawLogo(left, headerMid - LOGO_BOX.height / 2);
    const several = tickets.length > 1 || ticket.total > 1;
    const kickerY = several ? headerMid - 12 : headerMid - 5;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(onHeader.kicker)
      .text(pdfSafe(t('wallet.ticket').toUpperCase()), left, kickerY, { width: inner, align: 'right', characterSpacing: 2 });
    if (several) {
      // «1 / 3» som i Wallet – ordet «billett» står allerede over.
      doc.font('Helvetica').fontSize(10).fillColor(onHeader.muted)
        .text(`${ticket.index ?? index + 1} / ${ticket.total ?? tickets.length}`, left, kickerY + 14, { width: inner, align: 'right' });
    }

    // Arrangementet og hvem billetten gjelder. Lange titler og steder kuttes, så QR-koden alltid får plass.
    doc.font('Helvetica-Bold').fontSize(20).fillColor(colors.text)
      .text(pdfSafe(event.title), left, card.y + HEADER + 20, { width: inner, height: 50, ellipsis: true, lineGap: 1 });
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(11).fillColor(colors.text).text(pdfSafe(when), { width: inner, height: 30, ellipsis: true });
    if (event.location) doc.fillColor(colors.muted).text(pdfSafe(event.location), { width: inner, height: 28, ellipsis: true });
    doc.moveDown(0.9);
    doc.font('Helvetica').fontSize(8).fillColor(colors.muted).text(pdfSafe(t('ticket.holder').toUpperCase()), { characterSpacing: 1.5 });
    doc.moveDown(0.15);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(colors.text).text(pdfSafe(ticket.name), { width: inner, height: 22, ellipsis: true });

    // Avrivningskant med et hakk i hver side, som på en billett.
    const stubHeight = 18 + QR_SIZE + 62 + 34;
    const perforation = Math.max(doc.y + 16, bottom - stubHeight);
    doc.circle(card.x, perforation, NOTCH).fill(white);
    doc.circle(card.x + card.w, perforation, NOTCH).fill(white);
    doc.moveTo(card.x + NOTCH + 6, perforation).lineTo(card.x + card.w - NOTCH - 6, perforation)
      .lineWidth(1).dash(4, { space: 4 }).strokeColor(colors.border).stroke().undash();

    // Kortets kant: rundt hele, med hakkene bøyd inn.
    const r = 12;
    doc.path([
      `M ${card.x + r} ${card.y}`,
      `H ${card.x + card.w - r}`, `A ${r} ${r} 0 0 1 ${card.x + card.w} ${card.y + r}`,
      `V ${perforation - NOTCH}`, `A ${NOTCH} ${NOTCH} 0 0 0 ${card.x + card.w} ${perforation + NOTCH}`,
      `V ${bottom - r}`, `A ${r} ${r} 0 0 1 ${card.x + card.w - r} ${bottom}`,
      `H ${card.x + r}`, `A ${r} ${r} 0 0 1 ${card.x} ${bottom - r}`,
      `V ${perforation + NOTCH}`, `A ${NOTCH} ${NOTCH} 0 0 0 ${card.x} ${perforation - NOTCH}`,
      `V ${card.y + r}`, `A ${r} ${r} 0 0 1 ${card.x + r} ${card.y}`, 'Z',
    ].join(' ')).lineWidth(1).strokeColor(colors.border).stroke();

    // QR-koden tegnes som vektorruter: skarp i alle størrelser og på alle skrivere.
    const qr = qrMatrix(ticket.url);
    const cell = QR_SIZE / (qr.size + 8);
    const qrX = (width - QR_SIZE) / 2;
    const qrY = perforation + 18;
    doc.fillColor('#000000');
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.dark(x, y)) doc.rect(qrX + (x + 4) * cell, qrY + (y + 4) * cell, cell + 0.05, cell + 0.05);
      }
    }
    doc.fill('#000000');

    // Dørkoden stort under QR-koden, så den kan leses opp og tastes inn hvis QR-koden ikke virker.
    doc.font('Helvetica').fontSize(8).fillColor(colors.muted)
      .text(pdfSafe(t('ticket.doorCode').toUpperCase()), left, qrY + QR_SIZE + 4, { width: inner, align: 'center', characterSpacing: 1.5 });
    doc.font('Courier-Bold').fontSize(28).fillColor(colors.text)
      .text(ticket.doorCode || formatCode(ticket.code), left, doc.y + 2, { width: inner, align: 'center', characterSpacing: 5 });

    // Nederst: arrangør og lenke til arrangementssiden.
    const footer = [t('ticket.organizer', { name: event.organizerName }), eventUrl].map(pdfSafe).join('   ·   ');
    doc.font('Helvetica').fontSize(7.5).fillColor(colors.muted)
      .text(footer, left, bottom - 24, { width: inner, align: 'center', lineBreak: false, ellipsis: true });
  });

  doc.end();
  return done;
}

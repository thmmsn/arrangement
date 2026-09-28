// PDF-billett: én side (A5) per person, med arrangement, navn, QR-kode og billettnummer.
// Legges ved bekreftelses-e-posten og kan lastes ned fra billettsiden.
import PDFDocument from 'pdfkit';
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

/**
 * @param {object} opts
 * @param {object} opts.event
 * @param {object} opts.site       Nettstedet (språk, tema)
 * @param {string} opts.timeZone
 * @param {string} opts.eventUrl
 * @param {{ name: string, code: string, url: string }[]} opts.tickets  Én side per billett
 * @returns {Promise<Buffer>}
 */
export function ticketsPdf({ event, site, timeZone, eventUrl, tickets }) {
  const { t, theme } = site;
  const colors = {
    accent: hexColor(theme.colors.accent, '#8b2e2a'),
    text: hexColor(theme.colors.text, '#2b2420'),
    muted: hexColor(theme.colors.muted, '#6b5e53'),
    border: hexColor(theme.colors.border, '#e3d9c8'),
  };
  const doc = new PDFDocument({
    size: 'A5',
    margin: 36,
    autoFirstPage: false,
    info: { Title: pdfSafe(event.title), Author: pdfSafe(theme.siteName || event.organizerName), Creator: 'Booking' },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const when = formatEventTime(event.startsAt, event.endsAt, timeZone, site.lang);

  tickets.forEach((ticket, index) => {
    doc.addPage();
    const { width, height } = doc.page;
    const left = 36;
    const contentWidth = width - 72;

    // Et smalt bånd i aksentfargen øverst, som på nettsiden.
    doc.rect(0, 0, width, 8).fill(colors.accent);

    doc.y = 36;
    if (theme.siteName) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(colors.accent)
        .text(pdfSafe(theme.siteName.toUpperCase()), left, doc.y, { width: contentWidth, characterSpacing: 1.5 });
      doc.moveDown(0.6);
    }
    doc.font('Helvetica-Bold').fontSize(22).fillColor(colors.text).text(pdfSafe(event.title), { width: contentWidth });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11).fillColor(colors.text).text(pdfSafe(when), { width: contentWidth });
    if (event.location) doc.fillColor(colors.muted).text(pdfSafe(event.location), { width: contentWidth });

    doc.moveDown(0.8);
    doc.moveTo(left, doc.y).lineTo(width - left, doc.y).lineWidth(1).strokeColor(colors.border).stroke();
    doc.moveDown(0.8);

    doc.font('Helvetica').fontSize(9).fillColor(colors.muted).text(pdfSafe(t('ticket.holder').toUpperCase()), { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(17).fillColor(colors.text).text(pdfSafe(ticket.name), { width: contentWidth });
    if (tickets.length > 1 || ticket.total > 1) {
      doc.font('Helvetica').fontSize(10).fillColor(colors.muted)
        .text(pdfSafe(t('ticket.position', { n: ticket.index ?? index + 1, total: ticket.total ?? tickets.length })));
    }

    // QR-koden tegnes som vektorruter: skarp i alle størrelser og på alle skrivere.
    const qr = qrMatrix(ticket.url);
    const size = Math.min(200, contentWidth);
    const cell = size / (qr.size + 8);
    const qrX = (width - size) / 2;
    const qrY = Math.max(doc.y + 16, 0);
    doc.rect(qrX, qrY, size, size).fill('#ffffff');
    doc.fillColor('#000000');
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.dark(x, y)) doc.rect(qrX + (x + 4) * cell, qrY + (y + 4) * cell, cell + 0.05, cell + 0.05);
      }
    }
    doc.fill('#000000');

    doc.font('Courier-Bold').fontSize(15).fillColor(colors.text)
      .text(formatCode(ticket.code), left, qrY + size + 6, { width: contentWidth, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(colors.muted)
      .text(pdfSafe(t('ticket.number')), { width: contentWidth, align: 'center' });

    // Nederst: arrangør og lenke til arrangementssiden.
    const footer = [t('ticket.organizer', { name: event.organizerName }), eventUrl].map(pdfSafe).join('   ·   ');
    doc.font('Helvetica').fontSize(8).fillColor(colors.muted)
      .text(footer, left, height - 48, { width: contentWidth, align: 'center', lineBreak: false, ellipsis: true });
  });

  doc.end();
  return done;
}

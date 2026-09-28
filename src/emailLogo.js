// Logoen i e-postene: bygget inn i selve e-posten som PNG, i stedet for en lenke til et bilde.
//
// Med en lenke (<img src="https://…/logo.svg">) vises logoen ofte ikke:
//   - Gmail, Outlook og de fleste andre e-postklienter viser ikke SVG i det hele tatt.
//   - Mange klienter (bl.a. Outlook) viser ikke bilder fra nettet før mottakeren trykker «Vis bilder».
//   - Bildet må kunne hentes fra internett – ikke fra localhost, LAN eller bak Cloudflare Access.
// Et innebygd bilde (vedlegg med Content-ID, vist med src="cid:…") har ingen av disse problemene.
//
// Logoen leses som til PDF-billetten (logo.js: ./branding, ./public/assets eller https) og gjøres om til
// PNG med dobbel oppløsning, så den er skarp på skjermer med høy pikseltetthet. En SVG tegnes av sharp
// direkte i målstørrelsen (ikke forstørret fra et lite bilde), så den blir skarp uansett hvor liten den
// er definert. Bredde og høyde settes både som attributter og i style, fordi Outlook for Windows bare
// bryr seg om attributtene.
//
// Resultatet holdes i minnet per logo og høyde – temaet endres bare ved omstart.

import sharp from 'sharp';

export const EMAIL_LOGO_CID = 'logo';
// E-posten er maks 560 piksler bred; logoen får ikke være bredere enn innholdet.
export const MAX_EMAIL_LOGO_WIDTH = 480;
const SCALE = 2;

/**
 * @param {object} opts
 * @param {(theme: object) => Promise<{ type: string, data: Buffer } | null>} opts.logoFor  logo.js
 * @returns {(theme: object) => Promise<{ cid: string, png: Buffer, width: number, height: number } | null>}
 *   width og height er visningsstørrelsen i piksler; PNG-en har dobbelt så mange.
 */
export function createEmailLogo({ logoFor, logger = console }) {
  const cache = new Map();

  async function render(logo, logoHeight) {
    // Størrelsen slik bildet vises (etter EXIF-retning, f.eks. et JPEG tatt med mobilen).
    const meta = await sharp(logo.data).metadata();
    const { width: w, height: h } = meta.autoOrient ?? meta;
    if (!w || !h) throw new Error('bildet har ingen størrelse');
    let height = logoHeight;
    let width = Math.round((w * height) / h);
    if (width > MAX_EMAIL_LOGO_WIDTH) {
      width = MAX_EMAIL_LOGO_WIDTH;
      height = Math.max(1, Math.round((h * width) / w));
    }
    const png = await sharp(logo.data)
      .rotate()
      .resize(width * SCALE, height * SCALE, { fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { cid: EMAIL_LOGO_CID, png, width, height };
  }

  return function emailLogoFor(theme) {
    if (!theme?.logoUrl) return Promise.resolve(null);
    const key = `${theme.logoUrl}|${theme.logoHeight}`;
    if (!cache.has(key)) {
      // logoFor gir null (og en advarsel) hvis logoen ikke kan leses; den prøver selv igjen senere.
      const promise = Promise.resolve(logoFor(theme)).then(async (logo) => {
        if (!logo) {
          cache.delete(key);
          return null;
        }
        return render(logo, theme.logoHeight);
      }).catch((err) => {
        logger.warn?.(`ADVARSEL: LOGO_URL=${theme.logoUrl} kan ikke bygges inn i e-postene (${err.message}). Lenken til logoen brukes i stedet.`);
        return null;
      });
      cache.set(key, promise);
    }
    return cache.get(key);
  };
}

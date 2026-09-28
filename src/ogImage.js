// Delingsbildet (og:image): en egen versjon av det opplastede forsidebildet, laget for forhåndsvisning
// når arrangementslenken deles i Messenger, Slack, Teams, iMessage, LinkedIn o.l.
//
// Disse tjenestene viser et bilde i forholdet 1,91 : 1 og vil helst ha 1200 × 630 piksler. Et
// forsidebilde kan ha hvilken som helst form, være opptil 2000 piksler (eller mer), være WebP (som ikke
// alle forstår) eller ha gjennomsiktighet (som blir svart hos noen). Derfor lages en egen JPEG:
//   - beskåret til 1200 × 630 fra midten – samme utsnitt som forsidebildet på arrangementssiden, som
//     vises med object-fit: cover
//   - rotert etter EXIF-retningen, så mobilbilder ikke blir liggende
//   - gjennomsiktige områder fylles med hvitt
//   - uten metadata (sharp skriver ingen EXIF, XMP eller fargeprofil med mindre man ber om det), og
//     fargene gjøres om til sRGB
// Bildet lages én gang, når forsidebildet lastes opp, og lagres ved siden av det i databasen.

import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from './images.js';

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_TYPE = 'image/jpeg';

export class OgImageError extends Error {}

/** Opplastet bilde (JPEG, PNG eller WebP, allerede sjekket av processImage) → delingsbildet som JPEG. */
export async function createOgImage(data) {
  try {
    return await sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })
      .rotate()
      .resize(OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    // Filen hadde riktig oppbygning, men bildedataene kunne ikke leses (ødelagt eller avkortet).
    throw new OgImageError(err.message);
  }
}

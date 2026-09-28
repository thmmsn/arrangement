// Nøkler til billetter, påmeldinger og dørvakter – avledet med HMAC fra én hemmelighet i databasen.
//
// Hvorfor avledet og ikke tilfeldig lagret? En billettlenke må kunne lages på nytt når som helst:
// i e-posten, på siden med alle billettene i en påmelding, i PDF-en og i Wallet-kortene. Lagret
// vi bare en hash (slik som avmeldingsnøkkelen), kunne serveren aldri vist lenken igjen. Lagret vi
// selve nøkkelen, ville en lekket databasefil gitt tilgang til alle billettene. Med HMAC lagres bare
// billettnummeret, og lenken = nummer + signatur(nummer) kan bare lages av den som kjenner hemmeligheten.
//
//   billett:     /t/<nummer><signatur>   f.eks. /t/k7hq2mxpr9Xy3…  (10 + 22 tegn)
//   påmelding:   /b/<nummer><signatur>   alle billettene i én påmelding
//   dørvakt:     /<slug>/skanner#<nøkkel>, nøkkelen avhenger av arrangementet og en versjon, så
//                arrangøren kan lage en ny lenke (og stenge ute alle som hadde den gamle).
//   avmelding:   /<slug>/avmelding#<nummer><signatur>, med eget formål for hele påmeldingen
//                (påmeldingsnummeret) og for én person (billettnummeret).
//
// Avmeldingsnøkkelen for én person er med vilje en ANNEN nøkkel enn billettnøkkelen: billettlenken
// står i QR-koden, som vises fram i døra, i Wallet og på utskrifter. Den som ser eller tar bilde av
// QR-koden, skal kunne vise billetten – men ikke melde personen av.
//
// Signaturen er 128 bit – umulig å gjette. Et ugyldig forsøk gir samme nakne 404 som alt annet.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { CODE_LENGTH, CODE_PATTERN } from './ids.js';

const MAC_BYTES = 16; // 128 bit → 22 tegn base64url
const TOKEN_PATTERN = new RegExp(`^[a-z0-9]{${CODE_LENGTH}}[A-Za-z0-9_-]{22}$`);

export function createTokens(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Mangler hemmelighet for billettnøkler.');

  // Formålet er med i det som signeres, så en billettsignatur aldri kan brukes som påmeldingssignatur.
  const mac = (purpose, value) =>
    createHmac('sha256', secret).update(`${purpose}:${value}`).digest().subarray(0, MAC_BYTES).toString('base64url');

  const equal = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  const sign = (purpose) => (code) => code + mac(purpose, code);
  /** Nøkkel → nummer, eller null hvis nøkkelen ikke er ekte. */
  const verify = (purpose) => (token) => {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const code = token.slice(0, CODE_LENGTH);
    return CODE_PATTERN.test(code) && equal(token.slice(CODE_LENGTH), mac(purpose, code)) ? code : null;
  };

  return {
    ticket: sign('ticket'),
    parseTicket: verify('ticket'),
    booking: sign('booking'),
    parseBooking: verify('booking'),
    /** Avmelding for hele påmeldingen (fra påmeldingsnummeret). */
    cancelBooking: sign('cancel-booking'),
    parseCancelBooking: verify('cancel-booking'),
    /** Avmelding for én person (fra billettnummeret) – til å videresende sammen med billetten. */
    cancelTicket: sign('cancel-ticket'),
    parseCancelTicket: verify('cancel-ticket'),
    /** Dørvaktnøkkelen for et arrangement. Ny versjon = ny nøkkel, og den gamle slutter å virke. */
    scanner: (eventId, version) => mac('scanner', `${eventId}:${version}`),
    scannerMatches: (key, eventId, version) => typeof key === 'string' && equal(key, mac('scanner', `${eventId}:${version}`)),
  };
}

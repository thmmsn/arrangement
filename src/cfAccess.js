import { createPublicKey, verify } from 'node:crypto';

// Verifisering av Cloudflare Access-tokenet (JWT) som Cloudflare legger på hver forespørsel
// til en Access-beskyttet adresse, i headeren «Cf-Access-Jwt-Assertion».
//
// Hvorfor sjekke dette i appen når Cloudflare allerede har stoppet uvedkommende? Fordi en
// feilkonfigurert Access-regel (feil sti, feil domene, glemt /api/admin) ellers ville latt admin
// stå åpen uten at noen merket det. Med denne sjekken slipper bare forespørsler som faktisk har
// passert Access inn – uansett hvordan de kom seg frem.
// Se https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

const KEY_CACHE_MS = 60 * 60_000; // Cloudflare roterer nøklene sjelden; hent dem på nytt hver time.
const MIN_REFRESH_MS = 60_000; // Ukjent nøkkel-id gir ny henting, men maks én gang i minuttet.
const CLOCK_SKEW_S = 60; // Tåler litt forskjell mellom klokkene våre og Cloudflares.

export class AccessError extends Error {}

/**
 * @param {object} opts
 * @param {string} opts.teamDomain   f.eks. «mittteam.cloudflareaccess.com»
 * @param {string[]} opts.audiences  «Application Audience (AUD) Tag» fra Access-applikasjonen(e)
 */
export function createAccessVerifier({ teamDomain, audiences, fetchImpl = fetch, now = () => Date.now() }) {
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = new Map();
  let fetchedAt = 0;

  async function refreshKeys() {
    const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Kunne ikke hente Cloudflare Access-nøkler (${res.status})`);
    const { keys: jwks } = await res.json();
    keys = new Map(jwks.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })]));
    fetchedAt = now();
  }

  async function keyFor(kid) {
    if (!keys.size || now() - fetchedAt > KEY_CACHE_MS) await refreshKeys();
    if (!keys.has(kid) && now() - fetchedAt > MIN_REFRESH_MS) await refreshKeys();
    return keys.get(kid);
  }

  /** Returnerer innholdet i tokenet (bl.a. e-postadressen) eller kaster AccessError. */
  return async function verifyAccessToken(token) {
    if (typeof token !== 'string' || !token) throw new AccessError('Mangler Cloudflare Access-token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessError('Ugyldig token');

    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new AccessError('Ugyldig token');
    }
    // Bare RS256 godtas – aldri «none» eller en algoritme angriperen velger selv.
    if (header.alg !== 'RS256') throw new AccessError('Ugyldig algoritme');

    const key = await keyFor(header.kid);
    if (!key) throw new AccessError('Ukjent signeringsnøkkel');
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) {
      throw new AccessError('Ugyldig signatur');
    }

    const nowS = now() / 1000;
    if (payload.iss !== issuer) throw new AccessError('Feil utsteder');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => audiences.includes(a))) throw new AccessError('Tokenet gjelder en annen applikasjon');
    if (typeof payload.exp !== 'number' || payload.exp < nowS - CLOCK_SKEW_S) throw new AccessError('Tokenet er utløpt');
    if (typeof payload.nbf === 'number' && payload.nbf > nowS + CLOCK_SKEW_S) throw new AccessError('Tokenet er ikke gyldig ennå');

    return payload;
  };
}

/** Henter tokenet fra headeren Cloudflare setter, eller fra CF_Authorization-cookien. */
export function accessTokenFrom(req) {
  const header = req.get('cf-access-jwt-assertion');
  if (header) return header;
  const cookie = req.get('cookie') || '';
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : '';
}

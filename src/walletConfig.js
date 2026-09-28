// Oppsett for Apple Wallet og Google Wallet, fra miljøvariabler og filer (se .env.example).
// Begge er valgfrie. Er oppsettet ufullstendig eller filene ugyldige, slås Wallet av med en
// tydelig advarsel ved oppstart – appen starter uansett.
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import forge from 'node-forge';

const APPLE_KEYS = ['APPLE_WALLET_PASS_TYPE_ID', 'APPLE_WALLET_TEAM_ID', 'APPLE_WALLET_CERT_FILE', 'APPLE_WALLET_WWDR_FILE'];
const GOOGLE_KEYS = ['GOOGLE_WALLET_ISSUER_ID', 'GOOGLE_WALLET_KEY_FILE'];

/** @returns {{ apple: object | null, google: object | null, warnings: string[] }} */
export function loadWalletConfig(env, { readFile = readFileSync, now = new Date() } = {}) {
  const warnings = [];
  return {
    apple: loadApple(env, readFile, warnings, now),
    google: loadGoogle(env, readFile, warnings),
    warnings,
  };
}

const missingOf = (env, keys) => keys.filter((key) => !(env[key] || '').trim());

function loadApple(env, readFile, warnings, now) {
  const missing = missingOf(env, APPLE_KEYS);
  if (missing.length === APPLE_KEYS.length) return null;
  if (missing.length) {
    warnings.push(`Apple Wallet er slått av: ${missing.join(', ')} mangler.`);
    return null;
  }
  try {
    const { cert, key } = readSignerCertificate(readFile(env.APPLE_WALLET_CERT_FILE.trim()), env.APPLE_WALLET_CERT_PASSWORD || '');
    const wwdr = readCertificate(readFile(env.APPLE_WALLET_WWDR_FILE.trim()));
    if (cert.validity.notAfter < now) warnings.push(`Apple Wallet-sertifikatet utløp ${cert.validity.notAfter.toISOString().slice(0, 10)} – kortene vil bli avvist av iPhone.`);
    return {
      passTypeId: env.APPLE_WALLET_PASS_TYPE_ID.trim(),
      teamId: env.APPLE_WALLET_TEAM_ID.trim(),
      cert,
      key,
      wwdr,
    };
  } catch (err) {
    warnings.push(`Apple Wallet er slått av: ${err.message}`);
    return null;
  }
}

/**
 * Kortsertifikatet med privatnøkkel: enten en .p12-fil (eksportert fra Nøkkelring, med passord)
 * eller en PEM-fil med både «CERTIFICATE» og «PRIVATE KEY».
 */
export function readSignerCertificate(buffer, password = '') {
  const text = buffer.toString('utf8');
  if (text.includes('-----BEGIN')) {
    const certPem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0];
    const keyPem = /-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |ENCRYPTED )?PRIVATE KEY-----/.exec(text)?.[0];
    if (!certPem || !keyPem) throw new Error('PEM-filen må inneholde både sertifikatet og privatnøkkelen.');
    const key = keyPem.includes('ENCRYPTED')
      ? forge.pki.decryptRsaPrivateKey(keyPem, password)
      : forge.pki.privateKeyFromPem(keyPem);
    if (!key) throw new Error('Kunne ikke låse opp privatnøkkelen (feil APPLE_WALLET_CERT_PASSWORD?).');
    return { cert: forge.pki.certificateFromPem(certPem), key };
  }
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary'))), password);
  } catch (err) {
    throw new Error(`Kunne ikke lese .p12-filen (feil APPLE_WALLET_CERT_PASSWORD?): ${err.message}`);
  }
  const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]?.cert;
  const key = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key
    ?? p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key;
  if (!cert || !key) throw new Error('.p12-filen må inneholde både sertifikatet og privatnøkkelen.');
  return { cert, key };
}

/** Apples mellomsertifikat (WWDR), som PEM eller som .cer (DER) slik Apple leverer det. */
export function readCertificate(buffer) {
  const text = buffer.toString('utf8');
  if (text.includes('-----BEGIN CERTIFICATE-----')) return forge.pki.certificateFromPem(text);
  return forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary'))));
}

function loadGoogle(env, readFile, warnings) {
  const missing = missingOf(env, GOOGLE_KEYS);
  if (missing.length === GOOGLE_KEYS.length) return null;
  if (missing.length) {
    warnings.push(`Google Wallet er slått av: ${missing.join(', ')} mangler.`);
    return null;
  }
  const issuerId = env.GOOGLE_WALLET_ISSUER_ID.trim();
  if (!/^\d+$/.test(issuerId)) {
    warnings.push('Google Wallet er slått av: GOOGLE_WALLET_ISSUER_ID skal være et tall (Issuer ID fra Google Pay & Wallet Console).');
    return null;
  }
  try {
    const account = JSON.parse(readFile(env.GOOGLE_WALLET_KEY_FILE.trim()).toString('utf8'));
    if (!account.client_email || !account.private_key) throw new Error('nøkkelfilen mangler client_email eller private_key.');
    return { issuerId, clientEmail: account.client_email, privateKey: createPrivateKey(account.private_key) };
  } catch (err) {
    warnings.push(`Google Wallet er slått av: ${err.message}`);
    return null;
  }
}

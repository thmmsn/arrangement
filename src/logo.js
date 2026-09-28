// Logoen til PDF-billetten, fra nettstedets LOGO_URL.
//
// PDF-en lages på serveren, så logoen må leses som en fil – nettleserens <img> hjelper ikke her:
//   /assets/custom/<fil>  → ./branding/<fil> (slik den serveres på nettstedet)
//   /assets/<sti>         → ./public/assets/<sti>
//   https://…             → hentes over nettet (maks 2 MB, 5 sekunder)
// PDF kan vise PNG, JPEG og SVG (SVG tegnes som vektorer, skarp i alle størrelser). WebP og andre
// formater kan ikke brukes i PDF-en; da står nettstedsnavnet øverst i stedet, og loggen sier hvorfor.
//
// Logoen hentes én gang per adresse og holdes i minnet – temaet endres bare ved omstart. En logo som
// ikke kunne hentes over nettet, prøves på nytt etter ti minutter.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectImageType } from './images.js';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const RETRY_MS = 10 * 60_000;

export class LogoError extends Error {}

/** 'png', 'jpeg' eller 'svg' ut fra innholdet (aldri filnavnet), ellers null. */
export function logoType(buf) {
  const image = detectImageType(buf);
  if (image === 'image/png') return 'png';
  if (image === 'image/jpeg') return 'jpeg';
  if (image) return null; // WebP
  // SVG er tekst: en valgfri XML-deklarasjon, kommentarer og doctype, og så <svg.
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head) ? 'svg' : null;
}

/**
 * @param {object} opts
 * @param {string} opts.brandingDir  ./branding
 * @param {string} opts.assetsDir    ./public/assets
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {{ warn: Function }} [opts.logger]
 * @returns {(theme: object) => Promise<{ type: 'png' | 'jpeg' | 'svg', data: Buffer } | null>}
 */
export function createLogoLoader({ brandingDir, assetsDir, fetchImpl = fetch, logger = console, now = Date.now }) {
  const cache = new Map(); // adresse → { promise, failedAt }

  // En lokal sti → filen på disken. Aldri utenfor mappen (../ o.l.).
  function localFile(url) {
    const [dir, rest] = url.startsWith('/assets/custom/') ? [brandingDir, url.slice('/assets/custom/'.length)]
      : url.startsWith('/assets/') ? [assetsDir, url.slice('/assets/'.length)]
        : [null, null];
    if (!dir) throw new LogoError('stien må starte med /assets/custom/ (mappen branding) eller /assets/');
    let decoded;
    try { decoded = decodeURIComponent(rest.split(/[?#]/)[0]); } catch { throw new LogoError('ugyldig sti'); }
    const file = path.resolve(dir, decoded);
    if (!file.startsWith(path.resolve(dir) + path.sep)) throw new LogoError('ugyldig sti');
    return file;
  }

  async function fetchRemote(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if (!res.ok) throw new LogoError(`svarte ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_LOGO_BYTES) throw new LogoError('filen er større enn 2 MB');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_LOGO_BYTES) throw new LogoError('filen er større enn 2 MB');
    return data;
  }

  async function load(url) {
    let data;
    try {
      data = /^https:\/\//i.test(url) ? await fetchRemote(url) : await readFile(localFile(url));
    } catch (err) {
      const why = err instanceof LogoError ? err.message : err.code === 'ENOENT' ? 'filen finnes ikke' : err.message;
      throw new LogoError(`LOGO_URL=${url} kan ikke brukes i PDF-billetten: ${why}.`);
    }
    if (data.length > MAX_LOGO_BYTES) throw new LogoError(`LOGO_URL=${url} kan ikke brukes i PDF-billetten: filen er større enn 2 MB.`);
    const type = logoType(data);
    if (!type) throw new LogoError(`LOGO_URL=${url} kan ikke brukes i PDF-billetten: bare PNG, JPEG og SVG kan vises i PDF.`);
    return { type, data };
  }

  return function logoFor(theme) {
    const url = theme.logoUrl;
    if (!url) return Promise.resolve(null);
    const cached = cache.get(url);
    if (cached && (cached.failedAt === null || now() - cached.failedAt < RETRY_MS)) return cached.promise;
    const entry = { failedAt: null };
    entry.promise = load(url).catch((err) => {
      entry.failedAt = now();
      logger.warn(`ADVARSEL: ${err.message} Nettstedsnavnet står øverst i stedet.`);
      return null;
    });
    cache.set(url, entry);
    return entry.promise;
  };
}

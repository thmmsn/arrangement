// Personvern og databehandleravtaler: en HTML-fil eieren skriver selv og legger i ./branding.
// Med LEGAL_FILE=personvern.html (eller SITE_<ID>_LEGAL_FILE for et ekstra nettsted) får bunnteksten
// en lenke som åpner teksten i et vindu man kan rulle i. Se docs/personvern.eksempel.html for et
// utgangspunkt.
//
// Filen leses én gang ved oppstart, som temaet: en endret fil vises etter en omstart. Den kan være
// et HTML-utsnitt (bare <h2>, <p>, <table> …) eller en hel side; da brukes det som står i <body>.
// Innholdet settes inn som det er. Det er eierens egen fil, like betrodd som .env, men sidenes
// Content-Security-Policy gjelder fortsatt: <script> og <style> i filen, style="…" og onclick="…"
// blir ikke brukt av nettleseren. Det varsles om ved oppstart.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Langt mer enn en personvernerklæring trenger. Hindrer at en feilplassert fil (f.eks. en eksport
// med innebygde bilder) gjør hver side flere megabyte større.
export const MAX_LEGAL_BYTES = 256 * 1024;

// Ting sidenes Content-Security-Policy stopper, med forklaringen som står i advarselen.
const BLOCKED = [
  [/<script\b/i, '<script> kjøres ikke'],
  [/<style\b/i, '<style> brukes ikke (bruk CUSTOM_CSS_URL for egen stil)'],
  // Bare inne i en tag, så vanlig tekst («… online = …») ikke gir en advarsel.
  [/<[a-z][^>]*\sstyle\s*=/i, 'style="…" brukes ikke (bruk CUSTOM_CSS_URL for egen stil)'],
  [/<[a-z][^>]*\son[a-z]+\s*=/i, 'onclick="…" o.l. kjøres ikke'],
];

/**
 * Leser LEGAL_FILE for hvert nettsted.
 * @param {object[]} sites  Nettstedene fra loadSites (theme.legalFile, theme.legalTitle, t)
 * @param {object} opts
 * @param {string} opts.brandingDir  ./branding
 * @param {(file: string) => string} [opts.readFile]
 * @returns {{ texts: Map<string, { title: string, html: string }>, warnings: string[] }}
 *   `texts` har bare nettstedene der filen kunne leses.
 */
export function loadLegalTexts(sites, { brandingDir, readFile = (file) => readFileSync(file, 'utf8') }) {
  const warnings = [];
  // Flere nettsteder kan dele samme fil (arv). Den leses og varsles om bare én gang.
  const files = new Map();
  const texts = new Map();
  for (const site of sites) {
    const { legalFile, legalTitle } = site.theme;
    if (!legalFile) continue;
    if (!files.has(legalFile)) files.set(legalFile, readLegalFile(legalFile, { brandingDir, readFile, warnings }));
    const html = files.get(legalFile);
    if (html === null) continue;
    texts.set(site.id, { title: legalTitle || site.t('legal.title'), html });
  }
  return { texts, warnings };
}

function readLegalFile(file, { brandingDir, readFile, warnings }) {
  const where = `branding/${file}`;
  const fail = (why) => {
    warnings.push(`LEGAL_FILE: ${where} ${why} – lenken til personvern og databehandleravtaler vises ikke.`);
    return null;
  };

  // theme.js godtar bare enkle filnavn uten «..», men stien sjekkes her også: filen skal ligge i mappen.
  const root = path.resolve(brandingDir);
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep)) return fail('ligger utenfor mappen branding');

  let source;
  try {
    source = readFile(full);
  } catch (err) {
    return fail(err.code === 'ENOENT' ? 'finnes ikke' : `kan ikke leses (${err.code || err.message})`);
  }
  if (Buffer.byteLength(source) > MAX_LEGAL_BYTES) return fail(`er for stor (maks ${MAX_LEGAL_BYTES / 1024} kB)`);

  // Kommentarer er eierens egne notater (som instruksjonene øverst i eksempelfilen) og sendes ikke med.
  const html = bodyOf(source.replace(/^\uFEFF/, '')).replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!html) return fail('er tom');

  const blocked = BLOCKED.filter(([pattern]) => pattern.test(html)).map(([, why]) => why);
  if (blocked.length) warnings.push(`LEGAL_FILE: i ${where}: ${blocked.join('; ')}.`);
  return html;
}

/** Innholdet i <body> hvis filen er en hel HTML-side, ellers hele filen. */
function bodyOf(source) {
  const match = /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(source);
  return match ? match[1] : source;
}

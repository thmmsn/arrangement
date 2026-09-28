// Skins: ferdige utseender arrangøren kan velge per arrangement («Mørk», «Glass», «Glød» …).
//
// En skin er én CSS-fil som legges oppå nettstedets tema. Den overstyrer CSS-variablene i
// style.css (--bg, --surface, --ink, --accent …) og kan legge til effekter (skygger, uskarphet).
//   - Innebygde skins ligger i public/assets/skins/.
//   - Eieren kan legge egne i ./skins (i Docker: montert til /app/skins). En egen skin med samme
//     navn som en innebygd erstatter den.
// Se docs/skins.md for hvordan man lager en.
//
// Øverst i filen står en kommentar med navn og forhåndsvisningsfarger:
//   /*
//     name: Mørk
//     name.en: Dark
//     preview: #16181d #23262d #ece8e1 #e0776b
//   */
// Filnavnet (uten .css) er id-en som lagres på arrangementet: små bokstaver, tall og bindestrek.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const FILE_PATTERN = /^([a-z0-9][a-z0-9-]{0,39})\.css$/;
const MAX_BYTES = 200_000;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i; // #rgb, #rgba, #rrggbb, #rrggbbaa

/** Leser navn og forhåndsvisningsfarger fra kommentaren øverst i filen. */
export function parseSkinMeta(css) {
  const head = /^\s*\/\*([\s\S]*?)\*\//.exec(css)?.[1] ?? '';
  const meta = { names: {}, preview: [] };
  for (const line of head.split('\n')) {
    const match = /^\s*([a-z.]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'name') meta.names.default = value.slice(0, 40);
    else if (key.startsWith('name.')) meta.names[key.slice(5)] = value.slice(0, 40);
    else if (key === 'preview') meta.preview = value.split(/\s+/).filter((c) => HEX.test(c)).slice(0, 5);
  }
  return meta;
}

/**
 * @param {object} opts
 * @param {string[]} opts.dirs  Mapper å lese fra, i rekkefølge – senere mapper overstyrer tidligere.
 * @returns {{ skins: Map<string, object>, warnings: string[] }}
 */
export function loadSkins({ dirs }) {
  const skins = new Map();
  const warnings = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.css')) continue;
      const match = FILE_PATTERN.exec(file);
      const full = path.join(dir, file);
      if (!match) {
        warnings.push(`Skin ${full} ignoreres: filnavnet kan bare ha små bokstaver, tall og bindestrek (f.eks. min-skin.css).`);
        continue;
      }
      if (statSync(full).size > MAX_BYTES) {
        warnings.push(`Skin ${full} ignoreres: filen er større enn ${MAX_BYTES / 1000} kB.`);
        continue;
      }
      const css = readFileSync(full, 'utf8');
      const id = match[1];
      const meta = parseSkinMeta(css);
      // Nettleseren laster bare stilark fra appen selv og Google Fonts (Content-Security-Policy).
      for (const [, url] of css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) {
        if (/^https?:/i.test(url) && !url.startsWith('https://fonts.googleapis.com/')) {
          warnings.push(`Skin ${full}: @import av ${url} blokkeres av nettleseren – bare Google Fonts og filer på nettstedet er tillatt.`);
        }
      }
      const hash = createHash('sha256').update(css).digest('hex').slice(0, 12);
      skins.set(id, {
        id,
        css,
        names: meta.names,
        preview: meta.preview,
        // Navnet på filen inneholder en hash av innholdet, så den kan caches for alltid.
        file: `${id}-${hash}.css`,
        href: `/assets/skins/${id}-${hash}.css`,
      });
    }
  }
  return { skins, warnings };
}

/** Navnet på skinnen på språket `lang`, ellers standardnavnet, ellers id-en. */
export function skinName(skin, lang) {
  return skin.names[lang] || skin.names.default || skin.id;
}

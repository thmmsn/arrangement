// Filnavn til nedlastinger og vedlegg: «Sommerfest på Østli!» → «sommerfest-pa-ostli».
// Bare a–z, 0–9 og bindestrek, så navnet virker i alle e-postklienter og filsystemer.
const REPLACE = { æ: 'ae', ø: 'o', å: 'a', ß: 'ss', ł: 'l', đ: 'd', þ: 'th', œ: 'oe' };

export function fileSlug(text, fallback = 'arrangement') {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[æøåßłđþœ]/g, (c) => REPLACE[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || fallback;
}

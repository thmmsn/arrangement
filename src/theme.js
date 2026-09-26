// Utseende styrt av miljøvariabler: navn, logo, fonter, farger og noen tekster.
// Alle verdier valideres før de settes inn i CSS/HTML, slik at en skrivefeil (eller noe verre) i .env
// ikke kan ødelegge siden eller brukes til å injisere CSS/HTML. Ugyldige verdier ignoreres med en advarsel.

import { escapeHtml } from './html.js';

// Standardverdiene gir det lune, reinhekla-inspirerte uttrykket.
export const DEFAULT_COLORS = {
  accent: '#8b2e2a', // knapper, lenker, overskrift-detaljer
  accentText: '#ffffff', // tekst på knapper i aksentfargen
  background: '#f5efe4', // sidebakgrunn
  surface: '#fffdf8', // kort og skjema
  text: '#2b2420',
  muted: '#6b5e53', // hjelpetekst
  border: '#e3d9c8',
  success: '#3e5a45', // «påmelding åpen», bekreftelser
  highlight: '#b8893a', // detaljer i det vevde båndet
};

// Miljøvariabel → nøkkel i DEFAULT_COLORS → CSS-variabel i style.css
const COLOR_ENV = {
  COLOR_ACCENT: ['accent', '--accent'],
  COLOR_ACCENT_TEXT: ['accentText', '--accent-ink'],
  COLOR_BACKGROUND: ['background', '--bg'],
  COLOR_SURFACE: ['surface', '--surface'],
  COLOR_TEXT: ['text', '--ink'],
  COLOR_MUTED: ['muted', '--muted'],
  COLOR_BORDER: ['border', '--line'],
  COLOR_SUCCESS: ['success', '--green'],
  COLOR_HIGHLIGHT: ['highlight', '--gold'],
};

const DEFAULT_FONTS = {
  heading: { family: 'Cormorant Garamond', spec: 'wght@500;600', fallback: "Georgia, 'Times New Roman', serif" },
  body: { family: 'Source Sans 3', spec: 'wght@400;600', fallback: "'Segoe UI', system-ui, -apple-system, sans-serif" },
};

// #rgb, #rrggbb(aa), fargenavn (red, white …) eller funksjoner som rgb(), hsl(), oklch().
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-z.,%\s/+-]{1,80}\))$/i;
// Fontnavn slik Google Fonts skriver dem, valgfritt med vekter: «Playfair Display:wght@400;700».
const FONT_PATTERN = /^([\p{L}\p{N} ]{1,60})(?::([a-z0-9@;,.]{1,60}))?$/iu;

export function loadTheme(env, { baseUrl }) {
  const warnings = [];
  const warn = (name, value, why) => warnings.push(`${name}=${JSON.stringify(value)} ignoreres: ${why}`);
  const text = (name, max = 500) => {
    const value = (env[name] || '').trim();
    if (value.length > max) {
      warn(name, value.slice(0, 30) + '…', `for lang (maks ${max} tegn)`);
      return '';
    }
    return value;
  };

  // Bilder og stilark: https-adresse, eller en sti på dette nettstedet (f.eks. /assets/custom/logo.svg).
  const url = (name) => {
    const value = (env[name] || '').trim();
    if (!value) return '';
    if (/^https:\/\/[^\s"'<>()]+$/i.test(value) || /^\/(?!\/)[^\s"'<>()]*$/.test(value)) return value;
    warn(name, value, 'må være en https://-adresse eller en sti som starter med /');
    return '';
  };

  const colors = { ...DEFAULT_COLORS };
  const cssVars = {};
  for (const [name, [key, cssVar]] of Object.entries(COLOR_ENV)) {
    const value = (env[name] || '').trim();
    if (!value) continue;
    if (!COLOR_PATTERN.test(value)) {
      warn(name, value, 'ugyldig farge (bruk f.eks. #1f4e79)');
      continue;
    }
    colors[key] = value;
    cssVars[cssVar] = value;
  }

  const font = (name, fallbackFont) => {
    const value = (env[name] || '').trim();
    if (!value) return fallbackFont;
    const match = FONT_PATTERN.exec(value);
    if (!match) {
      warn(name, value, 'ugyldig fontnavn (bruk navnet fra Google Fonts, f.eks. «Playfair Display»)');
      return fallbackFont;
    }
    return { family: match[1].trim(), spec: match[2] || '', fallback: fallbackFont.fallback };
  };

  const number = (name, min, max) => {
    const value = (env[name] || '').trim();
    if (!value) return null;
    const n = Number(value);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    warn(name, value, `må være et tall fra ${min} til ${max}`);
    return null;
  };

  const flag = (name, fallback) => {
    const value = (env[name] || '').trim().toLowerCase();
    if (!value) return fallback;
    if (['true', '1', 'ja', 'yes', 'on'].includes(value)) return true;
    if (['false', '0', 'nei', 'no', 'off'].includes(value)) return false;
    warn(name, value, 'må være true eller false');
    return fallback;
  };

  const logoUrl = url('LOGO_URL');
  const theme = {
    siteName: text('SITE_NAME', 100),
    logoUrl,
    // E-postklienter trenger full adresse til logoen.
    logoAbsoluteUrl: logoUrl.startsWith('/') ? `${baseUrl}${logoUrl}` : logoUrl,
    logoHeight: number('LOGO_HEIGHT', 16, 200) ?? 44,
    faviconUrl: url('FAVICON_URL'),
    customCssUrl: url('CUSTOM_CSS_URL'),
    colors,
    cssVars,
    fonts: { heading: font('FONT_HEADING', DEFAULT_FONTS.heading), body: font('FONT_BODY', DEFAULT_FONTS.body) },
    // Google Fonts kan slås av av personvernhensyn; da brukes fontene bare hvis de finnes på maskinen.
    googleFonts: flag('GOOGLE_FONTS', true),
    radius: number('RADIUS', 0, 40),
    showBand: flag('SHOW_BAND', true),
    homeTitle: text('HOME_TITLE', 200) || 'Velkommen',
    homeText: text('HOME_TEXT', 2000)
      || 'Arrangementene her har ingen offentlig oversikt – de kan bare nås via lenken du har fått fra arrangøren.',
    footerText: text('FOOTER_TEXT', 300),
    privacyUrl: url('PRIVACY_URL'),
  };
  return { theme, warnings };
}

/** Adressen til Google Fonts-stilarket for fontene i temaet. */
export function googleFontsUrl(theme) {
  const families = [...new Map(
    [theme.fonts.heading, theme.fonts.body].map((f) => [`${f.family}:${f.spec}`, f]),
  ).values()];
  const query = families
    .map((f) => `family=${encodeURIComponent(f.family).replaceAll('%20', '+')}${f.spec ? `:${f.spec}` : ''}`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

/** /theme.css: overstyrer CSS-variablene i style.css med verdiene fra .env. */
export function themeCss(theme) {
  const vars = {
    ...theme.cssVars,
    '--serif': `'${theme.fonts.heading.family}', ${theme.fonts.heading.fallback}`,
    '--sans': `'${theme.fonts.body.family}', ${theme.fonts.body.fallback}`,
    '--logo-height': `${theme.logoHeight}px`,
    ...(theme.radius !== null && { '--radius': `${theme.radius}px` }),
  };
  return [
    '/* Generert fra miljøvariablene (COLOR_*, FONT_*, RADIUS …). Se .env.example. */',
    theme.googleFonts ? `@import url("${googleFontsUrl(theme)}");` : '',
    `:root {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`,
    theme.showBand ? '' : '.band { display: none; }',
  ].filter(Boolean).join('\n') + '\n';
}

// ---------- Deler som flettes inn i HTML-sidene ----------

export function themeHead(theme) {
  return [
    theme.googleFonts ? '<link rel="preconnect" href="https://fonts.googleapis.com">' : '',
    theme.googleFonts ? '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' : '',
    '<link rel="stylesheet" href="/assets/css/style.css">',
    '<link rel="stylesheet" href="/theme.css">',
    theme.customCssUrl ? `<link rel="stylesheet" href="${escapeHtml(theme.customCssUrl)}">` : '',
    theme.faviconUrl ? `<link rel="icon" href="${escapeHtml(theme.faviconUrl)}">` : '',
  ].filter(Boolean).join('\n  ');
}

export function siteHeader(theme, { wide = false } = {}) {
  const band = '<div class="band" aria-hidden="true"></div>';
  // Logo hvis den er satt, ellers nettstedsnavnet, ellers ingen topplinje (bare båndet).
  const brand = theme.logoUrl
    ? `<img src="${escapeHtml(theme.logoUrl)}" alt="${escapeHtml(theme.siteName || 'Logo')}">`
    : theme.siteName ? `<span>${escapeHtml(theme.siteName)}</span>` : '';
  if (!brand) return band;
  return `${band}
  <header class="site-header">
    <div class="container${wide ? ' wide' : ''}"><a class="brand" href="/">${brand}</a></div>
  </header>`;
}

export function siteFooter(theme) {
  const text = theme.footerText || theme.siteName;
  const privacy = theme.privacyUrl
    ? `<a href="${escapeHtml(theme.privacyUrl)}" target="_blank" rel="noopener">Personvern</a>` : '';
  if (!text && !privacy) return '';
  return `<footer class="site-footer">
    <div class="container">${[text ? escapeHtml(text) : '', privacy].filter(Boolean).join(' · ')}</div>
  </footer>`;
}

/** Ekstra kilder Content-Security-Policy må tillate for temaet. */
export function themeCspSources(theme) {
  const styles = ["'self'"];
  const fonts = [];
  if (theme.googleFonts) {
    styles.push('https://fonts.googleapis.com');
    fonts.push('https://fonts.gstatic.com');
  }
  if (/^https:\/\//i.test(theme.customCssUrl)) styles.push(new URL(theme.customCssUrl).origin);
  return { styles, fonts: fonts.length ? fonts : ["'self'"] };
}

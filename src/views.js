import { readFileSync } from 'node:fs';
import path from 'node:path';
import { escapeHtml } from './html.js';
import { siteFooter, siteHeader, themeHead } from './theme.js';

// HTML-sidene i views/ er statiske maler med noen få plassholdere som fylles med temaet:
//   <!--THEME-HEAD-->                   stilark, fonter og favicon
//   <!--SITE-HEADER--> / <!--SITE-HEADER wide-->   båndet og logo/navn øverst
//   <!--SITE-FOOTER-->                  bunntekst og personvernlenke
//   {{SITE_NAME}}, {{HOME_TITLE}}, {{HOME_TEXT}}   tekster (HTML-escapet)
// Temaet endres bare ved omstart, så hver side lages én gang og holdes i minnet.
export function createViews(dir, theme) {
  const cache = new Map();

  function render(html) {
    const texts = { SITE_NAME: theme.siteName || 'Påmelding', HOME_TITLE: theme.homeTitle, HOME_TEXT: theme.homeText };
    return html
      .replace('<!--THEME-HEAD-->', themeHead(theme))
      .replace(/<!--SITE-HEADER( wide)?-->/, (_, wide) => siteHeader(theme, { wide: Boolean(wide) }))
      .replace('<!--SITE-FOOTER-->', siteFooter(theme))
      .replace(/\{\{(SITE_NAME|HOME_TITLE|HOME_TEXT)\}\}/g, (_, key) => escapeHtml(texts[key]));
  }

  return function page(name) {
    if (!cache.has(name)) cache.set(name, render(readFileSync(path.join(dir, `${name}.html`), 'utf8')));
    return cache.get(name);
  };
}

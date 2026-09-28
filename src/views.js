import { readFileSync } from 'node:fs';
import path from 'node:path';
import { escapeHtml } from './html.js';
import { siteFooter, siteHeader, themeHead } from './theme.js';

// HTML-sidene i views/ er statiske maler med plassholdere som fylles per nettsted:
//   {{LANG}}                            språkkoden til <html lang="…">
//   {{SITE_NAME}}                       nettstedets navn (eller ordbokens standardnavn)
//   {{t:nøkkel}}                        tekst fra ordboken, HTML-escapet (f.eks. {{t:event.loading}})
//   <!--THEME-HEAD-->                   stilark, fonter, favicon og arrangementets skin
//   <!--SITE-HEADER--> / <!--SITE-HEADER wide-->   båndet og logo/navn øverst
//   <!--SITE-FOOTER-->                  bunntekst og personvernlenke
// Temaet endres bare ved omstart, så hver side lages én gang per nettsted og holdes i minnet.
export function createViews(dir) {
  const templates = new Map();
  const rendered = new Map();

  function template(name) {
    if (!templates.has(name)) templates.set(name, readFileSync(path.join(dir, `${name}.html`), 'utf8'));
    return templates.get(name);
  }

  function render(html, site) {
    const { theme, t } = site;
    return html
      .replace('<!--THEME-HEAD-->', themeHead(theme, { cssHref: site.cssHref, skinHref: site.skinHref }))
      .replace(/<!--SITE-HEADER( wide)?-->/, (_, wide) => siteHeader(theme, { wide: Boolean(wide), t }))
      .replace('<!--SITE-FOOTER-->', siteFooter(theme, { t }))
      .replaceAll('{{LANG}}', escapeHtml(site.lang))
      .replaceAll('{{SITE_NAME}}', escapeHtml(theme.siteName || t('meta.siteNameFallback')))
      .replace(/\{\{t:([\w.]+)\}\}/g, (_, key) => escapeHtml(t(key)));
  }

  /** Siden `name` med nettstedets språk og tema, og eventuelt arrangementets skin. */
  return function page(name, site) {
    const key = `${site.id}:${name}:${site.skinHref || ''}`;
    if (!rendered.has(key)) rendered.set(key, render(template(name), site));
    return rendered.get(key);
  };
}

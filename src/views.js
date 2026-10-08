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
//   <!--SITE-FOOTER-->                  bunntekst, personvernlenke, vinduet med personvern og
//                                       databehandleravtaler (LEGAL_FILE) og versjonsnummeret
//   <!--PAGE-META-->                    <meta>-tagger for akkurat denne siden (f.eks. delingstagger
//                                       for et arrangement), ferdig escapet av den som lager dem
//   {{VERSION}}                         appens versjonsnummer, i skriptadressene (…/admin.js?v={{VERSION}}):
//                                       en ny versjon gir ny adresse, så nettleseren aldri kjører et
//                                       gammelt skript fra hurtigbufferen (/assets caches i én time)
// Temaet endres bare ved omstart, så hver side lages én gang per nettsted og holdes i minnet.
// <!--PAGE-META--> er forskjellig for hver forespørsel og settes derfor inn etter mellomlagringen.
// `version`: appens versjonsnummer (se version.js), vist nederst til høyre på alle sidene.
// `legal`: nettsteds-ID → { title, html } fra LEGAL_FILE (se legal.js). Nettsteder uten får ingen lenke.
export function createViews(dir, { version = null, legal = new Map() } = {}) {
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
      .replaceAll('{{LANG}}', escapeHtml(site.lang))
      .replaceAll('{{VERSION}}', escapeHtml(version ?? ''))
      .replaceAll('{{SITE_NAME}}', escapeHtml(theme.siteName || t('meta.siteNameFallback')))
      .replace(/\{\{t:([\w.]+)\}\}/g, (_, key) => escapeHtml(t(key)))
      // Til slutt, og med en funksjon som erstatning: bunnteksten kan inneholde eierens egen HTML
      // (LEGAL_FILE), og der skal verken {{…}} byttes ut eller «$&», «$'» o.l. tolkes.
      .replace('<!--SITE-FOOTER-->', () => siteFooter(theme, { t, version, legal: legal.get(site.id) ?? null }));
  }

  /** Siden `name` med nettstedets språk og tema, og eventuelt arrangementets skin og `meta`. */
  return function page(name, site, { meta = '' } = {}) {
    const key = `${site.id}:${name}:${site.skinHref || ''}`;
    if (!rendered.has(key)) rendered.set(key, render(template(name), site));
    // Funksjon som erstatning: ellers ville «$&», «$'» o.l. i en arrangementstittel blitt tolket.
    return rendered.get(key).replace('<!--PAGE-META-->', () => meta);
  };
}

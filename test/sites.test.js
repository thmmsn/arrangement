import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { loadSites, SiteConfigError } from '../src/sites.js';
import { createEvent, startApp } from './helpers.js';

// To nettsteder på samme app og database: et norsk hovednettsted og et engelsk ekstra nettsted.
const MAIN = 'arrangement.example.no';
const COM = 'events.example.com';
const ADMIN = 'arrangement-admin.example.no';
const TWO_SITES = {
  ADMIN_NO_AUTH: 'true',
  DOMAIN: MAIN,
  SITE_NAME: 'Eksempel',
  LOGO_URL: '/assets/custom/logo.svg',
  FOOTER_TEXT: 'Norsk bunntekst',
  EMAIL_FROM: 'Påmelding <pamelding@example.no>',
  SITE_COM_DOMAIN: COM,
  SITE_COM_LANG: 'en',
  SITE_COM_SITE_NAME: 'Example Events',
  SITE_COM_LOGO_URL: '/assets/custom/logo-en.svg',
  SITE_COM_EMAIL_FROM: 'Registration <registration@example.com>',
};

const onHost = (host) => ({ host });

describe('nettsteder fra miljøvariabler', () => {
  test('dagens oppsett uten prefiks gir ett norsk hovednettsted, uendret', () => {
    const { sites, mainSite, warnings } = loadSites({ DOMAIN: MAIN, SITE_NAME: 'Eksempel', EMAIL_FROM: 'A <a@example.no>' });
    assert.deepEqual(warnings, []);
    assert.equal(sites.length, 1);
    assert.equal(mainSite.id, 'main');
    assert.equal(mainSite.host, MAIN);
    assert.equal(mainSite.baseUrl, `https://${MAIN}`);
    assert.equal(mainSite.lang, 'nb');
    assert.equal(mainSite.emailFrom, 'A <a@example.no>');
  });

  test('eldre oppsett med bare BASE_URL gjenkjennes på vertsnavnet i BASE_URL', () => {
    const { mainSite } = loadSites({ BASE_URL: `https://${MAIN}/` });
    assert.equal(mainSite.host, MAIN);
    assert.equal(mainSite.baseUrl, `https://${MAIN}`);
  });

  test('Linux-variabelen LANG påvirker ikke språket – hovednettstedet bruker SITE_LANG', () => {
    assert.equal(loadSites({ DOMAIN: MAIN, LANG: 'en_US.UTF-8' }).mainSite.lang, 'nb');
    assert.equal(loadSites({ DOMAIN: MAIN, SITE_LANG: 'en' }).mainSite.lang, 'en');
  });

  test('ekstra nettsted med prefiks: eget språk, navn, logo og avsender – resten arves', () => {
    const { sites, warnings } = loadSites({ ...TWO_SITES, COLOR_ACCENT: '#123456' });
    assert.deepEqual(warnings, []);
    const com = sites.find((s) => s.id === 'com');
    assert.equal(com.host, COM);
    assert.equal(com.baseUrl, `https://${COM}`);
    assert.equal(com.lang, 'en');
    assert.equal(com.emailFrom, 'Registration <registration@example.com>');
    assert.equal(com.theme.siteName, 'Example Events');
    assert.equal(com.theme.logoUrl, '/assets/custom/logo-en.svg');
    assert.equal(com.theme.logoAbsoluteUrl, `https://${COM}/assets/custom/logo-en.svg`);
    // Arvet fra hovednettstedet:
    assert.equal(com.theme.colors.accent, '#123456');
    // Norsk bunntekst arves ikke til et engelsk nettsted.
    assert.equal(com.theme.footerText, '');
  });

  test('et nettsted på samme språk arver også teksten', () => {
    const { sites } = loadSites({ DOMAIN: MAIN, FOOTER_TEXT: 'Felles', EMAIL_FROM: 'A <a@example.no>', SITE_TO_DOMAIN: 'to.example.no' });
    const to = sites.find((s) => s.id === 'to');
    assert.equal(to.lang, 'nb');
    assert.equal(to.theme.footerText, 'Felles');
  });

  test('avsenderen følger domenet: første ledd blir adressen, resten e-postdomenet', () => {
    const env = {
      DOMAIN: 'event.thommesenarchitecture.com', SITE_NAME: 'Thommesen Arkitekter',
      SITE_NO_DOMAIN: 'arrangement.arkitekt-thommesen.no',
    };
    const from = (e) => Object.fromEntries(loadSites(e).sites.map((site) => [site.id, site.emailFrom]));
    assert.deepEqual(from(env), {
      main: 'Thommesen Arkitekter <event@thommesenarchitecture.com>',
      no: 'Thommesen Arkitekter <arrangement@arkitekt-thommesen.no>',
    });
    // EMAIL_FROM overstyrer bare hovednettstedet – det nye domenet får fortsatt sin egen avsender.
    assert.deepEqual(from({ ...env, EMAIL_FROM: 'Thommesen Arkitekter <arrangement@thommesenarchitecture.com>' }), {
      main: 'Thommesen Arkitekter <arrangement@thommesenarchitecture.com>',
      no: 'Thommesen Arkitekter <arrangement@arkitekt-thommesen.no>',
    });
    // SITE_<ID>_EMAIL_FROM overstyrer nettstedet, og nettstedets eget SITE_NAME blir navnet.
    assert.equal(from({ ...env, SITE_NO_EMAIL_FROM: 'Påmelding <post@arkitekt-thommesen.no>' }).no, 'Påmelding <post@arkitekt-thommesen.no>');
    assert.equal(from({ ...env, SITE_NO_SITE_NAME: 'Thommesen' }).no, 'Thommesen <arrangement@arkitekt-thommesen.no>');
    // Bare to ledd: ingenting å ta av. Tegn som komma gjør at navnet må stå i anførselstegn.
    assert.equal(from({ DOMAIN: 'arkitekt-thommesen.no', SITE_NAME: 'Thommesen, Arkitekter' }).main, '"Thommesen, Arkitekter" <arrangement@arkitekt-thommesen.no>');
    // Uten SITE_NAME: standardnavnet på nettstedets språk, som på sidene.
    assert.equal(from({ DOMAIN: 'arkitekt-thommesen.no' }).main, 'Påmelding <arrangement@arkitekt-thommesen.no>');
    assert.equal(from({ DOMAIN: 'arrangement.example.no', SITE_EN_DOMAIN: 'events.example.com', SITE_EN_LANG: 'en' }).en, 'Registration <events@example.com>');
    // Uten domene (lokal utvikling): standardavsenderen som før.
    assert.equal(from({}).main, 'Påmelding <arrangement@example.com>');
  });

  test('en avsender på et annet domene enn nettstedet gir en advarsel', () => {
    const { warnings } = loadSites({
      DOMAIN: 'event.thommesenarchitecture.com', EMAIL_FROM: 'A <arrangement@thommesenarchitecture.com>',
      SITE_NO_DOMAIN: 'arrangement.arkitekt-thommesen.no', SITE_NO_EMAIL_FROM: 'A <arrangement@thommesenarchitecture.com>',
    });
    assert.deepEqual(warnings, [
      'SITE_NO_EMAIL_FROM: avsenderen A <arrangement@thommesenarchitecture.com> er ikke på nettstedets domene (arrangement.arkitekt-thommesen.no). E-post om arrangementene der kommer fra thommesenarchitecture.com.',
    ]);
  });

  test('feil i oppsettet gir tydelige advarsler eller stopper oppstarten', () => {
    const { warnings } = loadSites({ DOMAIN: MAIN, SITE_COM_DOMAIN: COM, SITE_COM_LANG: 'fr', SITE_COM_COLOUR: 'x', SITE_XX_LANG: 'en' });
    assert.ok(warnings.some((w) => w.startsWith('SITE_COM_LANG="fr" ignoreres')), warnings.join('\n'));
    assert.ok(warnings.some((w) => w.startsWith('SITE_COM_COLOUR ignoreres')), warnings.join('\n'));
    assert.ok(warnings.some((w) => w.includes('SITE_XX_DOMAIN mangler')), warnings.join('\n'));

    assert.throws(() => loadSites({ DOMAIN: MAIN, SITE_COM_DOMAIN: MAIN }), SiteConfigError, 'samme domene to ganger');
    assert.throws(() => loadSites({ SITE_COM_DOMAIN: COM, SITE_COM_BASE_URL: 'https://annet.example.com' }), /må peke på/);
    assert.throws(() => loadSites({ SITE_MAIN_DOMAIN: COM }), /reservert/);
  });
});

describe('valg av nettsted ut fra Host', () => {
  test('hvert domene viser sine egne arrangementer med eget språk og tema', async () => {
    const app = await startApp({ ...TWO_SITES, SITE_COM_COLOR_ACCENT: '#1f4e79' });
    const no = await createEvent(app);
    const en = await createEvent(app, { site: 'com', title: 'English event' });

    const noPage = await app.request({ path: `/${no.slug}`, headers: onHost(MAIN) });
    assert.equal(noPage.status, 200);
    assert.match(noPage.text, /<html lang="nb">/);
    assert.match(noPage.text, /<title>Eksempel<\/title>/);
    assert.match(noPage.text, /Laster arrangementet …/);
    assert.match(noPage.text, /Norsk bunntekst/);

    const enPage = await app.request({ path: `/${en.slug}`, headers: onHost(COM) });
    assert.equal(enPage.status, 200);
    assert.match(enPage.text, /<html lang="en">/);
    assert.match(enPage.text, /<title>Example Events<\/title>/);
    assert.match(enPage.text, /Loading the event …/);
    assert.match(enPage.text, /logo-en\.svg/);
    assert.doesNotMatch(enPage.text, /Norsk bunntekst|Laster/);

    // Hvert nettsted har sitt eget temastilark (like temaer deler fil, siden navnet er en hash av innholdet).
    const cssOf = (html) => /href="(\/assets\/theme\/[0-9a-f]+\.css)"/.exec(html)[1];
    assert.notEqual(cssOf(noPage.text), cssOf(enPage.text));
    const enCss = await app.request({ path: cssOf(enPage.text), headers: onHost(COM) });
    assert.match(enCss.text, /--accent: #1f4e79;/);
    const noCss = await app.request({ path: cssOf(noPage.text), headers: onHost(MAIN) });
    assert.doesNotMatch(noCss.text, /--accent:/);
  });

  test('et ukjent vertsnavn får hovednettstedet', async () => {
    const app = await startApp(TWO_SITES);
    const no = await createEvent(app);
    const page = await app.request({ path: `/${no.slug}`, headers: onHost('ukjent.example.org') });
    assert.equal(page.status, 200);
    assert.match(page.text, /<html lang="nb">/);
  });

  test('X-Forwarded-Host kan ikke velge nettsted – bare Host teller', async () => {
    const app = await startApp({ ...TWO_SITES, TRUST_PROXY: 'true' });
    const en = await createEvent(app, { site: 'com' });
    const res = await app.request({ path: `/${en.slug}`, headers: { host: MAIN, 'x-forwarded-host': COM } });
    assert.equal(res.status, 301, 'behandles som hovednettstedet og sendes videre');
    assert.equal(res.headers.location, `https://${COM}/${en.slug}`);
  });
});

describe('301 til riktig domene', () => {
  test('arrangementet og avmeldingssiden sendes til arrangementets domene, med samme sti', async () => {
    const app = await startApp(TWO_SITES);
    const en = await createEvent(app, { site: 'com' });
    const no = await createEvent(app);

    const wrong = await app.request({ path: `/${en.slug}`, headers: onHost(MAIN) });
    assert.equal(wrong.status, 301);
    assert.equal(wrong.headers.location, `https://${COM}/${en.slug}`);

    // Avmeldingslenker som allerede er sendt ut, virker uendret – også på feil domene.
    const cancel = await app.request({ path: `/${en.slug}/avmelding`, headers: onHost(MAIN) });
    assert.equal(cancel.status, 301);
    assert.equal(cancel.headers.location, `https://${COM}/${en.slug}/avmelding`);
    const cancelRight = await app.request({ path: `/${en.slug}/avmelding`, headers: onHost(COM) });
    assert.equal(cancelRight.status, 200);
    assert.match(cancelRight.text, /<html lang="en">/);

    const other = await app.request({ path: `/${no.slug}?kilde=plakat`, headers: onHost(COM) });
    assert.equal(other.status, 301);
    assert.equal(other.headers.location, `https://${MAIN}/${no.slug}?kilde=plakat`);
  });

  test('når nettstedet endres ved redigering, flytter arrangementet til det nye domenet', async () => {
    const app = await startApp(TWO_SITES);
    const { slug, adminKey } = await createEvent(app);
    const auth = { authorization: `Bearer ${adminKey}` };
    const get = await app.request({ path: `/api/admin/events/${slug}`, headers: auth });
    assert.equal(get.json.event.site, 'main');

    const put = await app.request({ method: 'PUT', path: `/api/admin/events/${slug}`, headers: auth, body: { ...get.json.event, site: 'com' } });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.event.site, 'com');
    assert.equal(put.json.event.url, `https://${COM}/${slug}`);

    const old = await app.request({ path: `/${slug}`, headers: onHost(MAIN) });
    assert.equal(old.status, 301);
    assert.equal(old.headers.location, `https://${COM}/${slug}`);
  });

  test('ukjent nettsted i skjemaet avvises (på admin-språket)', async () => {
    const app = await startApp(TWO_SITES);
    const res = await app.request({
      method: 'POST', path: '/api/admin/events',
      body: { title: 'X', startsAt: '2030-01-01T10:00:00Z', organizerName: 'A', organizerEmail: 'a@example.com', site: 'finnes-ikke' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.errors.site, 'Ukjent nettsted');
  });

  test('admin-oppsettet lister nettstedene, hovednettstedet først', async () => {
    const app = await startApp(TWO_SITES);
    const res = await app.request({ path: '/api/admin/config' });
    assert.deepEqual(res.json.sites.map((s) => [s.id, s.lang, s.baseUrl]), [
      ['main', 'nb', `https://${MAIN}`],
      ['com', 'en', `https://${COM}`],
    ]);
  });
});

describe('e-postlenker per nettsted', () => {
  async function register(app, slug, host, body) {
    return app.request({
      method: 'POST', path: `/api/events/${slug}/registrations`, headers: onHost(host),
      body: { name: 'Ola Nordmann', email: 'ola@example.com', ...body },
    });
  }

  test('lenker, logo og avsender i e-postene kommer fra arrangementets nettsted', async () => {
    const app = await startApp(TWO_SITES);
    const en = await createEvent(app, { site: 'com', title: 'English event' });

    // Arrangøren får admin-lenken: uten ADMIN_HOST på arrangementets eget domene.
    const created = app.sent.find((m) => m.subject.startsWith('Your event has been created'));
    assert.ok(created, app.sent.map((m) => m.subject).join('\n'));
    assert.equal(created.from, 'Registration <registration@example.com>');
    assert.match(created.text, new RegExp(`https://${COM}/${en.slug}\\n`));
    assert.match(created.text, new RegExp(`https://${COM}/admin/${en.slug}#${en.adminKey}`));
    assert.equal(en.eventUrl, `https://${COM}/${en.slug}`);
    app.sent.length = 0;

    const res = await register(app, en.slug, COM);
    assert.equal(res.status, 201, res.text);
    const guest = app.sent.find((m) => m.to === 'ola@example.com');
    const organizer = app.sent.find((m) => m.to === 'arrangor@example.com');
    for (const message of [guest, organizer]) {
      assert.equal(message.from, 'Registration <registration@example.com>');
      assert.doesNotMatch(message.text + message.html, new RegExp(MAIN.replaceAll('.', '\\.')));
    }
    assert.match(guest.text, new RegExp(`View the event: https://${COM}/${en.slug}\\n`));
    assert.match(guest.text, new RegExp(`https://${COM}/${en.slug}/avmelding#[\\w-]+`));
    assert.match(guest.html, new RegExp(`<img src="https://${COM}/assets/custom/logo-en\\.svg" alt="Example Events"`));
  });

  test('hovednettstedets arrangementer bruker hovednettstedets domene og avsender', async () => {
    const app = await startApp(TWO_SITES);
    const no = await createEvent(app);
    app.sent.length = 0;
    await register(app, no.slug, MAIN);
    const guest = app.sent.find((m) => m.to === 'ola@example.com');
    assert.equal(guest.from, 'Påmelding <pamelding@example.no>');
    assert.match(guest.subject, /^Påmelding bekreftet:/);
    assert.match(guest.text, new RegExp(`https://${MAIN}/${no.slug}/avmelding#`));
    assert.match(guest.html, new RegExp(`<img src="https://${MAIN}/assets/custom/logo\\.svg"`));
  });

  test('med ADMIN_HOST følger også admin-lenken arrangementets nettsted – ADMIN_HOST gjelder bare oppretting', async () => {
    const app = await startApp({ ...TWO_SITES, ADMIN_HOST: ADMIN });
    const en = await createEvent(app, { site: 'com' }, onHost(ADMIN));
    assert.equal(en.adminUrl, `https://${COM}/admin/${en.slug}#${en.adminKey}`);
    assert.equal(en.eventUrl, `https://${COM}/${en.slug}`);
    assert.match(en.scannerUrl, new RegExp(`^https://${COM}/dorvakt/${en.slug}#`));
  });
});

describe('engelsk tekst i en påmelding', () => {
  test('feilmeldinger, status og e-poster er på engelsk for et engelsk nettsted', async () => {
    const app = await startApp(TWO_SITES);
    const en = await createEvent(app, {
      site: 'com',
      title: 'Autumn evening',
      location: 'The farm',
      startsAt: '2030-10-26T16:00:00.000Z',
      endsAt: '2030-10-26T19:00:00.000Z',
      fields: [{ label: 'Dietary requirements', type: 'text' }, { label: 'Photo consent', type: 'checkbox', required: true }],
    });
    const { json: event } = await app.request({ path: `/api/events/${en.slug}`, headers: onHost(COM) });
    const [diet, consent] = event.fields;

    // Valideringsfeil på engelsk
    const invalid = await app.request({
      method: 'POST', path: `/api/events/${en.slug}/registrations`, headers: onHost(COM),
      body: { name: '', email: 'nope', answers: {}, guests: [{ name: '' }] },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, 'Some fields are not filled in correctly');
    assert.deepEqual(invalid.json.errors, {
      name: 'Name is required',
      email: 'Enter a valid email address',
      [`field_${consent.id}`]: 'You must tick this box',
      'guests.0.name': 'Name is required',
      [`guests.0.field_${consent.id}`]: 'You must tick this box',
    });

    // En gyldig påmelding for to personer gir engelske e-poster med engelske datoer
    app.sent.length = 0;
    const ok = await app.request({
      method: 'POST', path: `/api/events/${en.slug}/registrations`, headers: onHost(COM),
      body: {
        name: 'Ola Nordmann', email: 'ola@example.com', answers: { [diet.id]: 'Vegetarian', [consent.id]: true },
        guests: [{ name: 'Kari', answers: { [consent.id]: true } }],
      },
    });
    assert.equal(ok.status, 201, ok.text);
    const guest = app.sent.find((m) => m.to === 'ola@example.com');
    assert.equal(guest.subject, 'Registration confirmed: Autumn evening');
    assert.match(guest.text, /^Hi Ola Nordmann!/);
    assert.match(guest.text, /You have signed up 2 people: Ola Nordmann and Kari\./);
    assert.match(guest.text, /When: Saturday, 26 October 2030 at 18:00–21:00/);
    assert.match(guest.text, /Where: The farm/);
    assert.match(guest.text, /Person 2\nName: Kari\nPhoto consent: Yes/);
    assert.match(guest.text, /Can some of you not make it after all\? Cancel here – you choose who: https:/);
    assert.match(guest.html, /<html lang="en">/);
    const organizer = app.sent.find((m) => m.to === 'arrangor@example.com');
    assert.equal(organizer.subject, 'New registration: Ola Nordmann +1 – Autumn evening');
    assert.match(organizer.text, /Status: 2 attendees\./);

    // Status på engelsk når påmeldingen er stengt
    const auth = { authorization: `Bearer ${en.adminKey}` };
    const { json: admin } = await app.request({ path: `/api/admin/events/${en.slug}`, headers: auth });
    await app.request({ method: 'PUT', path: `/api/admin/events/${en.slug}`, headers: auth, body: { ...admin.event, isOpen: false } });
    const closed = await app.request({
      method: 'POST', path: `/api/events/${en.slug}/registrations`, headers: onHost(COM), body: { name: 'A', email: 'a@example.com' },
    });
    assert.equal(closed.status, 409);
    assert.equal(closed.json.error, 'Registration is closed.');
  });

  test('avmelding på engelsk', async () => {
    const app = await startApp(TWO_SITES);
    const en = await createEvent(app, { site: 'com', title: 'Autumn evening' });
    app.sent.length = 0;
    await app.request({
      method: 'POST', path: `/api/events/${en.slug}/registrations`, headers: onHost(COM),
      body: { name: 'Ola', email: 'ola@example.com', guests: [{ name: 'Kari' }] },
    });
    // Lenken for hele påmeldingen står nederst; lenkene over gjelder hver sin person.
    const token = [...app.sent.find((m) => m.to === 'ola@example.com').text.matchAll(/avmelding#([\w-]+)/g)].at(-1)[1];
    app.sent.length = 0;

    const missing = await app.request({ method: 'POST', path: `/api/events/${en.slug}/cancel`, headers: onHost(COM), body: { token: 'feil' } });
    assert.equal(missing.json.error, 'No registration was found for this link. Perhaps it has already been cancelled?');

    const { json: lookup } = await app.request({ method: 'POST', path: `/api/events/${en.slug}/cancel/lookup`, headers: onHost(COM), body: { token } });
    const kari = lookup.persons.find((p) => p.name === 'Kari');
    await app.request({ method: 'POST', path: `/api/events/${en.slug}/cancel`, headers: onHost(COM), body: { token, ids: [kari.id] } });
    const guest = app.sent.find((m) => m.to === 'ola@example.com');
    assert.equal(guest.subject, 'Cancelled: Autumn evening');
    assert.match(guest.text, /Kari have now been cancelled\. Thank you for letting us know\./);
    assert.match(guest.text, /Still registered: Ola\./);
  });

  test('admin-sidene er på hovednettstedets språk, også på et annet domene', async () => {
    const app = await startApp(TWO_SITES);
    const en = await createEvent(app, { site: 'com' });
    const page = await app.request({ path: `/admin/${en.slug}`, headers: onHost(COM) });
    assert.equal(page.status, 200);
    assert.match(page.text, /<html lang="nb">/);
    assert.match(page.text, /Administrer arrangement/);
    const csv = await app.request({ path: `/api/admin/events/${en.slug}/registrations.csv`, headers: { authorization: `Bearer ${en.adminKey}` } });
    assert.match(csv.text, /Påmeldt;Navn;E-post/);
    assert.match(csv.headers['content-disposition'], /pameldte-/);
  });
});

describe('et offentlig domene er helt lukket uten gyldig lenke', () => {
  test('forsiden, ukjente adresser og ukjente lenker gir samme nakne 404', async () => {
    const app = await startApp({ ...TWO_SITES, ADMIN_HOST: ADMIN });
    const probes = [
      { path: '/' },
      { path: '/index.html' },
      { path: '/ny' },
      { path: '/admin' },
      { path: '/admin/ny' },
      { path: '/abcdefghjkmn' },
      { path: '/abcdefghjkmn/avmelding' },
      { path: '/abcdefghjkmn/admin' },
      { path: '/abcdefghjkmn/skanner' },
      { path: '/admin/abcdefghjkmn' },
      { path: '/admin/abcdefghjkmn/avlys' },
      { path: '/dorvakt' },
      { path: '/dorvakt/abcdefghjkmn' },
      { path: '/api/admin/events/abcdefghjkmn' },
      { path: '/api/admin/events/abcdefghjkmn/config' },
      { path: '/api/admin/places?q=Oslo' },
      { path: '/theme.css' },
      { path: '/assets/theme/0000000000.css' },
      { path: '/api/events/abcdefghjkmn' },
      { path: '/api/admin/config' },
      { path: '/api/finnes-ikke' },
      { method: 'POST', path: '/api/events/abcdefghjkmn/registrations', body: { name: 'x', email: 'x@example.com' } },
      { method: 'POST', path: '/api/events/abcdefghjkmn/cancel', body: { token: 'x' } },
    ];
    // Ugyldig JSON tolkes før arrangementet slås opp – skal likevel ikke gi en JSON-feil.
    const invalidJson = await app.request({ method: 'POST', path: '/api/events/abcdefghjkmn/registrations', raw: '{ugyldig', headers: onHost(COM) });
    assert.equal(invalidJson.status, 404);
    assert.equal(invalidJson.text, 'Not Found');
    // For et arrangement som finnes, får man fortsatt en nyttig feilmelding – på nettstedets språk.
    const en = await createEvent(app, { site: 'com' }, onHost(ADMIN));
    const known = await app.request({ method: 'POST', path: `/api/events/${en.slug}/registrations`, raw: '{ugyldig', headers: onHost(COM) });
    assert.equal(known.status, 400);
    assert.equal(known.json.error, 'Invalid JSON.');
    for (const host of [MAIN, COM]) {
      for (const probe of probes) {
        const res = await app.request({ ...probe, headers: onHost(host) });
        const label = `${probe.method ?? 'GET'} ${host}${probe.path}`;
        assert.equal(res.status, 404, label);
        assert.equal(res.text, 'Not Found', label);
        assert.match(res.headers['content-type'], /^text\/plain/, label);
      }
    }
  });

  test('OPTIONS røper ikke hvilke adresser som finnes', async () => {
    const app = await startApp(TWO_SITES);
    const en = await createEvent(app, { site: 'com' });
    for (const path of [`/${en.slug}`, '/admin/ny', '/api/admin/events']) {
      const res = await app.request({ method: 'OPTIONS', path, headers: onHost(COM) });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.allow, undefined, path);
    }
  });

  test('med gyldig lenke virker alt som før', async () => {
    const app = await startApp(TWO_SITES);
    const en = await createEvent(app, { site: 'com' });
    assert.equal((await app.request({ path: `/${en.slug}`, headers: onHost(COM) })).status, 200);
    assert.equal((await app.request({ path: `/${en.slug.toUpperCase()}`, headers: onHost(COM) })).status, 200);
    assert.equal((await app.request({ path: `/api/events/${en.slug}`, headers: onHost(COM) })).status, 200);
  });
});

describe('forsiden kan sendes videre (ROOT_REDIRECT)', () => {
  const NO_HOME = 'https://www.example.no/';
  const COM_HOME = 'https://www.example.com/en/';

  test('hvert nettsted har sin egen adresse, og den arves ikke', () => {
    const { sites, warnings } = loadSites({ ...TWO_SITES, ROOT_REDIRECT: 'https://www.example.no' });
    assert.deepEqual(warnings, []);
    const byId = Object.fromEntries(sites.map((site) => [site.id, site.rootRedirect]));
    // Et engelsk domene skal ikke havne på den norske siden bare fordi hovednettstedet har en adresse.
    assert.deepEqual(byId, { main: NO_HOME, com: null });
    const both = loadSites({ ...TWO_SITES, ROOT_REDIRECT: NO_HOME, SITE_COM_ROOT_REDIRECT: ` ${COM_HOME} ` });
    assert.deepEqual(both.warnings, []);
    assert.equal(both.sites.find((site) => site.id === 'com').rootRedirect, COM_HOME);
    // Uten innstillingen: ingen omdirigering, som før.
    assert.equal(loadSites(TWO_SITES).mainSite.rootRedirect, null);
  });

  test('ugyldige adresser og adresser som ville gitt en evig løkke ignoreres med en advarsel', () => {
    for (const value of ['www.example.no', '/sti', '//www.example.no', 'javascript:alert(1)', 'ftp://example.no', 'https://bruker:passord@example.no', 'https://example.no/"><script>']) {
      const { mainSite, warnings } = loadSites({ DOMAIN: MAIN, ROOT_REDIRECT: value });
      assert.equal(mainSite.rootRedirect, null, value);
      assert.equal(warnings.length, 1, value);
      assert.match(warnings[0], /^ROOT_REDIRECT=.* ignoreres: må være en full adresse/, value);
    }
    // Forsiden av nettstedet selv – også med en annen port eller en query – ville sendt nettleseren i ring.
    for (const value of [`https://${MAIN}`, `https://${MAIN}/`, `http://${MAIN.toUpperCase()}:8080/?x=1`]) {
      const { mainSite, warnings } = loadSites({ DOMAIN: MAIN, ROOT_REDIRECT: value });
      assert.equal(mainSite.rootRedirect, null, value);
      assert.match(warnings.join('\n'), /evig løkke/, value);
    }
    const com = loadSites({ ...TWO_SITES, SITE_COM_ROOT_REDIRECT: `https://${COM}/` });
    assert.match(com.warnings.join('\n'), /^SITE_COM_ROOT_REDIRECT=.*evig løkke/m);
    // En annen sti på samme domene (f.eks. et arrangement) er ingen løkke.
    assert.equal(loadSites({ DOMAIN: MAIN, ROOT_REDIRECT: `https://${MAIN}/abcdefghjkmn` }).mainSite.rootRedirect, `https://${MAIN}/abcdefghjkmn`);
    // Et annet domene som bare ligner, er heller ingen løkke.
    assert.equal(loadSites({ DOMAIN: MAIN, ROOT_REDIRECT: 'http://example.no' }).mainSite.rootRedirect, 'http://example.no/');
  });

  test('forsiden gir 302 til nettstedets adresse – alt annet uten gyldig lenke gir fortsatt 404', async () => {
    const app = await startApp({ ...TWO_SITES, ROOT_REDIRECT: NO_HOME, SITE_COM_ROOT_REDIRECT: COM_HOME });
    for (const [host, target] of [[MAIN, NO_HOME], [COM, COM_HOME], ['ukjent.example.org', NO_HOME]]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await app.request({ method, path: '/', headers: onHost(host) });
        assert.equal(res.status, 302, `${method} ${host}`);
        assert.equal(res.headers.location, target, `${method} ${host}`);
        assert.equal(res.headers['cache-control'], 'no-store', `${method} ${host}`);
      }
      // En query følger ikke med – den kunne vært hva som helst.
      assert.equal((await app.request({ path: '/?ref=x', headers: onHost(host) })).headers.location, target, host);
      for (const path of ['/index.html', '/abcdefghjkmn', '/admin/abcdefghjkmn']) {
        const res = await app.request({ path, headers: onHost(host) });
        assert.equal(res.status, 404, `${host}${path}`);
        assert.equal(res.text, 'Not Found', `${host}${path}`);
      }
      // OPTIONS røper fortsatt ingenting.
      assert.equal((await app.request({ method: 'OPTIONS', path: '/', headers: onHost(host) })).status, 404, host);
    }
  });

  test('et nettsted uten adresse beholder den nakne 404-en på forsiden', async () => {
    const app = await startApp({ ...TWO_SITES, ROOT_REDIRECT: NO_HOME });
    assert.equal((await app.request({ path: '/', headers: onHost(MAIN) })).status, 302);
    const com = await app.request({ path: '/', headers: onHost(COM) });
    assert.equal(com.status, 404);
    assert.equal(com.text, 'Not Found');
    assert.equal(com.headers.location, undefined);
  });
});

test('loadConfig gir hovednettstedets verdier som før', () => {
  const config = loadConfig(TWO_SITES);
  assert.equal(config.baseUrl, `https://${MAIN}`);
  assert.equal(config.emailFrom, 'Påmelding <pamelding@example.no>');
  assert.equal(config.sites.length, 2);
});

describe('avsender per domene i appen', () => {
  const ENV = {
    ADMIN_NO_AUTH: 'true', ADMIN_EMAIL: 'drift@thommesenarchitecture.com', SITE_NAME: 'Thommesen Arkitekter',
    DOMAIN: 'event.thommesenarchitecture.com', EMAIL_FROM: 'Thommesen Arkitekter <arrangement@thommesenarchitecture.com>',
    SITE_NO_DOMAIN: 'arrangement.arkitekt-thommesen.no',
  };
  const NO_FROM = 'Thommesen Arkitekter <arrangement@arkitekt-thommesen.no>';

  test('all e-post om et arrangement kommer fra domenet det hører til – også kopien til administratoren', async () => {
    const app = await startApp(ENV);
    const created = await createEvent(app, { site: 'no' });
    assert.deepEqual(app.sent.map((m) => [m.to, m.from]), [
      ['arrangor@example.com', NO_FROM],
      ['drift@thommesenarchitecture.com', NO_FROM],
    ]);
    app.sent.length = 0;
    await app.request({
      method: 'POST', path: `/api/events/${created.slug}/registrations`, headers: onHost('arrangement.arkitekt-thommesen.no'),
      body: { name: 'Ola', email: 'ola@example.com' },
    });
    assert.deepEqual(app.sent.map((m) => m.from), [NO_FROM, NO_FROM]);
  });

  test('avviser Resend domenet (ikke verifisert ennå), sendes e-posten fra hovednettstedets avsender', async () => {
    const sent = [];
    const errors = [];
    // Som Resend: et domene som ikke er verifisert, gir 403.
    const mailer = {
      async send(message) {
        if (message.from.includes('@arkitekt-thommesen.no')) {
          throw new Error('Resend svarte 403: {"statusCode":403,"message":"The arkitekt-thommesen.no domain is not verified. Please, add and verify your domain on https://resend.com/domains","name":"validation_error"}');
        }
        sent.push(message);
        return { id: 'x' };
      },
    };
    const app = await startApp(ENV, { mailer });
    const created = await createEvent(app, { site: 'no' });
    const reg = await app.request({
      method: 'POST', path: `/api/events/${created.slug}/registrations`, headers: onHost('arrangement.arkitekt-thommesen.no'),
      body: { name: 'Ola', email: 'ola@example.com' },
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.emailSent, true, 'gjesten får bekreftelsen likevel');
    const guest = sent.find((m) => m.to === 'ola@example.com');
    assert.equal(guest.from, 'Thommesen Arkitekter <arrangement@thommesenarchitecture.com>');
    assert.ok(guest.html.includes('arrangement.arkitekt-thommesen.no'), 'lenkene er fortsatt nettstedets egne');

    // Andre feil prøves ikke på nytt fra en annen avsender.
    const failing = { async send() { errors.push(1); throw new Error('Resend svarte 500: intern feil'); } };
    const app2 = await startApp(ENV, { mailer: failing });
    await app2.request({ method: 'POST', path: '/api/admin/events', body: { title: 'x', startsAt: '2030-01-01T10:00:00Z', organizerName: 'A', organizerEmail: 'a@example.com', site: 'no' } });
    assert.equal(errors.length, 2, 'én gang til arrangøren og én til administratoren – ingen nye forsøk');
  });
});

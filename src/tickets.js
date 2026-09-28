// Billetter, kalenderfil, PDF, Wallet og innsjekking – alt som bygger på én påmelding.
//
// Adresser (alle på arrangementets eget domene, og alle gir den nakne 404-en uten gyldig nøkkel):
//   /t/<billettnøkkel>             mobilbillett for én person – også det QR-koden peker på
//   /t/<billettnøkkel>/qr.svg      QR-koden som bilde
//   /t/<billettnøkkel>/pdf|apple|google
//   /b/<påmeldingsnøkkel>          alle billettene i én påmelding (lenken i e-posten)
//   /b/<påmeldingsnøkkel>/pdf|apple|google
//   /<slug>/kalender.ics           kalenderfil (bare offentlig informasjon)
//   /dorvakt/<slug>#<nøkkel>       dørvaktlenken – samme hash som /<slug> og /admin/<slug>
//   /<slug>/skanner#<nøkkel>       den eldre dørvaktlenken, med samme nøkkel; virker fortsatt
//
// Hvorfor ligger billettnøkkelen i stien og ikke etter #, slik som admin- og avmeldingsnøkkelen?
// - QR-koden skal kunne skannes med vanlig kamera og åpne billetten direkte.
// - PDF og Wallet lastes ned med en vanlig lenke – en nedlasting kan ikke ta med noe etter #.
// - Serveren kan dermed avvise en ugyldig nøkkel med 404 før noe som helst vises.
// En billettlenke gir bare rett til å SE billetten. Innsjekking krever i tillegg dørvaktinnlogging.
//
// Innsjekking («dørvaktmodus»):
// 1. Arrangøren deler dørvaktlenken. Når den åpnes, lagres en informasjonskapsel (HttpOnly) for
//    arrangementet på telefonen.
// 2. Dørvakten skanner gjestens QR-kode med kameraet på telefonen (eller i skanneren på siden).
//    Billettsiden ser informasjonskapselen og sjekker gjesten inn – med en POST fra siden, aldri
//    bare ved å åpne lenken – og viser grønt, gult (allerede inne) eller rødt (feil/ugyldig).
// Dørvakten ser bare navn og status – aldri e-post, telefonnummer eller svar på skjemaet.
import { createHash } from 'node:crypto';
import { applePasses } from './appleWallet.js';
import { eventIcs, googleCalendarUrl } from './calendar.js';
import { fileSlug } from './filename.js';
import { googleSaveUrl } from './googleWallet.js';
import { formatCode, parseCode, parseDoorCode } from './ids.js';
import { ticketsPdf } from './pdf.js';
import { appleDirectionsUrl, directionsUrl, PlaceSearchError } from './places.js';
import { qrSvg } from './qr.js';

const DAY = 86_400_000;
const STAFF_COOKIE = 'dv_'; // + slug: dørvaktnøkkelen
const STAFF_NAME_COOKIE = 'dvn_'; // + slug: navnet dørvakten oppga (valgfritt)
const MAX_STAFF_NAME = 60;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* beholdes som den er */ }
    cookies[name] = value;
  }
  return cookies;
}

/**
 * @param {object} ctx  Det tickets trenger fra app.js: repo, config, tokens, siteOf, eventUrl,
 *                      findEventBySlug, notFound, sendPage, limiter, logger, adminT, placeSearch
 */
export function createTicketFeature(ctx) {
  const { repo, config, tokens, siteOf, eventUrl, findEventBySlug, notFound, sendPage, logger, adminT } = ctx;
  const imageUrlOf = ctx.imageUrlOf ?? ((event) => event.imageUrl);
  const { logoFor, redirectToSite } = ctx;
  const isLan = ctx.isLan ?? (() => false);
  const wallet = config.wallet ?? { apple: null, google: null };

  // ---------- Brytere og lenker ----------

  /** Det som faktisk er på for arrangementet: bryteren OG at tjenesten er satt opp. */
  function features(event) {
    const f = event.features;
    return {
      tickets: f.tickets,
      calendar: f.calendar,
      pdf: f.tickets && f.pdf,
      appleWallet: f.tickets && f.appleWallet && Boolean(wallet.apple),
      googleWallet: f.tickets && f.googleWallet && Boolean(wallet.google),
    };
  }

  const base = (event) => siteOf(event).baseUrl;
  const ticketPath = (code) => `/t/${tokens.ticket(code)}`;
  const bookingPath = (code) => `/b/${tokens.booking(code)}`;
  const ticketUrl = (event, code) => `${base(event)}${ticketPath(code)}`;
  const bookingUrl = (event, code) => `${base(event)}${bookingPath(code)}`;
  const calendarUrl = (event) => `${base(event)}/${event.slug}/kalender.ics`;
  const scannerUrl = (event) => `${base(event)}/dorvakt/${event.slug}#${tokens.scanner(event.id, event.scannerVersion)}`;
  // Avmelding (/<slug>/avmelding#<nøkkel>), bare når arrangøren lar deltakerne melde seg av selv.
  // Nøkkelen står etter #, så den havner aldri i serverlogger eller Referer-headere.
  const cancelPath = (event, token) => (event.features.selfCancel ? `/${event.slug}/avmelding#${token}` : null);
  const cancelBookingPath = (event, bookingCode) => cancelPath(event, tokens.cancelBooking(bookingCode));
  const cancelTicketPath = (event, code) => cancelPath(event, tokens.cancelTicket(code));
  const absolute = (event, path) => (path ? `${base(event)}${path}` : null);

  /** Lenkene som vises på billettsiden og i e-posten. `path` er /t/… eller /b/… (uten domene). */
  function links(event, path, { absolute: full = false } = {}) {
    const f = features(event);
    const prefix = full ? base(event) : '';
    return {
      pdf: f.pdf ? `${prefix}${path}/pdf` : null,
      apple: f.appleWallet ? `${prefix}${path}/apple` : null,
      google: f.googleWallet ? `${prefix}${path}/google` : null,
      ics: f.calendar ? (full ? calendarUrl(event) : `/${event.slug}/kalender.ics`) : null,
      googleCalendar: f.calendar ? googleCalendarUrl({ event, eventUrl: eventUrl(event) }) : null,
      directions: directionsUrl(event),
      appleDirections: appleDirectionsUrl(event),
    };
  }

  /**
   * Alt for én person, til den som meldte på: billettlenke, Wallet, PDF og avmelding. Den som melder
   * på flere, får alt samlet og videresender selv til hver enkelt.
   */
  function personLinks(event, person) {
    const f = features(event);
    const ticket = f.tickets ? ticketUrl(event, person.code) : null;
    return {
      ticket,
      apple: f.appleWallet ? `${ticket}/apple` : null,
      google: f.googleWallet ? `${ticket}/google` : null,
      pdf: f.pdf ? `${ticket}/pdf` : null,
      cancel: absolute(event, cancelTicketPath(event, person.code)),
    };
  }

  /** Arrangementet slik billettsidene og tilleggene trenger det – bare offentlig informasjon. */
  function ticketEvent(event) {
    return {
      slug: event.slug,
      url: eventUrl(event),
      title: event.title,
      location: event.location,
      geo: event.geo,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      organizerName: event.organizerName,
      imageUrl: imageUrlOf(event),
      timeZone: config.timeZone,
      cancelled: Boolean(event.cancelledAt),
    };
  }

  /** Billettene i en påmelding, i rekkefølge, som grunnlag for side, PDF og Wallet. */
  function ticketList(event, persons) {
    return persons.map((person, i) => ({
      id: person.id,
      name: person.name,
      code: person.code,
      doorCode: person.doorCode,
      url: ticketUrl(event, person.code),
      path: ticketPath(person.code),
      index: i + 1,
      total: persons.length,
      checkedInAt: person.checkedInAt,
    }));
  }

  // ---------- Oppslag fra nøkler ----------

  /** /t/<nøkkel> → { event, person, booking }, eller null. */
  function resolveTicket(token) {
    const code = tokens.parseTicket(token);
    const person = code && repo.findRegistrationByCode(code);
    if (!person) return null;
    const event = repo.findEventById(person.eventId);
    if (!event || !event.features.tickets) return null;
    return { event, person, booking: repo.findBookingByCode(person.bookingCode) };
  }

  /** /b/<nøkkel> → { event, booking }, eller null. */
  function resolveBooking(token) {
    const code = tokens.parseBooking(token);
    const booking = code && repo.findBookingByCode(code);
    if (!booking || !booking.persons.length) return null;
    const event = repo.findEventById(booking.eventId);
    if (!event || !event.features.tickets) return null;
    return { event, booking };
  }

  // ---------- Dørvakter ----------

  const cookiesOf = (req) => (req.cookieJar ??= parseCookies(req.get('cookie')));

  /** Dørvakten for dette arrangementet ({ name }), eller null. */
  function staffFor(req, event) {
    if (!event.features.tickets) return null;
    const cookies = cookiesOf(req);
    const key = cookies[STAFF_COOKIE + event.slug];
    if (!key || !tokens.scannerMatches(key, event.id, event.scannerVersion)) return null;
    return { name: (cookies[STAFF_NAME_COOKIE + event.slug] || '').slice(0, MAX_STAFF_NAME) || null };
  }

  /** Alle arrangementer telefonen er logget inn som dørvakt for. */
  function staffEvents(req) {
    return Object.keys(cookiesOf(req))
      .filter((name) => name.startsWith(STAFF_COOKIE))
      .map((name) => findEventBySlug(name.slice(STAFF_COOKIE.length)))
      .filter((event) => event && staffFor(req, event));
  }

  // Skriveforespørsler fra dørvaktsidene må komme fra samme nettsted. Informasjonskapselen er
  // allerede SameSite=Lax, og API-et krever JSON; dette er en ekstra sperre mot CSRF.
  function sameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* ugyldig */ }
      if (host !== req.get('host')) return res.status(403).json({ error: req.t('errors.forbidden') });
    }
    next();
  }

  function requireStaff(req, res, next) {
    req.staff = staffFor(req, req.event);
    if (!req.staff) return res.status(401).json({ error: req.t('scanner.notLoggedIn'), loggedOut: true });
    next();
  }

  const stats = (event) => ({ checkedIn: repo.countCheckedIn(event.id), total: repo.countRegistrations(event.id) });

  /** En person slik dørvakten ser den: navn og status, ingen kontaktinformasjon. */
  function staffPerson(person, booking) {
    return {
      id: person.id,
      name: person.name,
      code: formatCode(person.code),
      checkedInAt: person.checkedInAt,
      checkedInBy: person.checkedInBy,
      bookedBy: person.position > 0 && booking ? booking.contactName : null,
    };
  }

  function checkinPayload(event, person, result) {
    const booking = repo.findBookingByCode(person.bookingCode);
    return {
      result,
      person: staffPerson(person, booking),
      // De andre i samme påmelding, så en familie med billettene på én telefon slipper inn samlet.
      companions: (booking?.persons ?? []).filter((p) => p.id !== person.id).map((p) => staffPerson(p, booking)),
      stats: stats(event),
    };
  }

  // Innsjekking fra en kø som ble fylt mens telefonen var uten nett: tiden den faktisk skjedde brukes,
  // så lenge den er fra det siste døgnet og ikke i fremtiden.
  function checkinTime(at) {
    const now = Date.now();
    const time = typeof at === 'string' ? Date.parse(at) : NaN;
    return Number.isFinite(time) && time <= now && time > now - DAY ? new Date(time).toISOString() : new Date(now).toISOString();
  }

  // Finner personen dørvakten skannet eller tastet inn. Gir { person } eller { status, body }.
  function findForCheckin(req) {
    const { event, t } = req;
    const body = req.body ?? {};
    let person = null;
    if (typeof body.token === 'string') {
      const code = tokens.parseTicket(body.token.trim());
      person = code && repo.findRegistrationByCode(code);
    } else if (body.code !== undefined) {
      // Dørkoden (5 bokstaver) gjelder bare dette arrangementet. Billettnummeret (10 tegn) fra
      // eldre PDF-er og Wallet-kort godtas fortsatt.
      const door = parseDoorCode(body.code);
      const code = !door && parseCode(body.code);
      person = door ? repo.findRegistrationByDoorCode(event.id, door) : code && repo.findRegistrationByCode(code);
    } else if (Number.isInteger(body.id)) {
      person = repo.findRegistration(event.id, body.id);
    }
    if (event.cancelledAt) return { status: 409, body: { result: 'cancelled', error: t('status.cancelled'), stats: stats(event) } };
    if (!person) return { status: 404, body: { result: 'invalid', error: t('scanner.invalid'), stats: stats(event) } };
    if (person.eventId !== event.id) {
      const other = repo.findEventById(person.eventId);
      return {
        status: 409,
        body: { result: 'wrong_event', error: t('scanner.wrongEvent', { title: other?.title ?? '' }), stats: stats(event) },
      };
    }
    return { person };
  }

  // ---------- Sider og filer ----------

  // Samme regler som arrangementssiden: feil domene → 301 til riktig, med samme sti (på LAN: samme
  // adresse med ?site=<id>, se redirectToSite i app.js).
  const onRightSite = (req, res, event) => {
    const site = siteOf(event);
    if (site === req.site) return true;
    redirectToSite(req, res, site);
    return false;
  };

  const noStore = (res) => res.set('Cache-Control', 'no-store');

  async function sendPdf(res, event, persons, name) {
    const site = siteOf(event);
    const pdf = await ticketsPdf({
      event, site, timeZone: config.timeZone, eventUrl: eventUrl(event), tickets: ticketList(event, persons), logo: await logoFor(site.theme),
    });
    noStore(res).type('application/pdf')
      .set('Content-Disposition', `inline; filename="${name}"`)
      .send(pdf);
  }

  function sendApple(res, event, persons) {
    const passes = applePasses({
      config: wallet.apple, event, site: siteOf(event), timeZone: config.timeZone,
      eventUrl: eventUrl(event), tickets: ticketList(event, persons),
    });
    noStore(res).type(passes.type)
      .set('Content-Disposition', `attachment; filename="${fileSlug(event.title)}.${passes.ext}"`)
      .send(passes.data);
  }

  function redirectGoogle(res, event, persons) {
    const url = googleSaveUrl({
      config: wallet.google, event, site: siteOf(event), eventUrl: eventUrl(event), tickets: ticketList(event, persons),
      heroImage: imageUrlOf(event),
    });
    noStore(res).redirect(302, url);
  }

  /** Nedlastinger for én billett (/t) eller hele påmeldingen (/b). */
  const extra = (resolve, personsOf, singular) => async (req, res) => {
    const found = resolve(req.params.token);
    if (!found) return notFound(req, res);
    const { event } = found;
    if (!onRightSite(req, res, event)) return;
    const f = features(event);
    const persons = personsOf(found);
    const t = siteOf(event).t;
    switch (req.params.kind) {
      case 'pdf':
        if (!f.pdf) return notFound(req, res);
        return sendPdf(res, event, persons, `${t(singular ? 'ticket.pdfName' : 'ticket.pdfNameMany')}-${fileSlug(event.title)}.pdf`);
      case 'apple':
        if (!f.appleWallet) return notFound(req, res);
        return sendApple(res, event, persons);
      case 'google':
        if (!f.googleWallet) return notFound(req, res);
        return redirectGoogle(res, event, persons);
      default:
        return notFound(req, res);
    }
  };

  /** Sider og filer på de offentlige domenene. Registreres før /:slug-rutene i app.js. */
  function mountPages(app) {
    app.get('/t/:token', (req, res) => {
      const found = resolveTicket(req.params.token);
      if (!found) {
        // En dørvakt som skanner en ugyldig eller avmeldt billett skal se en rød skjerm, ikke en
        // naken 404. Alle andre får den nakne 404-en.
        const [staffEvent] = staffEvents(req);
        return staffEvent ? sendPage(res, 'ticket', siteOf(staffEvent), 404) : notFound(req, res);
      }
      if (!onRightSite(req, res, found.event)) return;
      noStore(res);
      sendPage(res, 'ticket', siteOf(found.event), 200, found.event);
    });
    app.get('/b/:token', (req, res) => {
      const found = resolveBooking(req.params.token);
      if (!found) return notFound(req, res);
      if (!onRightSite(req, res, found.event)) return;
      noStore(res);
      sendPage(res, 'ticket', siteOf(found.event), 200, found.event);
    });
    app.get('/t/:token/qr.svg', (req, res) => {
      const found = resolveTicket(req.params.token);
      if (!found) return notFound(req, res);
      res.type('image/svg+xml').set('Cache-Control', 'private, max-age=86400')
        .send(qrSvg(ticketUrl(found.event, found.person.code)));
    });
    app.get('/t/:token/:kind', extra(resolveTicket, ({ person }) => [person], true));
    app.get('/b/:token/:kind', extra(resolveBooking, ({ booking }) => booking.persons, false));

    app.get('/:slug/kalender.ics', (req, res) => {
      const event = findEventBySlug(req.params.slug);
      if (!event || !features(event).calendar) return notFound(req, res);
      if (!onRightSite(req, res, event)) return;
      const site = siteOf(event);
      res.type('text/calendar; charset=utf-8')
        .set('Cache-Control', 'no-cache')
        .set('Content-Disposition', `attachment; filename="${fileSlug(event.title)}.ics"`)
        .send(eventIcs({ event, eventUrl: eventUrl(event), host: new URL(site.baseUrl).hostname, lang: site.lang, cancelledPrefix: `${site.t('event.badge.cancelled').toUpperCase()}:` }));
    });

    // Dørvaktlenken er /dorvakt/<slug>#<nøkkel>. Lenker som ble sendt ut før adressen ble endret
    // (/<slug>/skanner#<nøkkel>), får den samme siden direkte – ikke en videresending – så en dørvakt
    // som laster siden på nytt midt i et arrangement, aldri merker noe. Nøkkelen og informasjonskapselen
    // er de samme for begge adressene (se tokens.js).
    const scannerPage = (req, res) => {
      const event = findEventBySlug(req.params.slug);
      if (!event || !event.features.tickets) return notFound(req, res);
      if (!onRightSite(req, res, event)) return;
      noStore(res);
      sendPage(res, 'scanner', siteOf(event), 200, event);
    };
    app.get('/dorvakt/:slug', scannerPage);
    app.get('/:slug/skanner', scannerPage);
  }

  // ---------- Offentlig API ----------

  function pagePayload(req, event, persons, path, kind) {
    const staff = staffFor(req, event);
    return {
      kind,
      event: ticketEvent(event),
      tickets: ticketList(event, persons).map(({ id, url, code, ...rest }) => ({ ...rest, code: formatCode(code), qr: `${rest.path}/qr.svg` })),
      links: { ...links(event, path), cancel: null },
      // Dørvakt for dette arrangementet: siden sjekker inn. For et annet arrangement: rød skjerm.
      staff: staff ? { name: staff.name } : null,
      wrongEvent: !staff && staffEvents(req).length > 0,
    };
  }

  function mountApi(api, { loadPublicEvent }) {
    api.get('/tickets/:token', (req, res) => {
      noStore(res);
      const found = resolveTicket(req.params.token);
      if (!found) {
        const [staffEvent] = staffEvents(req);
        if (!staffEvent) return notFound(req, res);
        const t = siteOf(staffEvent).t;
        return res.status(404).json({ error: t('scanner.invalid'), invalid: true, staff: { slug: staffEvent.slug, title: staffEvent.title } });
      }
      const { event, person, booking } = found;
      req.t = siteOf(event).t;
      // Billettnummeret i rekkefølgen i påmeldingen («2 av 3»).
      const persons = booking?.persons ?? [person];
      const index = Math.max(0, persons.findIndex((p) => p.id === person.id));
      const list = ticketList(event, persons);
      const payload = pagePayload(req, event, [person], ticketPath(person.code), 'ticket');
      payload.tickets[0].index = list[index].index;
      payload.tickets[0].total = list.length;
      if (payload.staff) payload.checkin = { id: person.id };
      res.json(payload);
    });

    api.get('/bookings/:token', (req, res) => {
      noStore(res);
      const found = resolveBooking(req.params.token);
      if (!found) return notFound(req, res);
      const { event, booking } = found;
      req.t = siteOf(event).t;
      const payload = pagePayload(req, event, booking.persons, bookingPath(booking.code), 'booking');
      payload.contactName = booking.contactName;
      // Den som meldte på, kan melde av hele påmeldingen eller hver enkelt, og videresende hver
      // billett med sin egen avmeldingslenke. Enkeltbilletten (/t/, det QR-koden peker på) får
      // aldri avmelding – se tokens.js.
      payload.links.cancel = cancelBookingPath(event, booking.code);
      payload.tickets.forEach((ticket, i) => {
        ticket.cancel = absolute(event, cancelTicketPath(event, booking.persons[i].code));
        // «Del billetten» deler den offentlige lenken – også når siden er åpnet på LAN.
        ticket.url = ticketUrl(event, booking.persons[i].code);
      });
      // Dørvakten får også id-ene, så hver billett kan sjekkes inn fra siden.
      if (payload.staff) payload.tickets.forEach((ticket, i) => { ticket.id = booking.persons[i].id; });
      res.json(payload);
    });

    // --- Dørvakt ---
    const staffApi = (path) => `/events/:slug/scanner${path}`;
    const scannerLimiter = ctx.limiter(ctx.limits.scanner);

    api.post(staffApi('/login'), loadPublicEvent, scannerLimiter, sameOrigin, (req, res) => {
      const { event, t } = req;
      const key = req.body?.key;
      if (!event.features.tickets || !tokens.scannerMatches(key, event.id, event.scannerVersion)) {
        return res.status(401).json({ error: t('scanner.invalidLink') });
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, MAX_STAFF_NAME) : '';
      // Gyldig til to døgn etter at arrangementet er over (minst ett døgn fra nå).
      const endsAt = Date.parse(event.endsAt || event.startsAt) + 2 * DAY;
      const maxAge = Math.max(DAY, endsAt - Date.now());
      // Secure når nettstedet er på https – men ikke på LAN-porten, som er vanlig http. Der ville
      // nettleseren ellers forkastet informasjonskapselen, og dørvakten aldri blitt logget inn.
      const secure = !isLan(req) && siteOf(event).baseUrl.startsWith('https:');
      const options = { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge };
      res.cookie(STAFF_COOKIE + event.slug, key, options);
      if (name) res.cookie(STAFF_NAME_COOKIE + event.slug, name, options);
      else res.clearCookie(STAFF_NAME_COOKIE + event.slug, { path: '/' });
      res.json({ ok: true, name: name || null });
    });

    api.post(staffApi('/logout'), loadPublicEvent, sameOrigin, (req, res) => {
      res.clearCookie(STAFF_COOKIE + req.event.slug, { path: '/' });
      res.clearCookie(STAFF_NAME_COOKIE + req.event.slug, { path: '/' });
      res.json({ ok: true });
    });

    // Status for skannersiden, og listen den bruker når nettet er borte. Listen har bare navn og
    // hasher av billettnøkler og -numre: telefonen kan kjenne igjen en ekte billett uten nett, men
    // kan ikke lage nye.
    api.get(staffApi(''), loadPublicEvent, requireStaff, (req, res) => {
      const { event } = req;
      const registrations = repo.listRegistrations(event.id);
      res.json({
        event: ticketEvent(event),
        staff: req.staff,
        stats: stats(event),
        offline: registrations.map((r) => ({
          id: r.id,
          name: r.name,
          token: sha256(tokens.ticket(r.code)).slice(0, 32),
          code: sha256(r.code).slice(0, 32),
          // Dørkoden er kort og kan uansett tastes inn av dørvakten, så den sendes som den er.
          door: r.doorCode,
          checkedInAt: r.checkedInAt,
        })),
      });
    });

    // Søk på navn, for gjester uten billett på telefonen. Minst to tegn og maks ti treff, så
    // dørvakten ikke blar gjennom hele listen.
    api.get(staffApi('/search'), loadPublicEvent, requireStaff, (req, res) => {
      const q = String(req.query.q ?? '').trim().toLocaleLowerCase();
      if (q.length < 2) return res.json({ results: [] });
      const registrations = repo.listRegistrations(req.event.id);
      const results = registrations
        .filter((r) => r.name.toLocaleLowerCase().includes(q))
        .slice(0, 10)
        .map((r) => ({ id: r.id, name: r.name, checkedInAt: r.checkedInAt, bookedBy: r.position > 0 ? r.contactName : null }));
      res.json({ results });
    });

    api.post(staffApi('/checkin'), loadPublicEvent, sameOrigin, requireStaff, (req, res) => {
      const { event } = req;
      const found = findForCheckin(req);
      if (!found.person) return res.status(found.status).json(found.body);
      const done = repo.checkIn(event.id, found.person.id, { at: checkinTime(req.body.at), by: req.staff.name });
      const person = repo.findRegistration(event.id, found.person.id);
      res.json(checkinPayload(event, person, done ? 'checked_in' : 'already'));
    });

    api.post(staffApi('/undo'), loadPublicEvent, sameOrigin, requireStaff, (req, res) => {
      const { event, t } = req;
      const person = Number.isInteger(req.body?.id) && repo.findRegistration(event.id, req.body.id);
      if (!person) return res.status(404).json({ result: 'invalid', error: t('scanner.invalid') });
      const undone = repo.undoCheckIn(event.id, person.id);
      res.json(checkinPayload(event, repo.findRegistration(event.id, person.id), undone ? 'undone' : 'not_checked_in'));
    });
  }

  // ---------- Admin-API ----------

  function mountAdminApi(adminApi, { loadAdminEvent, requireEventAdmin, requireCreator }) {
    const adminCheckin = (undo) => (req, res) => {
      const id = Number(req.params.id);
      const person = Number.isInteger(id) && repo.findRegistration(req.event.id, id);
      if (!person) return res.status(404).json({ error: adminT('errors.registrationNotFound') });
      if (undo) repo.undoCheckIn(req.event.id, id);
      else repo.checkIn(req.event.id, id, { by: req.accessUser?.email ?? null });
      const updated = repo.findRegistration(req.event.id, id);
      res.json({ registration: { id, checkedInAt: updated.checkedInAt, checkedInBy: updated.checkedInBy }, stats: stats(req.event) });
    };
    adminApi.post('/events/:slug/registrations/:id/checkin', loadAdminEvent, requireEventAdmin, adminCheckin(false));
    adminApi.delete('/events/:slug/registrations/:id/checkin', loadAdminEvent, requireEventAdmin, adminCheckin(true));

    // Ny dørvaktlenke: den gamle – og alle telefoner som er logget inn med den – slutter å virke.
    adminApi.post('/events/:slug/scanner/rotate', loadAdminEvent, requireEventAdmin, (req, res) => {
      repo.rotateScannerKey(req.event.id);
      res.json({ scannerUrl: scannerUrl(repo.findEventById(req.event.id)) });
    });

    // Stedsoppslag mot Kartverket (se places.js): i skjemaet for et nytt arrangement (opprettingstilgang)
    // og når ett arrangement redigeres (admin-nøkkelen).
    const places = async (req, res) => {
      try {
        res.json({ results: await ctx.placeSearch.search(req.query.q) });
      } catch (err) {
        if (!(err instanceof PlaceSearchError)) throw err;
        logger.error(err.message);
        res.status(502).json({ error: adminT('errors.placesUnavailable') });
      }
    };
    adminApi.get('/places', requireCreator, places);
    adminApi.get('/events/:slug/places', loadAdminEvent, requireEventAdmin, places);
  }

  // ---------- E-post ----------

  /**
   * Lenker og vedlegg til bekreftelsen etter en påmelding: billettside, Wallet, kalender, PDF og
   * avmelding – for hele påmeldingen og for hver person.
   * Svikter PDF-en, sendes e-posten uten – påmeldingen er det viktigste.
   */
  async function confirmationExtras(event, bookingCode) {
    const booking = repo.findBookingByCode(bookingCode);
    const f = features(event);
    const site = siteOf(event);
    const path = bookingPath(bookingCode);
    const attachments = [];
    if (f.calendar) {
      attachments.push({
        filename: `${fileSlug(event.title)}.ics`,
        content: Buffer.from(eventIcs({ event, eventUrl: eventUrl(event), host: new URL(site.baseUrl).hostname, lang: site.lang, cancelledPrefix: `${site.t('event.badge.cancelled').toUpperCase()}:` })),
        contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
      });
    }
    if (f.pdf && booking) {
      try {
        attachments.push({
          filename: `${site.t(booking.persons.length > 1 ? 'ticket.pdfNameMany' : 'ticket.pdfName')}-${fileSlug(event.title)}.pdf`,
          content: await ticketsPdf({
            event, site, timeZone: config.timeZone, eventUrl: eventUrl(event), tickets: ticketList(event, booking.persons), logo: await logoFor(site.theme),
          }),
          contentType: 'application/pdf',
        });
      } catch (err) {
        logger.error('Kunne ikke lage PDF-billett:', err);
      }
    }
    return {
      links: {
        tickets: f.tickets ? bookingUrl(event, bookingCode) : null,
        ...links(event, path, { absolute: true }),
        cancel: absolute(event, cancelBookingPath(event, bookingCode)),
      },
      // Samme rekkefølge som booking.persons.
      persons: (booking?.persons ?? []).map((person) => personLinks(event, person)),
      attachments,
    };
  }

  return {
    features,
    links,
    scannerUrl,
    ticketUrl,
    bookingUrl,
    stats,
    mountPages,
    mountApi,
    mountAdminApi,
    confirmationExtras,
  };
}

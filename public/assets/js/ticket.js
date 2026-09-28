// Billettsiden: /t/<nøkkel> (én billett – det QR-koden peker på) og /b/<nøkkel> (alle i en påmelding).
//
// For gjesten: QR-kode, navn og billettnummer, pluss Wallet, PDF, kalender og veibeskrivelse.
// For en dørvakt (logget inn med dørvaktlenken på denne telefonen): /t/ sjekker gjesten inn med én
// gang og viser grønt, gult eller rødt – med «Angre». Innsjekkingen er en POST fra siden, aldri bare
// det at lenken åpnes (e-postprogrammer og forhåndsvisninger åpner lenker av seg selv).
import { api, formatDay, formatEventTime, formatTime, h, notice, t } from './common.js';
import { feedback, resultView } from './staff.js';

const app = document.getElementById('app');
const [, kind, token] = location.pathname.split('/');
const isBooking = kind === 'b';

async function load() {
  let data;
  try {
    data = await api(isBooking ? `/bookings/${token}` : `/tickets/${token}`);
  } catch (err) {
    // En dørvakt som skanner en ugyldig eller avmeldt billett får en rød skjerm.
    if (err.data?.invalid) return showResult({ result: 'invalid', error: err.message }, err.data.staff?.slug, null);
    app.replaceChildren(h('h1', {}, t('ticket.notFound')), h('p', {}, err.message));
    return;
  }
  document.title = t('ticket.documentTitle', { title: data.event.title });

  if (data.wrongEvent) {
    return showResult({ result: 'wrong_event', error: t('scanner.wrongEvent', { title: data.event.title }) }, null, null);
  }
  if (data.staff && !isBooking) return checkIn(data);
  render(data);
}

// ---------- Gjestens billett ----------

function render(data) {
  const { event, tickets, links, staff } = data;
  const tz = event.timeZone;
  app.replaceChildren(...[
    h('p', { class: 'kicker' }, t('ticket.kicker', { count: tickets.length })),
    h('h1', {}, event.title),
    event.cancelled ? notice('error', t('status.cancelled')) : null,
    h('dl', { class: 'meta' },
      h('dt', {}, t('event.when')), h('dd', {}, formatEventTime(event.startsAt, event.endsAt, tz)),
      event.location
        ? [h('dt', {}, t('event.where')), h('dd', {}, event.location, ' ', directionsLink(links))]
        : null,
    ),
    carousel(tickets, event, staff),
    actions(links),
    h('p', {}, h('a', { href: event.url }, t('ticket.toEvent'))),
  ].filter(Boolean));
  keepScreenOn();
}

/** «Veibeskrivelse»: Apple Kart på iPhone/iPad/Mac, ellers Google Maps. */
function directionsLink(links) {
  const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && links.appleDirections;
  const href = apple || links.directions;
  return href ? h('a', { class: 'directions', href, target: '_blank', rel: 'noopener' }, t('links.directions')) : null;
}

// Flere billetter vises side om side og blas med sveip (CSS scroll-snap) eller knappene – som i
// Wallet. «1 / 3» viser hvor man er.
function carousel(tickets, event, staff) {
  const track = h('div', { class: 'ticket-track' }, tickets.map((ticket) => ticketCard(ticket, event, staff)));
  if (tickets.length === 1) return track;

  const position = h('span', { class: 'ticket-position', 'aria-live': 'polite' });
  const prev = h('button', { class: 'btn secondary small', type: 'button', 'aria-label': t('ticket.previous') }, '‹');
  const next = h('button', { class: 'btn secondary small', type: 'button', 'aria-label': t('ticket.next') }, '›');
  const current = () => Math.round(track.scrollLeft / track.clientWidth);
  const update = () => {
    const i = current();
    position.textContent = `${i + 1} / ${tickets.length}`;
    prev.disabled = i === 0;
    next.disabled = i === tickets.length - 1;
  };
  const go = (delta) => track.scrollTo({ left: (current() + delta) * track.clientWidth, behavior: 'smooth' });
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  requestAnimationFrame(update);
  return h('div', { class: 'ticket-carousel' }, track, h('div', { class: 'ticket-nav' }, prev, position, next));
}

function ticketCard(ticket, event, staff) {
  const tz = event.timeZone;
  return h('article', { class: `ticket-card${ticket.checkedInAt ? ' used' : ''}` },
    h('div', { class: 'ticket-qr' }, h('img', { src: ticket.qr, alt: ticket.code, width: 260, height: 260 })),
    h('div', { class: 'ticket-holder' }, ticket.name),
    ticket.total > 1 ? h('div', { class: 'muted small' }, t('ticket.position', { n: ticket.index, total: ticket.total })) : null,
    // Dørkoden stort: kan leses opp og tastes inn i døra hvis QR-koden ikke virker.
    ticket.doorCode
      ? h('div', { class: 'ticket-door' }, h('span', { class: 'label' }, t('ticket.doorCode')), h('span', { class: 'ticket-code' }, ticket.doorCode))
      : h('div', { class: 'ticket-code', 'aria-label': t('ticket.number') }, ticket.code),
    ticket.checkedInAt
      ? h('div', { class: 'badge' }, t('ticket.checkedIn', { time: `${formatDay(ticket.checkedInAt, tz)} ${formatTime(ticket.checkedInAt, tz)}` }))
      : null,
    // På påmeldingssiden kan en dørvakt sjekke inn hver billett for seg.
    staff && ticket.id && !ticket.checkedInAt ? staffButton(event, ticket) : null,
  );
}

function staffButton(event, ticket) {
  const button = h('button', { class: 'btn small', type: 'button' }, t('scanner.checkInButton'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(`/events/${event.slug}/scanner/checkin`, { method: 'POST', body: { id: ticket.id } });
      button.replaceWith(h('div', { class: 'badge' }, t('scanner.checkedIn')));
      feedback(result.result === 'checked_in');
    } catch (err) {
      button.disabled = false;
      alert(err.message);
    }
  });
  return button;
}

function actions(links) {
  const items = [
    links.apple && h('a', { class: 'btn wallet-btn apple', href: links.apple }, t('links.appleWallet')),
    links.google && h('a', { class: 'btn wallet-btn google', href: links.google, rel: 'noopener' }, t('links.googleWallet')),
    links.pdf && h('a', { class: 'btn secondary', href: links.pdf, target: '_blank' }, t('links.pdf')),
    links.ics && h('a', { class: 'btn secondary', href: links.ics }, t('links.calendar')),
    links.googleCalendar && h('a', { class: 'btn secondary', href: links.googleCalendar, target: '_blank', rel: 'noopener' }, t('links.googleCalendar')),
  ].filter(Boolean);
  return items.length ? h('div', { class: 'actions ticket-actions' }, items) : null;
}

// Hold skjermen på mens billetten vises, så den ikke slukner i køen. Ikke alle nettlesere kan det.
async function keepScreenOn() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch { /* ikke viktig */ }
}

// ---------- Dørvakt ----------

async function checkIn(data) {
  const { event } = data;
  let result;
  try {
    result = await api(`/events/${event.slug}/scanner/checkin`, { method: 'POST', body: { token } });
  } catch (err) {
    result = err.data?.result ? err.data : { result: 'invalid', error: err.message };
  }
  showResult(result, event.slug, event.timeZone);
}

/** Stor farget skjerm: grønn = sjekket inn, gul = allerede inne, rød = ugyldig / feil arrangement. */
function showResult(result, slug, timeZone) {
  const update = (next) => showResult(next, slug, timeZone);
  app.replaceChildren(...[
    ...resultView(result, { slug, timeZone, onUpdate: update }),
    result.stats ? h('p', { class: 'muted' }, t('scanner.stats', result.stats)) : null,
    slug ? h('p', {}, h('a', { class: 'btn secondary', href: `/${slug}/skanner` }, t('scanner.openScanner'))) : null,
  ].filter(Boolean));
  document.title = app.querySelector('h2')?.textContent || document.title;
  feedback(['checked_in', 'undone', 'not_checked_in'].includes(result.result));
}

load();

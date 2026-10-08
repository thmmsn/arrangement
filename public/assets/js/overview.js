import { api, formatEventTime, formatShort, h, notice, secretFromHash, t } from './common.js';

// Oversikten over alle arrangementer: /admin. Eieren velger hvordan den beskyttes (OVERVIEW_AUTH): nøkkel
// etter # (/admin#<nøkkel>), brukernavn og passord, Cloudflare Access, LAN-porten eller ingenting.
// Nøkkelen står etter #, så nettleseren sender den aldri når siden åpnes – JavaScript her sender den til
// API-et i Authorization-headeren. Passordinnloggingen huskes i en informasjonskapsel (HttpOnly).
// Bare tall og offentlig informasjon; ingen opplysninger om gjestene.

const app = document.getElementById('app');
const key = secretFromHash();
const auth = key ? { Authorization: `Bearer ${key}` } : {};

let data = null;
let filter = '';

async function load() {
  try {
    data = await api('/admin/overview', { headers: auth });
  } catch (err) {
    // 401 forteller hvilke måter eieren har valgt, så siden kan vise riktig innlogging.
    if (err.status === 401 && err.data?.login) return showLogin(err.data.login, key ? err.message : null);
    app.replaceChildren(h('h1', {}, t('overview.noAccess')), h('p', {}, err.message));
    return;
  }
  render();
}

// Ingen tilgang ennå: skjema for brukernavn og passord (hvis det er valgt), og de andre måtene.
function showLogin(login, error) {
  const status = h('div', {}, error ? notice('error', error) : null);
  const ways = [
    login.key ? t('overview.howKey') : null,
    login.access ? t('overview.howAccess') : null,
    login.lan ? t('overview.howLan') : null,
  ].filter(Boolean);
  const waysList = ways.length ? h('ul', { class: 'muted small' }, ways.map((text) => h('li', {}, text))) : null;

  if (!login.password) {
    app.replaceChildren(h('h1', {}, t('overview.noAccess')), status, waysList);
    return;
  }

  const username = login.user ? h('input', { type: 'text', id: 'ov-user', autocomplete: 'username', required: true }) : null;
  const password = h('input', { type: 'password', id: 'ov-password', autocomplete: 'current-password', required: true });
  const button = h('button', { class: 'btn', type: 'submit' }, t('overview.loginButton'));
  const form = h('form', { class: 'card login-card' },
    h('p', { class: 'muted' }, t('overview.loginText')),
    status,
    username ? h('div', { class: 'form-row' }, h('label', { for: 'ov-user' }, t('overview.username')), username) : null,
    h('div', { class: 'form-row' }, h('label', { for: 'ov-password' }, t('overview.password')), password),
    h('div', { class: 'actions' }, button));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    try {
      await api('/admin/overview/login', { method: 'POST', body: { username: username?.value ?? '', password: password.value } });
      await load();
    } catch (err) {
      button.disabled = false;
      status.replaceChildren(notice('error', err.message));
      password.select();
    }
  });

  app.replaceChildren(
    h('p', { class: 'kicker' }, t('overview.kicker')),
    h('h1', {}, t('overview.loginTitle')),
    form,
    ways.length ? h('p', { class: 'muted small' }, t('overview.orHeading')) : null,
    waysList);
  (username ?? password).focus();
}

async function logout(button) {
  button.disabled = true;
  try {
    await api('/admin/overview/logout', { method: 'POST' });
  } finally {
    data = null;
    await load();
  }
}

// Søket gjelder tittel, sted, arrangør, nettsted og lenkene (også aliasene).
function matches(event) {
  if (!filter) return true;
  const site = data.sites.find((s) => s.id === event.site);
  const text = [event.title, event.location, event.organizerName, event.organizerEmail, site?.label, event.url, ...event.aliases]
    .join(' ').toLowerCase();
  return filter.split(/\s+/).every((word) => text.includes(word));
}

function render() {
  const { events, deleteAfterDays } = data;
  const active = events.filter((e) => !e.ended);
  // Avsluttede: sist avsluttet først – de som snart slettes, havner nederst.
  const ended = events.filter((e) => e.ended).reverse();
  const shownActive = active.filter(matches);
  const shownEnded = ended.filter(matches);

  const search = h('input', {
    type: 'search', id: 'overview-filter', value: filter, placeholder: t('overview.filterPlaceholder'),
    autocomplete: 'off', 'aria-label': t('overview.filterLabel'),
  });
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    render();
    const again = document.getElementById('overview-filter');
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });

  const refresh = h('button', { class: 'btn secondary small', type: 'button' }, t('overview.refresh'));
  // «Logg ut» bare når innloggingen var med passord – en nøkkel i lenken eller Access logges ikke ut her.
  const logoutButton = data.via === 'password' ? h('button', { class: 'btn secondary small', type: 'button' }, t('overview.logout')) : null;
  logoutButton?.addEventListener('click', () => logout(logoutButton));
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    await load();
  });

  const registered = active.reduce((sum, e) => sum + e.count, 0);
  const endedCard = h('details', { class: 'card section' },
    h('summary', {}, t('overview.endedHeading', { count: ended.length })),
    h('p', { class: 'muted small' }, t('overview.endedNote', { days: deleteAfterDays })),
    shownEnded.length ? table(shownEnded, { ended: true }) : h('p', { class: 'muted' }, ended.length ? t('overview.noMatch') : t('overview.noEnded')));
  // Søker man, åpnes de avsluttede, så treff der ikke blir skjult.
  if (filter && shownEnded.length) endedCard.open = true;

  app.replaceChildren(
    h('p', { class: 'kicker' }, t('overview.kicker')),
    h('h1', {}, t('overview.title')),
    h('section', { class: 'card' },
      h('div', { class: 'stats' },
        stat(active.length, t('overview.statActive', { count: active.length })),
        stat(registered, t('overview.statRegistered', { count: registered })),
        stat(active.filter((e) => e.status === 'open').length, t('overview.statOpen')),
        stat(active.filter((e) => e.cancelledAt).length, t('overview.statCancelled'))),
      h('div', { class: 'actions overview-tools' },
        search,
        refresh,
        h('a', { class: 'btn small', href: '/admin/ny' }, t('overview.newEvent')),
        logoutButton),
      h('p', { class: 'muted small' }, t('overview.adminLinksNote'))),
    h('section', { class: 'card' },
      h('h2', {}, t('overview.activeHeading', { count: active.length })),
      shownActive.length ? table(shownActive, { ended: false }) : h('p', { class: 'muted' }, active.length ? t('overview.noMatch') : t('overview.noActive'))),
    endedCard,
  );
}

function stat(value, name) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'name' }, name));
}

function table(events, { ended }) {
  const tz = data.timeZone;
  // Nettsted-kolonnen trengs bare med flere nettsteder.
  const manySites = data.sites.length > 1;
  // På smal skjerm blir hver rad et kort, og kolonnenavnet står foran verdien (data-label, se style.css).
  const cell = (label, attrs, ...children) => h('td', { ...attrs, 'data-label': t(label) }, ...children);
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'overview-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, t('overview.columnEvent')),
        h('th', {}, t('overview.columnTime')),
        manySites ? h('th', {}, t('overview.columnSite')) : null,
        h('th', {}, t('overview.columnRegistered')),
        h('th', {}, t('overview.columnStatus')),
        h('th', {}, t('overview.columnOrganizer')),
        ended ? h('th', {}, t('overview.columnDeleteAt')) : null)),
      h('tbody', {}, events.map((e) => h('tr', {},
        h('td', { class: 'title-cell' },
          h('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.title),
          e.location ? h('span', { class: 'by' }, e.location) : null,
          e.aliases.map((url) => h('a', { class: 'by alias', href: url, target: '_blank', rel: 'noopener' }, url.replace(/^https?:\/\//, '')))),
        cell('overview.columnTime', { class: 'small' }, formatEventTime(e.startsAt, e.endsAt, tz)),
        manySites ? cell('overview.columnSite', { class: 'small' }, data.sites.find((s) => s.id === e.site)?.label ?? e.site) : null,
        cell('overview.columnRegistered', { class: 'num-cell' },
          h('strong', {}, e.capacity != null ? t('overview.countOf', { count: e.count, capacity: e.capacity }) : e.count),
          h('span', { class: 'by' }, t('overview.bookings', { count: e.bookings })),
          e.checkedIn != null && e.checkedIn > 0 ? h('span', { class: 'by' }, t('overview.checkedIn', { count: e.checkedIn })) : null),
        cell('overview.columnStatus', {}, h('span', { class: `badge ${e.status === 'open' ? '' : 'closed'}` }, t(`admin.state.${e.status}`))),
        cell('overview.columnOrganizer', { class: 'small' },
          e.organizerName,
          h('a', { class: 'by email', href: `mailto:${e.organizerEmail}` }, e.organizerEmail)),
        ended ? cell('overview.columnDeleteAt', { class: 'small' }, formatShort(e.deleteAt, tz)) : null)))));
}

load();

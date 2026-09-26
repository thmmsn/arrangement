import { api, copyToClipboard, h, notice } from './common.js';
import { createEventForm } from './event-form.js';

const root = document.getElementById('form-root');
const STORAGE_KEY = 'booking-admin-password';

function storedPassword() {
  try { return sessionStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

const password = h('input', { id: 'adminPassword', name: 'adminPassword', type: 'password', autocomplete: 'current-password', value: storedPassword() });

// Admin-oppsettet: tidssone, om passord kreves, og hvem som er logget inn via Cloudflare Access.
let adminConfig;
try {
  adminConfig = await api('/admin/config');
} catch (err) {
  root.replaceChildren(notice('error', err.message));
  throw err;
}
const { timeZone, passwordRequired, accessEmail } = adminConfig;

const { form } = createEventForm({
  timeZone,
  // Innlogget via Access: foreslå den e-postadressen som arrangør.
  initial: accessEmail ? { organizerEmail: accessEmail } : {},
  submitLabel: 'Opprett arrangement',
  prepend: [
    passwordRequired
      ? h('div', { class: 'card' },
        h('div', { class: 'form-row', 'data-error-for': 'adminPassword' },
          h('label', { for: 'adminPassword' }, 'Administratorpassord',
            h('span', { class: 'hint' }, 'Passordet som er satt i ADMIN_PASSWORD på serveren.')),
          password))
      : null,
    accessEmail ? h('p', { class: 'muted small' }, `Logget inn som ${accessEmail} via Cloudflare Access.`) : null,
  ].filter(Boolean),
  async onSubmit(payload) {
    try {
      const headers = passwordRequired ? { 'X-Admin-Password': password.value } : {};
      const result = await api('/admin/events', { method: 'POST', body: payload, headers });
      if (passwordRequired) {
        try { sessionStorage.setItem(STORAGE_KEY, password.value); } catch { /* ikke viktig */ }
      }
      showResult(result, payload);
    } catch (err) {
      if (err.status === 401) err.errors = { adminPassword: err.message };
      throw err;
    }
  },
});
root.append(form);

function linkBox(label, url, hint) {
  const field = h('input', { type: 'text', value: url, readOnly: true, 'aria-label': label });
  field.addEventListener('focus', () => field.select());
  const copy = h('button', { class: 'btn secondary small', type: 'button' }, 'Kopier');
  copy.addEventListener('click', () => copyToClipboard(url, copy));
  return h('div', { class: 'form-row' },
    h('span', { class: 'label' }, label, hint ? h('span', { class: 'hint' }, hint) : null),
    h('div', { class: 'linkbox' }, field, copy));
}

function showResult(result, payload) {
  document.querySelector('h1').textContent = 'Arrangementet er klart';
  document.querySelector('#app > p.muted')?.remove();
  root.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, payload.title),
      linkBox('Påmeldingslenke', result.eventUrl, 'Del denne med dem som skal kunne melde seg på.'),
      linkBox('Administrasjonslenke', result.adminUrl, 'Gir tilgang til listen over påmeldte og redigering. Ikke del den!'),
      notice('warning',
        h('strong', {}, 'Ta vare på administrasjonslenken. '),
        'Den vises bare denne ene gangen, og kan ikke gjenopprettes.',
        result.emailSent ? ` Vi har også sendt den til ${payload.organizerEmail}.` : ' E-posten med lenken kunne ikke sendes, så kopier den nå.'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: result.eventUrl }, 'Åpne arrangementet'),
        h('a', { class: 'btn secondary', href: result.adminUrl }, 'Gå til administrasjon'),
        h('a', { class: 'btn secondary', href: '/admin/ny' }, 'Opprett et nytt'),
      ),
    ),
  );
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

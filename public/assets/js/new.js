import { api, copyToClipboard, h, notice, t } from './common.js';
import { createEventForm } from './event-form.js';

const root = document.getElementById('form-root');
const STORAGE_KEY = 'booking-admin-password';

function storedPassword() {
  try { return sessionStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

const password = h('input', { id: 'adminPassword', name: 'adminPassword', type: 'password', autocomplete: 'current-password', value: storedPassword() });

// Admin-oppsettet: tidssone, nettsteder, om passord kreves, og hvem som er logget inn via Cloudflare Access.
let adminConfig;
try {
  adminConfig = await api('/admin/config');
} catch (err) {
  root.replaceChildren(notice('error', err.message));
  throw err;
}
const { timeZone, passwordRequired, accessEmail, sites } = adminConfig;

const { form } = createEventForm({
  timeZone,
  sites,
  // Innlogget via Access: foreslå den e-postadressen som arrangør.
  initial: accessEmail ? { organizerEmail: accessEmail } : {},
  submitLabel: t('create.submit'),
  prepend: [
    passwordRequired
      ? h('div', { class: 'card' },
        h('div', { class: 'form-row', 'data-error-for': 'adminPassword' },
          h('label', { for: 'adminPassword' }, t('create.passwordLabel'),
            h('span', { class: 'hint' }, t('create.passwordHint'))),
          password))
      : null,
    accessEmail ? h('p', { class: 'muted small' }, t('create.loggedInAs', { email: accessEmail })) : null,
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
  const copy = h('button', { class: 'btn secondary small', type: 'button' }, t('common.copy'));
  copy.addEventListener('click', () => copyToClipboard(url, copy));
  return h('div', { class: 'form-row' },
    h('span', { class: 'label' }, label, hint ? h('span', { class: 'hint' }, hint) : null),
    h('div', { class: 'linkbox' }, field, copy));
}

function showResult(result, payload) {
  document.querySelector('h1').textContent = t('create.ready');
  document.querySelector('#app > p.muted')?.remove();
  root.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, payload.title),
      linkBox(t('create.eventLink'), result.eventUrl, t('create.eventLinkHint')),
      linkBox(t('create.adminLink'), result.adminUrl, t('create.adminLinkHint')),
      notice('warning',
        h('strong', {}, `${t('create.keepWarning')} `),
        t('create.keepWarningText'),
        ` ${result.emailSent ? t('create.emailSentTo', { email: payload.organizerEmail }) : t('create.emailFailed')}`),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: result.eventUrl }, t('create.openEvent')),
        h('a', { class: 'btn secondary', href: result.adminUrl }, t('create.goAdmin')),
        h('a', { class: 'btn secondary', href: '/admin/ny' }, t('create.createAnother')),
      ),
    ),
  );
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

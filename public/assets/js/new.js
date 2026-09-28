import { api, copyToClipboard, h, notice, t, uploadImage } from './common.js';
import { createEventForm } from './event-form.js';

const root = document.getElementById('form-root');

// Admin-oppsettet: tidssone, nettsteder og hvem som er logget inn via Cloudflare Access.
let adminConfig;
try {
  adminConfig = await api('/admin/config');
} catch (err) {
  root.replaceChildren(notice('error', err.message));
  throw err;
}
const { timeZone, accessEmail, sites, wallets, skins } = adminConfig;

const { form } = createEventForm({
  timeZone,
  sites,
  wallets,
  skins,
  // Innlogget via Access: foreslå den e-postadressen som arrangør.
  initial: accessEmail ? { organizerEmail: accessEmail } : {},
  submitLabel: t('create.submit'),
  async onSubmit(payload, { image }) {
    const result = await api('/admin/events', { method: 'POST', body: payload });
    // Arrangementet er opprettet selv om bildet skulle feile – da vises en advarsel.
    let imageError = null;
    if (image.upload) {
      try {
        await uploadImage(result.slug, result.adminKey, image.upload);
      } catch (err) {
        imageError = err.message;
      }
    }
    showResult(result, payload, imageError);
  },
});
root.append(form);

function linkBox(label, url) {
  const field = h('input', { type: 'text', value: url, readOnly: true, 'aria-label': label });
  field.addEventListener('focus', () => field.select());
  const copy = h('button', { class: 'btn secondary small', type: 'button' }, t('common.copy'));
  copy.addEventListener('click', () => copyToClipboard(url, copy));
  return h('div', { class: 'form-row' },
    h('span', { class: 'label' }, label),
    h('div', { class: 'linkbox' }, field, copy));
}

function showResult(result, payload, imageError) {
  document.querySelector('h1').textContent = t('create.ready');
  root.replaceChildren(
    h('div', { class: 'card' },
      imageError ? notice('error', imageError) : null,
      h('h2', {}, payload.title),
      linkBox(t('create.eventLink'), result.eventUrl),
      linkBox(t('create.adminLink'), result.adminUrl),
      result.scannerUrl ? linkBox(t('admin.scannerHeading'), result.scannerUrl) : null,
      notice('warning',
        h('strong', {}, `${t('create.keepWarning')} `),
        t('create.keepWarningText'),
        ` ${result.emailSent ? t('create.emailSentTo', { email: payload.organizerEmail }) : t('create.emailFailed')}`),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: result.eventUrl }, t('create.openEvent')),
        // Relativ: blir på samme vertsnavn og port (admin-vertsnavnet, eller LAN). Kopifeltene over
        // viser de offentlige lenkene – det er dem som deles videre.
        h('a', { class: 'btn secondary', href: `/admin/${result.slug}#${result.adminKey}` }, t('create.goAdmin')),
        h('a', { class: 'btn secondary', href: '/admin/ny' }, t('create.createAnother')),
      ),
    ),
  );
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

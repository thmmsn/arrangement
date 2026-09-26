import { api, formatEventTime, h, notice, secretFromHash, slugFromPath } from './common.js';

const app = document.getElementById('app');
const slug = slugFromPath();
const token = secretFromHash();

async function load() {
  let info;
  try {
    if (!token) throw new Error('Lenken mangler avmeldingskoden. Bruk lenken fra bekreftelses-e-posten.');
    info = await api(`/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } });
  } catch (err) {
    app.replaceChildren(h('p', { class: 'kicker' }, 'Avmelding'), h('h1', {}, 'Fant ikke påmeldingen'), h('p', {}, err.message),
      h('p', {}, h('a', { href: `/${slug}` }, 'Gå til arrangementet')));
    return;
  }

  const { event, name } = info;
  document.title = `Avmelding: ${event.title}`;
  const status = h('div');
  const button = h('button', { class: 'btn', type: 'button' }, 'Ja, meld meg av');

  // Avmeldingen skjer først når gjesten trykker på knappen – ikke når lenken åpnes.
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/events/${slug}/cancel`, { method: 'POST', body: { token } });
      card.replaceChildren(
        h('h2', {}, 'Du er meldt av'),
        h('p', {}, 'Takk for at du ga beskjed. Arrangøren har fått melding.'),
        h('a', { class: 'btn secondary', href: `/${slug}` }, 'Tilbake til arrangementet'));
    } catch (err) {
      status.replaceChildren(notice('error', err.message));
      button.disabled = false;
    }
  });

  const card = h('section', { class: 'card' },
    status,
    h('p', {}, `Hei ${name}! Vil du melde deg av dette arrangementet?`),
    h('div', { class: 'actions' }, button, h('a', { class: 'btn secondary', href: `/${slug}` }, 'Nei, behold plassen')));

  app.replaceChildren(
    h('p', { class: 'kicker' }, 'Avmelding'),
    h('h1', {}, event.title),
    h('p', { class: 'muted' }, formatEventTime(event.startsAt, event.endsAt, event.timeZone), event.location ? ` · ${event.location}` : ''),
    card,
  );
}

load();

import { api, formatEventTime, h, notice, secretFromHash, slugFromPath } from './common.js';

const app = document.getElementById('app');
const slug = slugFromPath();
const token = secretFromHash();

const nameList = (persons) => new Intl.ListFormat('nb', { type: 'conjunction' }).format(persons.map((p) => p.name));

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

  const { event } = info;
  document.title = `Avmelding: ${event.title}`;
  const card = h('section', { class: 'card' });
  app.replaceChildren(
    h('p', { class: 'kicker' }, 'Avmelding'),
    h('h1', {}, event.title),
    h('p', { class: 'muted' }, formatEventTime(event.startsAt, event.endsAt, event.timeZone), event.location ? ` · ${event.location}` : ''),
    card,
  );
  renderChoice(card, info.contactName, info.persons);
}

// Avmeldingen skjer først når gjesten trykker på knappen – ikke når lenken åpnes.
function renderChoice(card, contactName, persons, message = null) {
  const status = h('div');
  const several = persons.length > 1;

  // Ved flere personer velger man hvem som skal meldes av. Alle er valgt på forhånd.
  const boxes = persons.map((person) => {
    const box = h('input', { type: 'checkbox', checked: true, value: person.id });
    return { person, box };
  });

  const button = h('button', { class: 'btn', type: 'button' });
  const updateButton = () => {
    const n = boxes.filter((b) => b.box.checked).length;
    button.textContent = !several ? 'Ja, meld meg av' : n === persons.length ? 'Meld av alle' : `Meld av ${n} ${n === 1 ? 'person' : 'personer'}`;
    button.disabled = n === 0;
  };
  boxes.forEach((b) => b.box.addEventListener('change', updateButton));
  updateButton();

  button.addEventListener('click', async () => {
    const ids = boxes.filter((b) => b.box.checked).map((b) => b.person.id);
    button.disabled = true;
    try {
      const result = await api(`/events/${slug}/cancel`, { method: 'POST', body: { token, ids } });
      if (result.remaining.length) {
        // Noen står fortsatt på listen – vis dem, så resten også kan meldes av senere.
        renderChoice(card, contactName, result.remaining,
          notice('success', `${nameList(result.cancelled)} er meldt av. Arrangøren har fått melding.`));
      } else {
        card.replaceChildren(
          h('h2', {}, several ? 'Alle er meldt av'
            : persons[0].name === contactName ? 'Du er meldt av' : `${persons[0].name} er meldt av`),
          h('p', {}, 'Takk for at du ga beskjed. Arrangøren har fått melding.'),
          h('a', { class: 'btn secondary', href: `/${slug}` }, 'Tilbake til arrangementet'));
      }
    } catch (err) {
      status.replaceChildren(notice('error', err.message));
      button.disabled = false;
    }
  });

  // replaceChildren skriver «null» som tekst, så tomme deler filtreres bort.
  card.replaceChildren(...[
    message,
    status,
    several
      ? [
        h('p', {}, `Hei ${contactName}! Hvem skal meldes av?`),
        h('div', { class: 'choice-list' },
          boxes.map(({ person, box }) => h('label', { class: 'checkbox' }, box, h('span', {}, person.name)))),
      ]
      : h('p', {}, persons[0].name === contactName
        ? `Hei ${contactName}! Vil du melde deg av dette arrangementet?`
        : `Hei ${contactName}! Vil du melde av ${persons[0].name}?`),
    h('div', { class: 'actions' }, button, h('a', { class: 'btn secondary', href: `/${slug}` }, several ? 'Avbryt' : 'Nei, behold plassen')),
  ].flat().filter(Boolean));
}

load();

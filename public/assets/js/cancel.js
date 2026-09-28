import { api, formatEventTime, h, nameList, notice, secretFromHash, slugFromPath, t } from './common.js';

const app = document.getElementById('app');
const slug = slugFromPath();
const token = secretFromHash();

const names = (persons) => nameList(persons.map((p) => p.name));

async function load() {
  let info;
  try {
    if (!token) throw new Error(t('cancel.missingToken'));
    info = await api(`/events/${slug}/cancel/lookup`, { method: 'POST', body: { token } });
  } catch (err) {
    app.replaceChildren(h('p', { class: 'kicker' }, t('cancel.title')), h('h1', {}, t('cancel.notFound')), h('p', {}, err.message),
      h('p', {}, h('a', { href: `/${slug}` }, t('cancel.toEvent'))));
    return;
  }

  const { event } = info;
  document.title = t('cancel.documentTitle', { title: event.title });
  const card = h('section', { class: 'card' });
  app.replaceChildren(
    h('p', { class: 'kicker' }, t('cancel.title')),
    h('h1', {}, event.title),
    h('p', { class: 'muted' }, formatEventTime(event.startsAt, event.endsAt, event.timeZone), event.location ? ` · ${event.location}` : ''),
    card,
  );
  // En personlig lenke (videresendt av den som meldte på) åpnes av personen selv: «Vil du melde deg av?».
  renderChoice(card, info.personal ? info.persons[0].name : info.contactName, info.persons);
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
    button.textContent = !several ? t('cancel.buttonSelf')
      : n === persons.length ? t('cancel.buttonAll')
        : t('cancel.buttonSome', { count: n });
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
          notice('success', t('cancel.partialDone', { names: names(result.cancelled) })));
      } else {
        card.replaceChildren(
          h('h2', {}, several ? t('cancel.allDone')
            : persons[0].name === contactName ? t('cancel.selfDone') : t('cancel.otherDone', { name: persons[0].name })),
          h('p', {}, t('cancel.thanks')),
          h('a', { class: 'btn secondary', href: `/${slug}` }, t('cancel.back')));
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
        h('p', {}, t('cancel.whoQuestion', { name: contactName })),
        h('div', { class: 'choice-list' },
          boxes.map(({ person, box }) => h('label', { class: 'checkbox' }, box, h('span', {}, person.name)))),
      ]
      : h('p', {}, persons[0].name === contactName
        ? t('cancel.confirmSelf', { name: contactName })
        : t('cancel.confirmOther', { name: contactName, person: persons[0].name })),
    h('div', { class: 'actions' }, button,
      h('a', { class: 'btn secondary', href: `/${slug}` }, several ? t('cancel.abort') : t('cancel.keepSpot'))),
  ].flat().filter(Boolean));
}

load();

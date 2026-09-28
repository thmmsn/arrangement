// Felles for dørvaktvisningene (billettsiden i dørvaktmodus og skanneren): resultatet av en
// innsjekking som en stor farget flate, «Angre», resten av påmeldingen, og lyd/vibrasjon.
import { api, formatTime, h, t } from './common.js';

const TONES = { checked_in: 'ok', already: 'warn', undone: 'info', not_checked_in: 'info' };
const ICONS = { ok: '✓', warn: '!', info: '↺', bad: '✕' };

/**
 * @param {object} result   Svar fra /scanner/checkin eller /scanner/undo (eller en lokal etterligning)
 * @param {object} opts
 * @param {string} opts.slug        Arrangementet dørvakten er logget inn for
 * @param {string} [opts.timeZone]
 * @param {(result: object) => void} opts.onUpdate  Kalles med nytt resultat etter «Angre»
 * @param {string} [opts.note]      Ekstra linje (f.eks. «sjekket inn uten nett»)
 * @returns {Node[]}
 */
export function resultView(result, { slug, timeZone, onUpdate, note = '' }) {
  const tone = TONES[result.result] ?? 'bad';
  const title = {
    checked_in: t('scanner.checkedIn'),
    already: t('scanner.already'),
    undone: t('scanner.undone'),
    not_checked_in: t('scanner.undone'),
    wrong_event: t('scanner.wrongEventShort'),
    cancelled: t('status.cancelled'),
  }[result.result] ?? t('scanner.invalid');
  const person = result.person;
  const when = person?.checkedInAt && timeZone ? formatTime(person.checkedInAt, timeZone) : '';
  const detail = result.result === 'already' && when
    ? (person.checkedInBy ? t('scanner.alreadyBy', { time: when, name: person.checkedInBy }) : t('scanner.alreadyAt', { time: when }))
    : result.result === 'invalid' ? t('scanner.invalidText')
      : result.result === 'wrong_event' ? result.error
        : '';

  const nodes = [h('section', { class: `scan-result ${tone}`, role: 'status', 'aria-live': 'assertive' },
    h('div', { class: 'scan-icon', 'aria-hidden': 'true' }, ICONS[tone]),
    h('h2', {}, title),
    person ? h('p', { class: 'scan-name' }, person.name) : null,
    person?.bookedBy ? h('p', { class: 'small' }, t('scanner.bookedBy', { name: person.bookedBy })) : null,
    detail ? h('p', {}, detail) : null,
    note ? h('p', { class: 'small' }, note) : null,
  )];

  if (result.result === 'checked_in' && person?.id && !result.offline) {
    const undo = h('button', { class: 'btn secondary', type: 'button' }, t('scanner.undo'));
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        onUpdate(await api(`/events/${slug}/scanner/undo`, { method: 'POST', body: { id: person.id } }));
      } catch (err) {
        undo.disabled = false;
        alert(err.message);
      }
    });
    nodes.push(h('div', { class: 'actions' }, undo));
  }

  // De andre i samme påmelding som ikke er inne ennå: en familie kommer ofte samlet.
  const waiting = (result.companions ?? []).filter((c) => !c.checkedInAt);
  if (waiting.length) {
    nodes.push(h('section', { class: 'card companions' },
      h('h3', {}, t('scanner.companions')),
      h('ul', {}, waiting.map((c) => {
        const button = h('button', { class: 'btn small', type: 'button' }, t('scanner.checkInButton'));
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api(`/events/${slug}/scanner/checkin`, { method: 'POST', body: { id: c.id } });
            button.replaceWith(h('span', { class: 'badge' }, t('scanner.checkedIn')));
            feedback(true);
          } catch (err) {
            button.disabled = false;
            alert(err.message);
          }
        });
        return h('li', {}, h('span', {}, c.name), button);
      }))));
  }
  return nodes;
}

let audio;
// Lyd og vibrasjon, så dørvakten ikke må se på skjermen for hver gjest: ett lyst pip = inn,
// to dype = stopp.
export function feedback(ok) {
  try {
    navigator.vibrate?.(ok ? 80 : [120, 80, 120]);
    audio ??= new AudioContext();
    const tone = (freq, start, length) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + start);
      osc.stop(audio.currentTime + start + length);
    };
    if (ok) tone(880, 0, 0.12);
    else {
      tone(220, 0, 0.18);
      tone(220, 0.25, 0.18);
    }
  } catch { /* lyd er ikke viktig */ }
}

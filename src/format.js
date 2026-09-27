// Datoer og svar formatert på nettstedets språk, for e-poster og CSV-eksport.
// Selve logikken deles med nettleseren (public/assets/i18n/format.js); her velges språket med en kode.
import * as shared from '../public/assets/i18n/format.js';
import { translator } from '../public/assets/i18n/index.js';

export const formatEventTime = (startsAt, endsAt, timeZone, lang) => shared.formatEventTime(startsAt, endsAt, timeZone, translator(lang));
export const formatDateTime = (iso, timeZone, lang) => shared.formatShort(iso, timeZone, translator(lang));
export const formatAnswer = (field, answers, lang) => shared.formatAnswer(field, answers, translator(lang));
export const nameList = (names, lang) => shared.nameList(names, translator(lang));

import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { adoptLegacyDatabase, createRepository, openDatabase } from './db.js';
import { createMailer } from './mailer.js';
import { PROVIDER_NAMES } from './mailConfig.js';
import { readVersion } from './version.js';

const config = loadConfig();
const legacy = adoptLegacyDatabase(config.databasePath);
if (legacy) console.log(`Databasen er flyttet fra ${legacy} til ${config.databasePath} (prosjektet heter nå «arrangement»).`);
const db = openDatabase(config.databasePath);
const repo = createRepository(db);
const mailer = createMailer({ ...config.mail, from: config.emailFrom });
const version = readVersion();
const app = createApp({ repo, mailer, config, version });
if (!version) console.warn('ADVARSEL: VERSION mangler eller har feil format (år.måned.dag.løpenummer) – ingen versjon vises på sidene.');

for (const warning of config.warnings) console.warn(`ADVARSEL: ${warning}`);
const accessEnabled = Boolean(config.cfAccessTeamDomain && config.cfAccessAudiences.length);
// Hvem som kan opprette arrangementer. Administrasjonen av ett arrangement krever bare admin-nøkkelen.
const creators = [
  config.createKey && 'opprettingsnøkkelen (CREATE_KEY, /admin/ny#<nøkkel>)',
  accessEnabled && `Cloudflare Access (${config.cfAccessTeamDomain})`,
  config.lanPort && `LAN-porten ${config.lanPort}`,
].filter(Boolean);
if (!accessEnabled && !config.createKey && config.adminNoAuth) {
  console.warn('ADVARSEL: ADMIN_NO_AUTH=true – alle som når /admin kan opprette arrangementer. Bare for lokal utvikling!');
} else if (!creators.length) {
  console.warn('ADVARSEL: Verken CREATE_KEY eller Cloudflare Access (CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD) er satt opp – ingen kan opprette nye arrangementer.');
} else {
  console.log(`Nye arrangementer kan opprettes med ${creators.join(', ')}.`);
}
console.log('Hvert arrangement administreres med sin egen admin-lenke (/admin/<hash>#<nøkkel>) – den krever bare nøkkelen.');
// Oversikten: hvordan eieren har valgt å beskytte den (OVERVIEW_AUTH). Med ADMIN_HOST finnes den bare der.
const OVERVIEW_METHOD_TEXT = {
  key: 'nøkkelen (/admin#<OVERVIEW_KEY>)',
  password: 'brukernavn og passord (OVERVIEW_USER/OVERVIEW_PASSWORD)',
  access: 'Cloudflare Access',
  lan: `LAN-porten ${config.lanPort}`,
  none: 'uten innlogging',
};
if (config.overview.methods.length) {
  const where = config.adminHost ? ` på ${config.adminHost}${config.lanPort ? ' og LAN-porten' : ''}` : '';
  const how = config.overview.methods.map((m) => OVERVIEW_METHOD_TEXT[m]).join(' eller ');
  console.log(`Oversikten over alle arrangementer (/admin)${where}: ${how}.`);
}
if (config.adminHost) {
  console.log(`Oppretting (/admin/ny) svarer bare på https://${config.adminHost}/admin/ny`);
}
const mailNames = config.mail.providers.map((p) => PROVIDER_NAMES[p.id]);
if (config.mail.unavailable) {
  console.error(`ADVARSEL: E-post kan IKKE sendes – ${config.mail.unavailable}`);
} else if (!mailNames.length) {
  console.warn('ADVARSEL: Ingen e-posttjeneste er satt opp (MAIL_PROVIDER) – e-poster skrives til konsollen i stedet for å sendes.');
} else {
  console.log(`E-post sendes via ${mailNames[0]}${mailNames.length > 1 ? ` (reserve: ${mailNames.slice(1).join(', ')})` : ''}.`);
  // Sjekker innlogging og tilkobling (Microsoft 365 og SMTP) med en gang, så feil oppsett vises i loggen
  // ved oppstart og ikke først når noen melder seg på.
  mailer.verify().then((results) => {
    for (const { provider, ok, message } of results) {
      if (ok === true) console.log(`E-post via ${PROVIDER_NAMES[provider]}: ${message}.`);
      if (ok === false) console.error(`ADVARSEL: E-post via ${PROVIDER_NAMES[provider]} virker ikke: ${message}`);
    }
  });
}

// Uten oppsett vises ingen Wallet-knapper – verken etter påmelding, på billettsiden eller i e-posten.
for (const [key, name, prefix] of [['apple', 'Apple Wallet', 'APPLE_WALLET_*'], ['google', 'Google Wallet', 'GOOGLE_WALLET_*']]) {
  if (config.wallet[key]) console.log(`${name} er i bruk.`);
  else console.warn(`ADVARSEL: ${name} er av (${prefix} er ikke satt opp) – ingen «${name}»-knapper vises. Se README, «Wallet».`);
}

if (!config.adminEmails.length) {
  console.warn('ADVARSEL: ADMIN_EMAIL er ikke satt – ingen tjenesteadministrator får beskjed når arrangementer opprettes eller avlyses.');
}
console.log(`Data om et arrangement slettes ${config.deleteAfterDays} dager etter at det er over.`);

if (!config.adminHost) {
  console.warn('ADVARSEL: ADMIN_HOST er ikke satt – /admin/ny finnes da på de offentlige domenene. Sett ADMIN_HOST for å lukke dem helt.');
}

// Arrangementer som hører til et nettsted som ikke lenger er satt opp, vises på hovednettstedet.
const knownSites = new Set(config.sites.map((site) => site.id));
for (const [site, count] of Object.entries(repo.countEventsBySite())) {
  if (!knownSites.has(site)) {
    console.warn(`ADVARSEL: ${count} arrangement(er) hører til nettstedet «${site}», som ikke er satt opp. De vises på hovednettstedet.`);
  }
}

// Vedlikehold hvert tiende minutt: rapport til arrangøren når påmeldingsfristen er nådd,
// sletting av arrangementer som var over for mer enn DELETE_AFTER_DAYS dager siden, og delingsbilde
// for forsidebilder lastet opp før det fantes.
async function maintenance() {
  try {
    const { reported, deleted, ogImages } = await app.runMaintenance();
    if (reported.length) console.log(`Rapport sendt ved påmeldingsfristen: ${reported.join(', ')}`);
    if (deleted.length) console.log(`Slettet ${deleted.length} arrangement(er) som var over: ${deleted.join(', ')}`);
    if (ogImages) console.log(`Laget delingsbilde (og:image) for ${ogImages} eksisterende forsidebilde(r).`);
  } catch (err) {
    console.error('Vedlikehold feilet:', err);
  }
}
maintenance();
const maintenanceTimer = setInterval(maintenance, 10 * 60_000);

const server = app.listen(config.port, () => {
  for (const site of config.sites) {
    const root = site.rootRedirect ? `forsiden sendes til ${site.rootRedirect}` : 'forsiden gir 404';
    console.log(`Nettsted «${site.id}»: ${site.baseUrl} (${site.lang}), e-post fra ${site.emailFrom}, ${root}`);
  }
  console.log(`Arrangement ${version ?? '(ukjent versjon)'} kjører på port ${config.port}`);
});

// Betrodd LAN-port (LAN_PORT): samme app og database, men alt som kommer inn her er betrodd – admin
// uten ADMIN_HOST og Access, og ingen rate limiting. Tilliten følger porten, ikke headere.
let lanServer = null;
if (config.lanPort) {
  lanServer = http.createServer(app.lanHandler);
  lanServer.listen(config.lanPort, () => {
    console.warn([
      `ADVARSEL: LAN-porten ${config.lanPort} er BETRODD. Alle som når den, kan opprette arrangementer`,
      '  – uten Cloudflare Access, uten CREATE_KEY, uten ADMIN_HOST og uten rate limiting.',
      `  Port ${config.lanPort} må ALDRI rutes gjennom Cloudflare-tunnelen eller publiseres mot internett.`,
      `  Tunnelen skal fortsatt gå til port ${config.port}. Publiser LAN-porten bare på kontorets nett.`,
      `  Nettsted på LAN: velges fra Host, eller med ?site=<id> (${config.sites.map((site) => site.id).join(', ')}).`,
    ].join('\n'));
  });
}

// Avslutt pent (f.eks. ved ny deploy), slik at SQLite får lukket filen ordentlig.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(maintenanceTimer);
    // Begge lytterne lukkes før databasen, så ingen forespørsel treffer en lukket database.
    Promise.all([server, lanServer].filter(Boolean).map((s) => new Promise((resolve) => s.close(resolve)))).then(() => {
      db.close();
      process.exit(0);
    });
  });
}

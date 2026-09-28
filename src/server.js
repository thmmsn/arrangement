import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { adoptLegacyDatabase, createRepository, openDatabase } from './db.js';
import { createMailer } from './email.js';

const config = loadConfig();
const legacy = adoptLegacyDatabase(config.databasePath);
if (legacy) console.log(`Databasen er flyttet fra ${legacy} til ${config.databasePath} (prosjektet heter nå «arrangement»).`);
const db = openDatabase(config.databasePath);
const repo = createRepository(db);
const mailer = createMailer({ apiKey: config.resendApiKey, from: config.emailFrom });
const app = createApp({ repo, mailer, config });

for (const warning of config.warnings) console.warn(`ADVARSEL: ${warning}`);
const accessEnabled = Boolean(config.cfAccessTeamDomain && config.cfAccessAudiences.length);
if (!accessEnabled && config.adminNoAuth) {
  console.warn('ADVARSEL: ADMIN_NO_AUTH=true – alle som når /admin kan opprette arrangementer. Bare for lokal utvikling!');
} else if (!accessEnabled) {
  console.warn('ADVARSEL: Cloudflare Access er ikke satt opp (CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD) – ingen kan opprette nye arrangementer.');
}
if (config.cfAccessTeamDomain) {
  console.log(`Admin krever Cloudflare Access (${config.cfAccessTeamDomain}).`);
}
if (config.adminHost) {
  console.log(`Admin svarer bare på https://${config.adminHost}/admin`);
}
if (!config.resendApiKey) {
  console.warn('ADVARSEL: RESEND_API_KEY er ikke satt – e-poster skrives til konsollen i stedet for å sendes.');
}

if (!config.adminEmails.length) {
  console.warn('ADVARSEL: ADMIN_EMAIL er ikke satt – ingen tjenesteadministrator får beskjed når arrangementer opprettes eller avlyses.');
}
console.log(`Data om et arrangement slettes ${config.deleteAfterDays} dager etter at det er over.`);

if (!config.adminHost) {
  console.warn('ADVARSEL: ADMIN_HOST er ikke satt – /admin finnes da på de offentlige domenene. Sett ADMIN_HOST for å lukke dem helt.');
}

// Arrangementer som hører til et nettsted som ikke lenger er satt opp, vises på hovednettstedet.
const knownSites = new Set(config.sites.map((site) => site.id));
for (const [site, count] of Object.entries(repo.countEventsBySite())) {
  if (!knownSites.has(site)) {
    console.warn(`ADVARSEL: ${count} arrangement(er) hører til nettstedet «${site}», som ikke er satt opp. De vises på hovednettstedet.`);
  }
}

// Vedlikehold hvert tiende minutt: rapport til arrangøren når påmeldingsfristen er nådd, og
// sletting av arrangementer som var over for mer enn DELETE_AFTER_DAYS dager siden.
async function maintenance() {
  try {
    const { reported, deleted } = await app.runMaintenance();
    if (reported.length) console.log(`Rapport sendt ved påmeldingsfristen: ${reported.join(', ')}`);
    if (deleted.length) console.log(`Slettet ${deleted.length} arrangement(er) som var over: ${deleted.join(', ')}`);
  } catch (err) {
    console.error('Vedlikehold feilet:', err);
  }
}
maintenance();
const maintenanceTimer = setInterval(maintenance, 10 * 60_000);

const server = app.listen(config.port, () => {
  for (const site of config.sites) {
    console.log(`Nettsted «${site.id}»: ${site.baseUrl} (${site.lang})`);
  }
  console.log(`Arrangement kjører på port ${config.port}`);
});

// Avslutt pent (f.eks. ved ny deploy), slik at SQLite får lukket filen ordentlig.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(maintenanceTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

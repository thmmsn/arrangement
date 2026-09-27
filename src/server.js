import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createRepository, openDatabase } from './db.js';
import { createMailer } from './email.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const repo = createRepository(db);
const mailer = createMailer({ apiKey: config.resendApiKey, from: config.emailFrom });
const app = createApp({ repo, mailer, config });

for (const warning of config.warnings) console.warn(`ADVARSEL: ${warning}`);
if (!config.adminPassword && !(config.cfAccessTeamDomain && config.cfAccessAudiences.length)) {
  console.warn('ADVARSEL: verken ADMIN_PASSWORD eller Cloudflare Access er satt opp – ingen kan opprette nye arrangementer.');
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

const server = app.listen(config.port, () => {
  for (const site of config.sites) {
    console.log(`Nettsted «${site.id}»: ${site.baseUrl} (${site.lang})`);
  }
  console.log(`Booking kjører på port ${config.port}`);
});

// Avslutt pent (f.eks. ved ny deploy), slik at SQLite får lukket filen ordentlig.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

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

const server = app.listen(config.port, () => {
  console.log(`Booking kjører på ${config.baseUrl} (port ${config.port})`);
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

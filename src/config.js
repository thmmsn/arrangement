// All konfigurasjon leses fra miljøvariabler (se .env.example).

export function loadConfig(env = process.env) {
  const port = Number(env.PORT) || 3000;

  return {
    port,
    // Offentlig adresse, brukes til å bygge lenker i e-poster, f.eks. https://booking.domain.com
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    databasePath: env.DATABASE_PATH || 'data/booking.db',
    // Passordet som kreves for å opprette nye arrangementer. Tomt = oppretting er slått av.
    adminPassword: env.ADMIN_PASSWORD || '',
    // Uten nøkkel skrives e-postene til konsollen i stedet for å sendes (nyttig i utvikling).
    resendApiKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || 'Påmelding <booking@example.com>',
    // Tidssonen arrangementstider vises i, uavhengig av hvor gjesten befinner seg.
    timeZone: env.TIME_ZONE || 'Europe/Oslo',
    // Sett til f.eks. 1 når appen kjører bak én reverse proxy (Caddy, nginx, Fly, Railway …),
    // slik at rate limiting ser klientens ekte IP-adresse.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

// All konfigurasjon leses fra miljøvariabler (se .env.example).

export function loadConfig(rawEnv = process.env) {
  const env = unquoteAll(rawEnv);
  const port = Number(env.PORT) || 3000;

  return {
    port,
    // Offentlig adresse, brukes til å bygge lenker i e-poster. BASE_URL vinner; ellers bygges den
    // fra DOMAIN (samme variabel som Caddy bruker i docker-compose), ellers localhost.
    baseUrl: (env.BASE_URL || (env.DOMAIN ? `https://${env.DOMAIN}` : `http://localhost:${port}`)).replace(/\/+$/, ''),
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

// `docker run --env-file` tar anførselstegn bokstavelig: EMAIL_FROM="Påmelding <a@b.no>" blir til
// en verdi som starter og slutter med ". Node (--env-file) og docker compose fjerner dem.
// For at .env skal virke likt uansett hvordan appen startes, fjernes ett par omsluttende
// anførselstegn her.
function unquoteAll(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const quoted = typeof value === 'string' && value.length >= 2 && /^(["']).*\1$/s.test(value);
    out[key] = quoted ? value.slice(1, -1) : value;
  }
  return out;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

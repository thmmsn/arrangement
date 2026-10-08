// Hvordan oversikten over alle arrangementer (/admin) beskyttes – eieren velger selv.
//
// Tilgangen gjelder også admin-siden for hvert arrangement (påmeldte, redigering, sletting): «Administrer»
// i oversikten åpner den med den samme tilgangen (se eventAdminGate i app.js).
//
// OVERVIEW_AUTH er en liste skilt med komma. Én av måtene holder:
//   key       nøkkelen etter # i lenken: /admin#<OVERVIEW_KEY>
//   password  brukernavn og passord i et skjema på siden (OVERVIEW_USER, valgfritt, og OVERVIEW_PASSWORD).
//             Innloggingen huskes i en informasjonskapsel i OVERVIEW_SESSION_DAYS dager (standard 30).
//   access    et gyldig Cloudflare Access-token (krever CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD)
//   lan       forespørsler som kommer inn på den betrodde LAN-porten (LAN_PORT)
//   none      ingen innlogging: alle som når /admin, ser oversikten
//
// Uten OVERVIEW_AUTH brukes det som er satt opp: key når OVERVIEW_KEY er satt, password når
// OVERVIEW_PASSWORD er satt. Er ingen av dem satt, finnes ikke oversikten.
//
// Appen avviser ingenting fordi det er «for svakt»: en kort nøkkel eller et kort passord gir bare en
// advarsel, og `none` er et lovlig valg. Det eieren ikke kan ha ment – en måte som mangler det den trenger,
// eller et ukjent ord – ignoreres med en advarsel.

export const OVERVIEW_METHODS = ['key', 'password', 'access', 'lan', 'none'];

const SHORT_KEY = 32;
const SHORT_PASSWORD = 12;

/**
 * @param {object} env  Miljøvariablene (allerede uten anførselstegn).
 * @param {object} opts
 * @param {boolean} opts.accessEnabled  Er CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD satt?
 * @param {number|null} opts.lanPort
 * @returns {{ methods: string[], key: string|null, user: string, password: string|null, sessionDays: number, warnings: string[] }}
 */
export function loadOverviewAuth(env, { accessEnabled = false, lanPort = null } = {}) {
  const warnings = [];
  const key = String(env.OVERVIEW_KEY ?? '').trim() || null;
  const user = String(env.OVERVIEW_USER ?? '').trim();
  // Passordet trimmes ikke: mellomrom kan være en del av det.
  const password = env.OVERVIEW_PASSWORD ? String(env.OVERVIEW_PASSWORD) : null;
  const sessionDays = parseSessionDays(env.OVERVIEW_SESSION_DAYS, warnings);

  const raw = String(env.OVERVIEW_AUTH ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const wanted = raw.length ? raw : [key && 'key', password && 'password'].filter(Boolean);

  const methods = [];
  for (const method of wanted) {
    if (!OVERVIEW_METHODS.includes(method)) {
      warnings.push(`OVERVIEW_AUTH: «${method}» er ukjent og ignoreres. Gyldige verdier: ${OVERVIEW_METHODS.join(', ')}.`);
    } else if (method === 'key' && !key) {
      warnings.push('OVERVIEW_AUTH: «key» ignoreres – OVERVIEW_KEY er ikke satt.');
    } else if (method === 'password' && !password) {
      warnings.push('OVERVIEW_AUTH: «password» ignoreres – OVERVIEW_PASSWORD er ikke satt.');
    } else if (method === 'access' && !accessEnabled) {
      warnings.push('OVERVIEW_AUTH: «access» ignoreres – CF_ACCESS_TEAM_DOMAIN og CF_ACCESS_AUD er ikke satt.');
    } else if (method === 'lan' && !lanPort) {
      warnings.push('OVERVIEW_AUTH: «lan» ignoreres – LAN_PORT er ikke satt.');
    } else if (!methods.includes(method)) {
      methods.push(method);
    }
  }

  // Råd, ikke regler: valget er eierens.
  if (methods.includes('key') && key.length < SHORT_KEY) {
    warnings.push(`OVERVIEW_KEY er bare ${key.length} tegn og kan være lett å gjette. En tilfeldig nøkkel fra \`openssl rand -hex 32\` er 64 tegn.`);
  }
  if (methods.includes('password') && password.length < SHORT_PASSWORD) {
    warnings.push(`OVERVIEW_PASSWORD er bare ${password.length} tegn og kan være lett å gjette.`);
  }
  if (methods.includes('none')) {
    warnings.push('OVERVIEW_AUTH=none: alle som når /admin, ser og kan administrere alle arrangementene (også påmeldte) – uten innlogging.');
  }
  return { methods, key, user, password, sessionDays, warnings };
}

function parseSessionDays(value, warnings) {
  if (value === undefined || String(value).trim() === '') return 30;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 3650) return n;
  warnings.push(`OVERVIEW_SESSION_DAYS=${JSON.stringify(value)} ignoreres: må være et helt antall dager fra 1 til 3650. Bruker 30.`);
  return 30;
}

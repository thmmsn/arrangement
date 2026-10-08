// Hvilken tjeneste e-posten sendes med, fra miljøvariabler (se .env.example og README, «Sette opp e-post»).
//
// MAIL_PROVIDER velger tjenesten: resend, cloudflare, microsoft eller smtp. Flere skilt med komma
// (cloudflare,microsoft) prøves i rekkefølge – den neste er reserve hvis den første feiler.
//
// Uten MAIL_PROVIDER brukes tjenesten som er satt opp (som før: RESEND_API_KEY alene gir Resend).
// Er ingen satt opp, skrives e-postene til konsollen (lokal utvikling).
//
// Er MAIL_PROVIDER satt, men ingen av tjenestene er brukbare (innstillinger mangler), skal appen ikke late
// som e-posten er sendt: da feiler hver sending, og gjesten får beskjed om at bekreftelsen ikke kom frem.

export const PROVIDER_NAMES = {
  resend: 'Resend',
  cloudflare: 'Cloudflare',
  microsoft: 'Microsoft 365',
  smtp: 'SMTP',
};

const ORDER = ['resend', 'cloudflare', 'microsoft', 'smtp'];

// Innstillingene hver tjeneste må ha. SMTP_PORT, SMTP_TLS, SMTP_USER og SMTP_PASSWORD er valgfrie.
const REQUIRED = {
  resend: ['RESEND_API_KEY'],
  cloudflare: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_TOKEN'],
  microsoft: ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  smtp: ['SMTP_HOST'],
};

const TLS_MODES = { starttls: 587, tls: 465, none: 25 };

/** @returns {{ providers: object[], unavailable: string, warnings: string[] }} */
export function loadMailConfig(env) {
  const warnings = [];
  const value = (key) => String(env[key] ?? '').trim();
  const missingOf = (id) => REQUIRED[id].filter((key) => !value(key));
  const configured = ORDER.filter((id) => missingOf(id).length === 0);

  let wanted;
  const raw = value('MAIL_PROVIDER').toLowerCase();
  if (raw) {
    wanted = [];
    for (const id of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!ORDER.includes(id)) warnings.push(`MAIL_PROVIDER: «${id}» er ukjent og ignoreres. Gyldige verdier: ${ORDER.join(', ')}.`);
      else if (wanted.includes(id)) warnings.push(`MAIL_PROVIDER: «${id}» står flere ganger; brukes bare én gang.`);
      else wanted.push(id);
    }
  } else {
    wanted = configured.slice(0, 1);
    if (configured.length > 1) {
      warnings.push(`E-post: flere tjenester er satt opp (${configured.join(', ')}), men MAIL_PROVIDER er ikke satt. Bruker ${configured[0]}. Sett MAIL_PROVIDER for å velge – f.eks. MAIL_PROVIDER=${configured.join(',')} for å ha de andre som reserve.`);
    }
  }

  const providers = [];
  for (const id of wanted) {
    const missing = missingOf(id);
    if (missing.length) {
      warnings.push(`E-post via ${PROVIDER_NAMES[id]} er slått av: ${missing.join(', ')} mangler.`);
      continue;
    }
    const provider = build(id, value, warnings, env);
    if (provider) providers.push(provider);
  }

  const unavailable = raw && !providers.length
    ? `ingen e-posttjeneste er brukbar (MAIL_PROVIDER=${value('MAIL_PROVIDER')}). Se advarslene ved oppstart.`
    : '';
  return { providers, unavailable, warnings };
}

function build(id, value, warnings, env) {
  switch (id) {
    case 'resend':
      return { id, apiKey: value('RESEND_API_KEY') };
    case 'cloudflare':
      return { id, accountId: value('CLOUDFLARE_ACCOUNT_ID'), apiToken: value('CLOUDFLARE_EMAIL_TOKEN') };
    case 'microsoft':
      return { id, tenantId: value('MICROSOFT_TENANT_ID'), clientId: value('MICROSOFT_CLIENT_ID'), clientSecret: value('MICROSOFT_CLIENT_SECRET') };
    case 'smtp': {
      const tls = value('SMTP_TLS').toLowerCase() || 'starttls';
      if (!(tls in TLS_MODES)) {
        warnings.push(`E-post via SMTP er slått av: SMTP_TLS=${JSON.stringify(value('SMTP_TLS'))} er ugyldig. Gyldige verdier: starttls, tls, none.`);
        return null;
      }
      const rawPort = value('SMTP_PORT');
      const port = rawPort ? Number(rawPort) : TLS_MODES[tls];
      if (!/^\d+$/.test(String(port)) || port < 1 || port > 65535) {
        warnings.push(`E-post via SMTP er slått av: SMTP_PORT=${JSON.stringify(rawPort)} er ikke et portnummer.`);
        return null;
      }
      const user = value('SMTP_USER');
      if (!user && value('SMTP_PASSWORD')) warnings.push('SMTP_PASSWORD er satt uten SMTP_USER – sender uten innlogging.');
      if (user && tls === 'none') warnings.push('SMTP: brukernavn og passord sendes ukryptert (SMTP_TLS=none).');
      return { id, host: value('SMTP_HOST'), port, tls, user, password: user ? String(env.SMTP_PASSWORD ?? '') : '' };
    }
    default:
      return null;
  }
}

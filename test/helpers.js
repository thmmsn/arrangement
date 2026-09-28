// Felles hjelpere for testene: start appen med et gitt miljøoppsett og send forespørsler med valgfri
// Host-header (Node sin fetch lar oss ikke sette Host, så http.request brukes direkte).
import http from 'node:http';
import { after } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createRepository, openDatabase } from '../src/db.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

const quiet = { log() {}, error() {}, warn() {} };
const noRateLimits = {
  register: { windowMs: 60_000, max: 10_000 },
  cancel: { windowMs: 60_000, max: 10_000 },
  create: { windowMs: 60_000, max: 10_000 },
  scanner: { windowMs: 60_000, max: 10_000 },
};

/**
 * Starter appen med `env` som miljøvariabler. Returnerer { request, repo, sent, config, app }.
 * `sent` samler alle e-postene som ville blitt sendt. `placeSearch` erstatter Kartverket-oppslaget.
 * `logoFor` erstatter lesingen av LOGO_URL (se logo.js).
 */
export async function startApp(env = {}, { configOverrides = {}, accessVerifier, placeSearch, mailer: customMailer, logoFor } = {}) {
  const sent = [];
  const config = { ...loadConfig(env), rateLimits: noRateLimits, ...configOverrides };
  const repo = createRepository(openDatabase(':memory:'));
  const mailer = customMailer ?? { send: async (message) => { sent.push(message); return { id: 'test' }; } };
  const app = createApp({
    repo, mailer, config, logger: quiet,
    ...(accessVerifier !== undefined && { accessVerifier }),
    ...(placeSearch && { placeSearch }),
    ...(logoFor && { logoFor }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  const port = server.address().port;
  return { request: (options) => request(port, options), repo, sent, config, app };
}

/** `body` sendes som JSON; `raw` sendes som den er (f.eks. for å teste ugyldig JSON). */
export function request(port, { method = 'GET', path, headers = {}, body, raw }) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({
      port, method, path,
      headers: { ...(data && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* HTML eller tekst */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Et gyldig arrangement for POST /api/admin/events. */
export function eventInput(overrides = {}) {
  return {
    title: 'Testarrangement',
    startsAt: '2030-10-26T16:00:00.000Z', // lørdag 26. oktober 2030 kl. 18:00 norsk tid
    organizerName: 'Arrangør',
    organizerEmail: 'arrangor@example.com',
    fields: [],
    ...overrides,
  };
}

/** Påmelding via det offentlige API-et. `guests`: navn på personer som legges til. */
export async function register(app, slug, { name = 'Ola Nordmann', email = 'ola@example.com', guests = [], headers = {} } = {}) {
  return app.request({
    method: 'POST', path: `/api/events/${slug}/registrations`, headers,
    body: { name, email, guests: guests.map((g) => ({ name: g })) },
  });
}

/** «a=1; Path=/; HttpOnly» ×n → «a=1; b=2», klar til å sendes som Cookie-header. */
export function cookieHeader(res) {
  return (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
}

/** Oppretter et arrangement via admin-API-et og returnerer { slug, adminKey, eventUrl, adminUrl }. */
export async function createEvent(app, overrides = {}, headers = {}) {
  const res = await app.request({
    method: 'POST', path: '/api/admin/events', headers, body: eventInput(overrides),
  });
  if (res.status !== 201) throw new Error(`Kunne ikke opprette arrangement: ${res.status} ${res.text}`);
  return res.json;
}

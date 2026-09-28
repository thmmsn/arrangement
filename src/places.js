// Stedsoppslag mot Kartverkets åpne API-er på ws.geonorge.no (ingen nøkkel).
// Nettleseren kaller aldri Kartverket direkte – alt går via /api/admin/steder, slik at
// Content-Security-Policy kan holdes stram (connect-src 'self') og formatet er vårt eget.
//
//   adresser:   https://ws.geonorge.no/adresser/v1/sok      «Osloveien 15», eller matrikkel «5001/5/422»
//   stedsnavn:  https://ws.geonorge.no/stedsnavn/v1/navn    «Oppdal», «Nidarosdomen»
//
// Koordinatene bes om i EUREF89 geografisk (EPSG:4258), som i praksis er det samme som WGS84 –
// formatet Apple Wallet, Google Wallet, kalenderfiler og kartlenker bruker.

const ADDRESS_URL = 'https://ws.geonorge.no/adresser/v1/sok';
const PLACE_URL = 'https://ws.geonorge.no/stedsnavn/v1/navn';
const TIMEOUT_MS = 10_000;

// Stedsnavn-API-et kan ikke lenger filtrere på type, så vi henter mange og sorterer selv: bebyggelse
// først (der folk flest møtes), så bygninger og anlegg, så alt annet. Ingenting fjernes helt – et
// arrangement kan like gjerne være på en seter eller en fjelltopp.
const TYPE_ORDER = [
  'By', 'Tettsted', 'Bydel', 'Tettbebyggelse', 'Grend', 'Bygd', 'Boligfelt', 'Industriområde', 'Kommune',
  'Kirke', 'Forsamlingshus', 'Skole', 'Hotell', 'Turisthytte', 'Museum', 'Idrettsanlegg', 'Bygning',
  'Gard', 'Bruk', 'Seter', 'Hytte',
];
const typeRank = (type) => {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
};

// «5001/5/422», «5001-5-422» eller «5001 5 422»: kommunenummer, gårdsnummer, bruksnummer.
const CADASTRE_PATTERN = /^(\d{4})\s*[/\- ]\s*(\d{1,5})\s*[/\- ]\s*(\d{1,4})$/;

export class PlaceSearchError extends Error {}

/** Kartverket skriver kommune- og poststeder med store bokstaver: «NORD-AURDAL» → «Nord-Aurdal». */
export function titleCase(text) {
  return String(text ?? '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase());
}

function round(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function addressHit(a) {
  const place = titleCase(a.poststed);
  const municipality = titleCase(a.kommunenavn);
  const point = a.representasjonspunkt;
  if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lon))) return null;
  return {
    kind: 'address',
    label: [a.adressetekst, [a.postnummer, place].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    detail: municipality && municipality !== place ? municipality : '',
    lat: round(point.lat),
    lon: round(point.lon),
  };
}

function placeHit(p) {
  const name = p.skrivemåte;
  const municipality = p.kommuner?.[0]?.kommunenavn ?? '';
  const point = p.representasjonspunkt;
  // Med utkoordsys=4258 er «nord» breddegrad og «øst» lengdegrad.
  if (!name || !point || !Number.isFinite(Number(point.nord)) || !Number.isFinite(Number(point.øst))) return null;
  return {
    kind: 'place',
    label: municipality && municipality !== name ? `${name}, ${municipality}` : name,
    detail: p.navneobjekttype ?? '',
    lat: round(point.nord),
    lon: round(point.øst),
    name,
    type: p.navneobjekttype ?? '',
  };
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {{ search(q: string, limit?: number): Promise<object[]> }}
 */
export function createPlaceSearch({ fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  async function getJson(url, params) {
    const res = await fetchImpl(`${url}?${new URLSearchParams(params)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${url} svarte ${res.status}`);
    return res.json();
  }

  async function addresses(q, limit) {
    const cadastre = CADASTRE_PATTERN.exec(q);
    const params = cadastre
      ? { kommunenummer: cadastre[1], gardsnummer: cadastre[2], bruksnummer: cadastre[3] }
      : { sok: `${q}*` };
    const data = await getJson(ADDRESS_URL, { ...params, treffPerSide: String(limit), utkoordsys: '4258' });
    return (data.adresser ?? []).map(addressHit).filter(Boolean);
  }

  async function places(q, limit) {
    const data = await getJson(PLACE_URL, { sok: `${q}*`, treffPerSide: '200', utkoordsys: '4258' });
    const lower = q.toLowerCase();
    const hits = (data.navn ?? []).map(placeHit).filter(Boolean);
    // Eksakt treff på skrivemåten først, deretter etter type. Samme sted kan finnes flere ganger
    // (f.eks. som både kommune og tettsted) – da beholdes det første.
    hits.sort((a, b) => (b.name.toLowerCase() === lower) - (a.name.toLowerCase() === lower) || typeRank(a.type) - typeRank(b.type));
    const seen = new Set();
    return hits.filter((hit) => {
      const key = `${hit.label}|${hit.lat.toFixed(3)}|${hit.lon.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit).map(({ name, type, ...hit }) => hit);
  }

  return {
    /**
     * Adresser og stedsnavn samtidig. Adressene vises først; ved matrikkelsøk bare adresser.
     * Svikter det ene oppslaget, vises treffene fra det andre. Svikter begge, kastes PlaceSearchError.
     */
    async search(query, limit = 8) {
      const q = String(query ?? '').trim().slice(0, 100);
      if (q.length < 2) return [];
      const isCadastre = CADASTRE_PATTERN.test(q);
      const [a, p] = await Promise.allSettled([
        addresses(q, limit),
        isCadastre ? Promise.resolve([]) : places(q, limit),
      ]);
      if (a.status === 'rejected' && p.status === 'rejected') {
        throw new PlaceSearchError(`Kartverket svarer ikke: ${a.reason?.message}; ${p.reason?.message}`);
      }
      const hits = [...(a.status === 'fulfilled' ? a.value : []), ...(p.status === 'fulfilled' ? p.value : [])];
      return hits.slice(0, limit * 2);
    },
  };
}

// ---------- Kartlenker ----------

/**
 * Veibeskrivelse i Google Maps – virker på alle telefoner (også iPhone, i nettleseren eller appen).
 * Med kartpunkt blir målet nøyaktig; ellers søkes det på stedsteksten.
 */
export function directionsUrl({ location, geo }) {
  if (!geo && !location) return null;
  const destination = geo ? `${geo.lat},${geo.lon}` : location;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/** Veibeskrivelse i Apple Kart (brukes på iPhone, iPad og Mac). */
export function appleDirectionsUrl({ location, geo }) {
  if (!geo && !location) return null;
  const params = new URLSearchParams(geo ? { daddr: `${geo.lat},${geo.lon}` } : { daddr: location });
  if (geo && location) params.set('q', location);
  return `https://maps.apple.com/?${params}`;
}

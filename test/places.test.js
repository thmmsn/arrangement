import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appleDirectionsUrl, createPlaceSearch, directionsUrl, titleCase } from '../src/places.js';
import { startApp } from './helpers.js';

// Stedsoppslag mot Kartverket, med falske svar i stedet for nettet.

const ADDRESS = {
  adresser: [{
    adressetekst: 'Osloveien 15', postnummer: '7018', poststed: 'TRONDHEIM', kommunenavn: 'TRONDHEIM',
    representasjonspunkt: { epsg: 'EPSG:4258', lat: 63.4238123456, lon: 10.3712987654 },
  }],
};
const PLACES = {
  navn: [
    { skrivemåte: 'Oppdal', navneobjekttype: 'Kommune', kommuner: [{ kommunenavn: 'Oppdal' }], representasjonspunkt: { nord: 62.59, øst: 9.69 } },
    { skrivemåte: 'Oppdalsfjellet', navneobjekttype: 'Fjell', kommuner: [{ kommunenavn: 'Oppdal' }], representasjonspunkt: { nord: 62.7, øst: 9.8 } },
    { skrivemåte: 'Oppdal', navneobjekttype: 'Tettsted', kommuner: [{ kommunenavn: 'Oppdal' }], representasjonspunkt: { nord: 62.594, øst: 9.691 } },
    { skrivemåte: 'Uten punkt', navneobjekttype: 'Grend', kommuner: [] },
  ],
};

function fakeFetch({ addresses = ADDRESS, places = PLACES, fail = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    const kind = url.includes('/adresser/') ? 'adresser' : 'stedsnavn';
    if (fail.includes(kind)) return new Response('nede', { status: 503 });
    return new Response(JSON.stringify(kind === 'adresser' ? addresses : places), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('adresser og stedsnavn samtidig: adresser først, stedsnavn sortert, koordinater i WGS84', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const hits = await createPlaceSearch({ fetchImpl }).search('Oppdal');
  assert.deepEqual(hits[0], { kind: 'address', label: 'Osloveien 15, 7018 Trondheim', detail: '', lat: 63.423812, lon: 10.371299 });
  // Eksakt treff først, tettsted foran kommune (samme sted, så bare ett av dem), fjell sist, uten punkt ute.
  assert.deepEqual(hits.slice(1).map((h) => [h.label, h.detail]), [['Oppdal', 'Tettsted'], ['Oppdal', 'Kommune'], ['Oppdalsfjellet, Oppdal', 'Fjell']]);
  const address = calls.find((u) => u.pathname === '/adresser/v1/sok');
  assert.equal(address.searchParams.get('sok'), 'Oppdal*');
  assert.equal(address.searchParams.get('utkoordsys'), '4258');
  const place = calls.find((u) => u.pathname === '/stedsnavn/v1/navn');
  assert.equal(place.searchParams.get('sok'), 'Oppdal*');
});

test('matrikkel (kommunenr/gnr/bnr) søkes som matrikkel, og bare blant adresser', async () => {
  const { fetchImpl, calls } = fakeFetch();
  await createPlaceSearch({ fetchImpl }).search('5001/5/422');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('kommunenummer'), '5001');
  assert.equal(calls[0].searchParams.get('gardsnummer'), '5');
  assert.equal(calls[0].searchParams.get('bruksnummer'), '422');
  assert.equal(calls[0].searchParams.get('sok'), null);
});

test('svikter det ene oppslaget, vises det andre; svikter begge, svarer API-et 502', async () => {
  const one = fakeFetch({ fail: ['stedsnavn'] });
  assert.equal((await createPlaceSearch({ fetchImpl: one.fetchImpl }).search('Oslo')).length, 1);
  assert.deepEqual(await createPlaceSearch({ fetchImpl: one.fetchImpl }).search('O'), [], 'minst to tegn');

  const both = fakeFetch({ fail: ['adresser', 'stedsnavn'] });
  const app = await startApp({ ADMIN_NO_AUTH: 'true' }, { placeSearch: createPlaceSearch({ fetchImpl: both.fetchImpl }) });
  const res = await app.request({ path: '/api/admin/places?q=Oslo' });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Kartverket svarer ikke/);

  const ok = await startApp({ ADMIN_NO_AUTH: 'true' }, { placeSearch: createPlaceSearch({ fetchImpl: fakeFetch().fetchImpl }) });
  assert.equal((await ok.request({ path: '/api/admin/places?q=Oppdal' })).json.results.length, 4);
});

test('stedsoppslaget ligger bak admin-porten', async () => {
  const app = await startApp({ ADMIN_HOST: 'admin.example.com', DOMAIN: 'booking.example.com', ADMIN_NO_AUTH: 'true' }, { placeSearch: { search: async () => [] } });
  assert.equal((await app.request({ path: '/api/admin/places?q=Oslo', headers: { host: 'booking.example.com' } })).status, 404);
  assert.equal((await app.request({ path: '/api/admin/places?q=Oslo', headers: { host: 'admin.example.com' } })).status, 200);
});

test('kartpunkt lagres på arrangementet og gir veibeskrivelse', async () => {
  const app = await startApp({ ADMIN_NO_AUTH: 'true' });
  const bad = await app.request({ method: 'POST', path: '/api/admin/events', body: { title: 'X', startsAt: '2030-01-01T10:00:00Z', organizerName: 'A', organizerEmail: 'a@example.com', geo: { lat: 200, lon: 0 } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors.location, 'Ugyldig kartpunkt');
  const res = await app.request({ method: 'POST', path: '/api/admin/events', body: { title: 'X', location: 'Osloveien 15, Trondheim', startsAt: '2030-01-01T10:00:00Z', organizerName: 'A', organizerEmail: 'a@example.com', geo: { lat: 63.42381234, lon: 10.37129876 } } });
  const event = await app.request({ path: `/api/events/${res.json.slug}` });
  assert.deepEqual(event.json.geo, { lat: 63.423812, lon: 10.371299 });
  assert.equal(event.json.links.directions, 'https://www.google.com/maps/dir/?api=1&destination=63.423812%2C10.371299');
});

test('kartlenker og navn fra Kartverket', () => {
  assert.equal(titleCase('NORD-AURDAL'), 'Nord-Aurdal');
  assert.equal(titleCase('INDRE ØSTFOLD'), 'Indre Østfold');
  assert.equal(directionsUrl({ location: 'Grendehuset, Nordbygda', geo: null }), 'https://www.google.com/maps/dir/?api=1&destination=Grendehuset%2C%20Nordbygda');
  assert.equal(directionsUrl({ location: '', geo: null }), null);
  assert.equal(appleDirectionsUrl({ location: 'Huset', geo: { lat: 1, lon: 2 } }), 'https://maps.apple.com/?daddr=1%2C2&q=Huset');
});

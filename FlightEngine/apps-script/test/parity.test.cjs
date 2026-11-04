// Parità fra il codice Apps Script e il backend TypeScript compilato (functions/lib).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./harness.cjs');

const lib = (name) => require(path.join(__dirname, '..', '..', 'functions', 'lib', name));
const { parseResponse, serpStops } = lib('provider-response.js');
const { tripRequest } = lib('trip-request.js');
const rts = lib('round-trip-search.js');
const { normalizeSearch } = lib('search-data.js');
const { keyCandidates, selectKey, beginKeyRun } = lib('key-rotation.js');
const { legDetails, providerName, returnDescription } = lib('flight-display.js');
const { googleFlightsSearchUrl } = lib('google-flights-link.js');
const { redact, bodyChunks } = lib('request-log.js');
const fixture = require(path.join(__dirname, '..', '..', 'functions', 'test', 'fixtures', 'rapid-mxp-bcn.json'));

const { ctx } = loadScript();
const plain = (x) => JSON.parse(JSON.stringify(x));

test('parseResponse_ matches parseResponse on fixtures, errors and stop filters', async () => {
  const cases = [
    [200, fixture, 'rapid', undefined], [200, fixture, 'rapid', 0], [200, fixture, 'rapid', 1],
    [200, { best_flights: [{ price: 300 }], other_flights: [{ price: 180 }], price_insights: { lowest_price: 90 } }, 'serp', 2],
    [200, { best_flights: [], other_flights: [] }, 'serp', 1],
    [200, { data: { itineraries: [{ price: 90, stops: 2 }, { price: 150, stops: 1 }] } }, 'rapid', 1],
    [200, { data: { itineraries: { topFlights: [], otherFlights: [{ price: '150' }] } } }, 'rapid', 1],
    [200, { best_flights: [{ flights: [{}, {}, {}], price: 50 }, { flights: [{}], price: 80 }] }, 'serp', 1],
    [200, { best_flights: [{ price: 'abc' }] }, 'serp', 1],
    [200, { error: 'bad' }, 'rapid', 1], [200, { status: false }, 'rapid', 1], [200, { search_metadata: { status: 'Error' } }, 'serp', 1],
    [200, { data: { flights: [{ price: 100 }] } }, 'rapid', 1], [200, 'not json', 'serp', 1], [200, 'null', 'serp', 1],
    [429, '', 'rapid', 1], [403, '{}', 'serp', 1], [503, 'x', 'serp', 1]
  ];
  for (const [status, body, kind, maxStops] of cases) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const expected = await parseResponse(new Response(status === 200 ? text : text || null, { status }), kind, maxStops);
    assert.deepEqual(plain(ctx.parseResponse_(status, text, kind, maxStops)), plain(expected), `${kind} ${status} ${text.slice(0, 40)}`);
  }
  for (const n of [0, 1, 2, 5]) assert.equal(ctx.serpStops_(n), serpStops(n));
});

test('tripRequest_ builds the same provider URLs and headers', () => {
  const trips = [
    { origin: 'MXP', destination: 'BCN', departureDate: '2027-05-20', returnDate: '2027-05-24', leg: 'ANDATA_RITORNO' },
    { origin: 'OPO', destination: 'LIN', departureDate: '2027-05-24', leg: 'RITORNO' }
  ];
  for (const provider of ['SerpApi', 'RapidAPI']) for (const trip of trips) for (const stops of [0, 1, 3]) {
    const a = ctx.tripRequest_(provider, 'k/ey+1', trip, 4, stops, 'EUR'), b = tripRequest(provider, 'k/ey+1', trip, 4, stops, 'EUR');
    const ua = new URL(a.url), ub = new URL(b.url);
    assert.equal(ua.origin + ua.pathname, ub.origin + ub.pathname);
    assert.deepEqual([...ua.searchParams], [...ub.searchParams]);
    assert.deepEqual(plain(a.headers), b.init.headers || {});
    assert.equal(a.kind, b.kind);
  }
});

test('dates, trip combinations and planned requests are identical', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const searches = [
    { origin: 'Milano', destination: 'BCN', departureFrom: '2027-04-01', departureTo: '2027-05-31', nights: 4, travelers: 4 },
    { origin: 'MXP', destination: 'CAI', departureFrom: '2027-03-01', departureTo: '2027-04-30', allowedDays: 'WEEKEND' },
    { origin: 'MXP', destination: 'FAO', returnOrigin: 'OPO', returnDestination: 'LIN', departureFrom: '01/04/2027', departureTo: '10/04/2027', nights: 7 },
    { origin: 'MXP', destination: 'BCN', departureFrom: '2026-01-01', departureTo: '2026-12-31' }
  ];
  for (const raw of searches) {
    const s = normalizeSearch(raw);
    assert.deepEqual(plain(ctx.normalizeSearch_(raw)), s);
    for (const months of [1, 9, 24]) {
      const dates = rts.departureDates(s, months, now);
      assert.deepEqual(plain(ctx.departureDates_(s, months, now)), dates);
      const args = [s, dates, ['MXP', 'LIN', 'BGY'], ['BCN', 'FAO'], ['OPO', 'FAO'], ['LIN', 'MXP']];
      const q = rts.tripQueries(...args);
      assert.deepEqual(plain(ctx.tripQueries_(...args)), q);
      assert.deepEqual(plain(ctx.plannedRequests_(q)), rts.plannedRequests(q));
    }
  }
  for (const bad of [{ origin: '', destination: 'X', departureFrom: '2027-01-01', departureTo: '2027-01-02' }, { origin: 'A', destination: 'B', departureFrom: '2027-02-30', departureTo: '2027-03-01' }, { origin: 'A', destination: 'B', departureFrom: '2027-01-02', departureTo: '2027-01-01' }, { origin: 'A', destination: 'B', departureFrom: '2027-01-01', departureTo: '2027-01-02', travelers: 0 }]) {
    assert.throws(() => normalizeSearch(bad));
    assert.throws(() => ctx.normalizeSearch_(bad));
  }
});

test('resumable collector gives the same offers as collectRoundTrips, even when paused at every call', async () => {
  const s = normalizeSearch({ origin: 'MXP', destination: 'FAO', returnOrigin: 'OPO,FAO', returnDestination: 'LIN,MXP', departureFrom: '2027-04-01', departureTo: '2027-04-12', nights: 5, travelers: 3 });
  const dates = rts.departureDates(s, 24, new Date('2026-09-15T12:00:00Z'));
  const queries = rts.tripQueries(s, dates, ['MXP', 'BGY'], ['FAO', 'LIS'], ['OPO', 'FAO'], ['LIN', 'MXP']);
  const reply = (q) => {
    const seed = [...JSON.stringify([q.origin, q.destination, q.departureDate])].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);
    if (seed % 11 === 0) return { calls: 1, warnings: ['vuoto ' + q.origin], provider: 'SerpApi', options: [] };
    return { calls: 1, warnings: [], provider: seed % 2 ? 'SerpApi' : 'RapidAPI', options: [{ price: 50 + seed % 40, raw: { id: seed } }, { price: 70 + seed % 13, raw: { id: seed + 1 } }] };
  };
  for (const top of [1, 3]) {
    const expected = await rts.collectRoundTrips(queries, s.travelers, top, async (q) => reply(q));
    const progress = ctx.newRoundTripProgress_(), cache = {};
    let allow = 0, result = null, pauses = 0;
    while (!result) {
      allow = 1; // una sola chiamata per "blocco": pausa prima di ogni chiamata successiva
      try {
        const persisted = JSON.parse(JSON.stringify({ progress, cache })); // simula salvataggio e ricarica
        Object.assign(progress, persisted.progress);
        for (const k of Object.keys(cache)) delete cache[k];
        Object.assign(cache, persisted.cache);
        result = ctx.collectRoundTripsStep_(queries, s.travelers, top, progress, cache, {
          request: (q) => { if (allow-- <= 0) throw new ctx.PauseSignal_(0, []); return reply(q); },
          onLeg: () => {}
        });
      } catch (e) { if (!(e instanceof ctx.PauseSignal_)) throw e; pauses++; }
    }
    assert.ok(pauses > 10);
    assert.deepEqual(plain(result), plain(expected));
  }
});

test('key ids and rotation match key-rotation.ts', () => {
  const providers = [{ name: 'SerpApi', keys: ['a', ' b ', '', 'a'] }, { name: 'RapidAPI', keys: ['a', 'c'] }];
  const a = plain(ctx.keyCandidates_(providers)), b = keyCandidates(providers);
  assert.deepEqual(a, b);
  const state = { cycle: 2, exhausted: [b[0].id], startKeyId: b[1].id };
  assert.deepEqual(plain(ctx.selectKey_(state, a, new Set([b[2].id]))), plain(selectKey(state, b, new Set([b[2].id]))));
  assert.deepEqual(plain(ctx.beginKeyRun_({ cycle: 4, exhausted: [b[0].id] }, a)), beginKeyRun({ cycle: 4, exhausted: [b[0].id] }, b));
  assert.deepEqual(plain(ctx.beginKeyRun_({ cycle: 0, exhausted: [] }, [])), beginKeyRun({ cycle: 0, exhausted: [] }, []));
});

test('display helpers, Google Flights links and redaction are identical', () => {
  const raw = { flights: [{ departure_airport: { id: 'MXP', name: 'Malpensa', time: '2027-05-20 10:30' }, arrival_airport: { id: 'FCO', time: '2027-05-20 11:40' }, airline: 'ITA', flight_number: 'AZ 1' }, { departure_airport: { id: 'FCO' }, arrival_airport: { airport_code: 'BCN', airport_name: 'El Prat', time: '2027-05-20 15:00' }, airline: 'Vueling' }], total_duration: 270, layovers: [{ duration: 80 }, { duration: { raw: 10 } }] };
  for (const r of [raw, null, {}, { duration: { raw: 105 }, stops: 0 }]) assert.deepEqual(plain(ctx.legDetails_(r)), legDetails(r));
  for (const p of ['SerpApi', 'RapidAPI / SerpApi', 'Foo (MXP-BCN)', '']) assert.equal(ctx.providerName_(p), providerName(p));
  const offer = { outbound: raw, return: null, returnOrigin: 'BCN', returnDestination: 'MXP', returnDetailsStatus: 'NOT_REQUESTED' };
  assert.equal(ctx.returnDescription_(offer), returnDescription(offer));
  for (const args of [['MXP', 'BCN', '2027-05-20', '2027-05-24', 'EUR', 4, 1], ['MXP', 'BCN', '2027-05-20', undefined, 'USD', 12, undefined], ['MXP', 'BCN', '2027-05-20', undefined, 'EUR', 1, 0]]) {
    assert.equal(ctx.googleFlightsSearchUrl_(...args), googleFlightsSearchUrl(...args));
  }
  const text = 'https://serpapi.com/search.json?api_key=se%2Fcret&x=1 {"x-rapidapi-key":"abc","authorization":"Bearer t"} se/cret';
  assert.equal(ctx.redact_(text, ['se/cret']), redact(text, ['se/cret']));
  const big = 'é'.repeat(250001) + '😀'.repeat(10);
  assert.deepEqual(plain(ctx.bodyChunks_(big)), bodyChunks(big));
});

// Test di functions/test/schedule.test.cjs (scheduler Firebase rimosso), ora sul porting Apps Script.
test('schedule slots keep the Firebase semantics (event time, days, DST, midnight)', () => {
  const cfg = { scheduleEnabled: true, scheduleTimezone: 'Europe/Rome', scheduleHour: 2, scheduleMinute: 30, scheduleDays: ['TUE', 'WED', 'THU', 'FRI'] };
  assert.equal(ctx.scheduledSlot_(cfg, '2026-09-17T00:30:00Z'), '2026-09-17 02:30 Europe/Rome');
  for (const minute of ['08', '23', '38', '53', '00', '15', '45']) assert.equal(ctx.scheduledSlot_(cfg, `2026-09-17T00:${minute}:00Z`), null);
  assert.equal(ctx.scheduledSlot_({ ...cfg, scheduleEnabled: false }, '2026-09-17T00:30:00Z'), null);
  assert.equal(ctx.scheduledSlot_(cfg, '2026-09-19T00:30:00Z'), null);
  assert.equal(ctx.scheduledSlot_(cfg, '2026-12-17T01:30:00Z'), '2026-12-17 02:30 Europe/Rome');
  assert.equal(ctx.scheduledSlot_({ ...cfg, scheduleHour: 0, scheduleMinute: 0 }, '2026-09-16T22:00:00Z'), '2026-09-17 00:00 Europe/Rome');
  const sunday = { ...cfg, scheduleDays: ['SUN'] };
  assert.equal(ctx.scheduledSlot_(sunday, '2026-10-25T00:30:00Z'), ctx.scheduledSlot_(sunday, '2026-10-25T01:30:00Z'));
});

test('due slot tolerates late triggers and next slot is computed in the configured time zone', () => {
  const cfg = { scheduleEnabled: true, scheduleTimezone: 'Europe/Rome', scheduleHour: 2, scheduleMinute: 30, scheduleDays: ['THU'] };
  assert.equal(ctx.dueSlot_(cfg, new Date('2026-09-17T00:30:20Z')).slot, '2026-09-17 02:30 Europe/Rome');
  assert.equal(ctx.dueSlot_(cfg, new Date('2026-09-17T00:34:00Z')).slot, '2026-09-17 02:30 Europe/Rome');
  assert.equal(ctx.dueSlot_(cfg, new Date('2026-09-17T01:30:00Z')).slot, '2026-09-17 02:30 Europe/Rome');
  assert.equal(ctx.dueSlot_(cfg, new Date('2026-09-17T01:31:00Z')), null);
  assert.equal(ctx.dueSlot_(cfg, new Date('2026-09-17T00:29:00Z')), null);
  assert.equal(ctx.nextScheduleAt_(cfg, new Date('2026-09-15T10:00:00Z')).toISOString(), '2026-09-17T00:30:00.000Z');
  assert.equal(ctx.nextScheduleAt_(cfg, new Date('2026-12-15T10:00:00Z')).toISOString(), '2026-12-17T01:30:00.000Z');
  assert.equal(ctx.nextScheduleAt_({ ...cfg, scheduleMinute: 7 }, new Date('2026-09-17T00:30:00Z')).toISOString(), '2026-09-24T00:07:00.000Z');
  assert.equal(ctx.nextScheduleAt_({ ...cfg, scheduleEnabled: false }, new Date()), null);
});

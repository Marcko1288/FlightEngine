// Flusso completo dello scheduler su Firestore simulato: slot, lotti con ripresa, 429, retry, arresto, email.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, response } = require('./harness.cjs');

const lib = (name) => require(path.join(__dirname, '..', '..', 'functions', 'lib', name));
const { parseResponse } = lib('provider-response.js');
const { tripRequest } = lib('trip-request.js');
const rts = lib('round-trip-search.js');
const { normalizeSearch } = lib('search-data.js');
const { providerName, legDetails } = lib('flight-display.js');
const plain = (x) => JSON.parse(JSON.stringify(x));

const iso = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
function romeNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute) };
}
function settingsDueNow(extra = {}) {
  const { hour, minute } = romeNow();
  return { monthsAhead: 24, topResults: 2, dropAlertPercent: 10, currency: 'EUR', emailTo: 'me@example.com', serpApiEnabled: true, rapidApiEnabled: false, scheduleTimezone: 'Europe/Rome', scheduleEnabled: true, scheduleHour: hour, scheduleMinute: minute, scheduleDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], ...extra };
}

// Provider SerpApi deterministico: prezzo funzione della tratta.
function serpBody(url) {
  const q = new URL(url).searchParams;
  const key = [q.get('departure_id'), q.get('arrival_id'), q.get('outbound_date'), q.get('return_date')].join('|');
  const seed = [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1009, 3);
  const flight = (price, stops) => ({ price, flights: Array.from({ length: stops + 1 }, (_, i) => ({ departure_airport: { id: i ? 'FCO' : q.get('departure_id'), name: 'Dep', time: q.get('outbound_date') + ' 0' + (i + 7) + ':15' }, arrival_airport: { id: i === stops ? q.get('arrival_id') : 'FCO', name: 'Arr', time: q.get('outbound_date') + ' 1' + i + ':40' }, airline: 'Air' + i, flight_number: 'XX ' + seed })), total_duration: 145 + stops * 60, layovers: stops ? [{ duration: 55 }] : undefined });
  return JSON.stringify({ best_flights: [flight(120 + (seed % 90), 0), flight(100 + (seed % 70), 2)], other_flights: [flight(150 + (seed % 30), 1)] });
}
const serpProvider = (url) => response(200, serpBody(url), { 'Content-Type': 'application/json' });

function seed(env, settings, searches) {
  env.db.set('settings/global', settings);
  for (const [id, s] of Object.entries(searches)) env.db.set('flight_searches/' + id, s);
}

/** Simula i trigger ogni 5 minuti: ogni blocco consente al massimo `callsPerBlock` chiamate provider. */
function runTicks(env, callsPerBlock, maxTicks = 200) {
  let ticks = 0;
  do {
    const startCalls = env.calls.provider.length;
    env.ctx.outOfBudget_ = () => env.calls.provider.length - startCalls >= callsPerBlock;
    env.ctx.runScheduler();
    ticks++;
  } while (env.db.get('engine_state/scheduler').activeRunId && ticks < maxTicks);
  return ticks;
}

async function expectedOffers(search, settings, provider) {
  const s = normalizeSearch(search);
  const dates = rts.departureDates(s, settings.monthsAhead);
  const code = (v) => ({ MILANO: ['MXP', 'LIN', 'BGY'] }[v] || v.split(','));
  const queries = rts.tripQueries(s, dates, code(s.origin), code(s.destination), code(s.returnOrigin || s.destination), code(s.returnDestination || s.origin));
  return rts.collectRoundTrips(queries, s.travelers, settings.topResults, async (q) => {
    const r = tripRequest('SerpApi', 'serp-key-1', q, s.travelers, s.maxStops, settings.currency);
    const res = provider(r.url);
    const parsed = await parseResponse(new Response(res.getContentText(), { status: res.getResponseCode() }), 'serp', s.maxStops);
    return { calls: 1, warnings: [], provider: 'SerpApi', options: parsed.status === 'OK' ? parsed.options : [] };
  });
}

test('scheduled run is split in blocks, resumes without duplicate calls and writes the same data as Firebase', async () => {
  const env = loadScript({ provider: serpProvider });
  const settings = settingsDueNow();
  const searches = {
    ar: { origin: 'Milano', destination: 'BCN', departureFrom: iso(30), departureTo: iso(33), nights: 4, travelers: 2, maxStops: 1, pricePerPerson: 500, destinationName: 'Barcellona', cluster: 'Primavera', active: true },
    oj: { origin: 'MXP', destination: 'FAO', returnOrigin: 'OPO', returnDestination: 'LIN', departureFrom: iso(40), departureTo: iso(41), nights: 7, travelers: 3, maxStops: 2, pricePerPerson: 10, destinationName: 'Algarve', cluster: 'Estate', active: true },
    off: { origin: 'MXP', destination: 'JFK', departureFrom: iso(40), departureTo: iso(41), active: false }
  };
  seed(env, settings, searches);
  const ticks = runTicks(env, 3);
  assert.ok(ticks > 3, 'deve servire più di un blocco: ' + ticks);

  const sched = env.db.get('engine_state/scheduler');
  assert.equal(sched.lastTickStatus, 'OK');
  assert.equal(sched.activeRunId, null);
  assert.equal(sched.executor, 'APPS_SCRIPT');
  assert.ok(sched.nextScheduleAt instanceof env.ctx.Date);
  const runs = env.db.list('execution_logs/');
  assert.equal(runs.length, 1, 'una sola esecuzione per lo slot');
  const run = runs[0].data, runId = runs[0].id;
  assert.equal(env.db.get('settings/global').lastScheduleSlot, sched.lastScheduleSlot);
  assert.equal(run.status, 'OK');
  assert.equal(run.mode, 'SAVED');
  assert.equal(run.trigger, 'SCHEDULE');
  assert.equal(run.searches, 2);
  assert.equal(run.completedSearches, 2);
  assert.equal(run.runningSearches, 0);
  assert.equal(run.queuedSearches, 0);
  assert.ok(run.finishedAt && run.postProcessedAt);
  assert.equal(run.nextResumeAt, undefined);

  // Nessuna chiamata duplicata fra un blocco e l'altro.
  const urls = env.calls.provider.map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(run.apiCalls, urls.length);
  assert.ok(urls.every((u) => u.includes('api_key=serp-key-1')));

  for (const [id, search] of Object.entries(searches).filter(([id]) => id !== 'off')) {
    const expected = await expectedOffers(search, settings, serpProvider);
    const task = env.db.get(`execution_logs/${runId}/tasks/${id}`);
    assert.equal(task.status, 'OK');
    assert.equal(task.calls, expected.calls);
    assert.equal(task.attempts, 1);
    const results = env.db.list('flight_results/').map((r) => r.data).filter((r) => r.searchId === id).sort((a, b) => a.totalPrice - b.totalPrice);
    assert.equal(results.length, Math.min(settings.topResults, expected.items.length));
    results.forEach((r, i) => {
      const offer = expected.items[i], s = normalizeSearch(search), out = legDetails(offer.outbound), back = legDetails(offer.return);
      const want = { ...offer, provider: providerName(offer.provider), searchId: id, runId, destinationName: s.destinationName, cluster: s.cluster, currency: 'EUR', travelers: s.travelers, maxStops: s.maxStops, origin: out.origin.code || s.origin, destination: out.destination.code || s.destination, returnOrigin: back.origin.code || offer.returnOrigin, returnDestination: back.destination.code || offer.returnDestination, alert: offer.pricePerPerson <= s.pricePerPerson };
      const got = plain(r); delete got.checkedAt;
      assert.deepEqual(got, plain(want));
      assert.ok(r.checkedAt instanceof env.ctx.Date);
    });
    const saved = env.db.get('flight_searches/' + id);
    assert.equal(saved.lastStatus, 'OK');
    assert.equal(saved.lastPrice, expected.items[0].pricePerPerson);
    assert.ok(saved.lastCheckAt instanceof env.ctx.Date);
  }
  assert.equal(env.db.get('flight_searches/off').lastCheckAt, undefined);

  // Diagnostica: chiamate con chiave oscurata e corpo salvato.
  const entries = env.db.list(`execution_logs/${runId}/entries/`).map((e) => ({ id: e.id, ...e.data }));
  const callsLogged = entries.filter((e) => e.kind === 'CALL');
  assert.equal(callsLogged.length, urls.length);
  assert.ok(callsLogged.every((e) => e.status === 'OK' && e.httpStatus === 200 && e.request.url.includes('api_key=[REDACTED]') && e.bodyChunks === 1));
  assert.ok(env.db.get(`execution_logs/${runId}/entries/${callsLogged[0].id}/body/00000000`).text.startsWith('{"best_flights"'));
  for (const m of ['Sotto-task delle ricerche accodati', 'Piano chiamate A/R', 'Ripresa dell\'esecuzione (nuovo blocco Apps Script)', 'Ripresa sotto-task ricerca', 'Ricerca completata', 'Email di alert inviata', 'Tutti i sotto-task sono terminati']) {
    assert.ok(entries.some((e) => e.message === m), 'manca evento: ' + m);
  }

  // Email: una sola, con le offerte in alert (solo Barcellona è sotto soglia).
  assert.equal(env.calls.mails.length, 1);
  const mail = env.calls.mails[0];
  assert.equal(mail.to, 'me@example.com');
  assert.match(mail.subject, /Flight Engine: 2 nuove occasioni da/);
  assert.match(mail.htmlBody, /Barcellona/);
  assert.doesNotMatch(mail.htmlBody, /Algarve/);
  assert.match(mail.htmlBody, /google\.com\/travel\/flights\/search\?tfs=/);
  assert.match(mail.htmlBody, /Sotto soglia/);

  // Un nuovo passaggio nello stesso slot non riparte.
  env.ctx.runScheduler();
  assert.equal(env.db.list('execution_logs/').length, 1);
  assert.match(env.db.get('engine_state/scheduler').lastTickMessage, /già eseguito/);
});

test('no slot due: nothing runs and the next execution is published', () => {
  const env = loadScript({ provider: serpProvider });
  const s = settingsDueNow();
  s.scheduleHour = (s.scheduleHour + 3) % 24;
  seed(env, s, { a: { origin: 'MXP', destination: 'BCN', departureFrom: iso(30), departureTo: iso(30), active: true } });
  env.ctx.runScheduler();
  assert.equal(env.db.list('execution_logs/').length, 0);
  const sched = env.db.get('engine_state/scheduler');
  assert.equal(sched.lastTickMessage, 'Nessuno slot dovuto.');
  assert.ok(sched.nextScheduleAt.getTime() > Date.now());
});

test('HTTP 429 rotates keys once, records diagnostics and stops without loops', () => {
  const env = loadScript({ props: { SERPAPI_KEYS: JSON.stringify(['k1', 'k2']) } });
  let n = 0;
  env.setProvider((url) => (url.includes('api_key=k1') ? response(429, '{"error":"limit"}', { 'Retry-After': '30' }) : (++n > 2 ? response(429, '', {}) : serpProvider(url))));
  seed(env, settingsDueNow({ emailTo: '' }), {
    a: { origin: 'MXP', destination: 'BCN', departureFrom: iso(30), departureTo: iso(35), active: true },
    b: { origin: 'MXP', destination: 'MAD', departureFrom: iso(30), departureTo: iso(35), active: true }
  });
  runTicks(env, 1000);
  const [{ id: runId, data: run }] = env.db.list('execution_logs/');
  // k1: 1 chiamata (429), k2: 2 OK + 1 (429); poi stop per tutte le ricerche.
  assert.equal(env.calls.provider.length, 4);
  assert.equal(run.apiCalls, 4);
  assert.equal(run.status, 'WARNING');
  const a = env.db.get(`execution_logs/${runId}/tasks/a`), b = env.db.get(`execution_logs/${runId}/tasks/b`);
  assert.equal(a.status, 'WARNING');
  assert.ok(a.warnings.some((w) => /chiave 1: Quota API esaurita/.test(w)));
  assert.ok(a.warnings.some((w) => /Tutte le chiavi sono sature/.test(w)));
  assert.equal(b.status, 'WARNING');
  assert.equal(b.calls, 0);
  const state = env.db.get(`execution_logs/${runId}/state/api_keys`), global = env.db.get('engine_state/api_keys');
  assert.equal(state.exhausted.length, 2);
  assert.equal(global.exhausted.length, 2);
  assert.equal(global.cycle, 1);
  // Retry-After rispettato con tetto di 2 s, mai più di una pausa per 429.
  assert.deepEqual(env.calls.sleeps.filter((ms) => ms >= 1000), [2000, 1000]);
  const limits = env.db.list(`execution_logs/${runId}/entries/`).filter((e) => e.data.status === 'LIMIT');
  assert.equal(limits.length, 2);
});

test('5xx errors are retried with backoff at most twice', () => {
  const env = loadScript();
  let n = 0;
  env.setProvider((url) => (++n <= 2 ? response(503, 'busy') : serpProvider(url)));
  seed(env, settingsDueNow({ emailTo: '' }), { a: { origin: 'MXP', destination: 'BCN', departureFrom: iso(30), departureTo: iso(30), active: true } });
  runTicks(env, 1000);
  const [{ id: runId, data: run }] = env.db.list('execution_logs/');
  assert.equal(run.status, 'OK');
  assert.equal(env.calls.provider.length, 3);
  assert.deepEqual(env.calls.sleeps, [1000, 3000]);
  const task = env.db.get(`execution_logs/${runId}/tasks/a`);
  assert.equal(task.calls, 3);
  const attempts = env.db.list(`execution_logs/${runId}/entries/`).filter((e) => e.data.kind === 'CALL').map((e) => [e.data.attempt, e.data.status]).sort();
  assert.deepEqual(plain(attempts), [[1, 'ERROR'], [2, 'ERROR'], [3, 'OK']]);

  const always = loadScript({ provider: () => response(502, 'down') });
  seed(always, settingsDueNow({ emailTo: '' }), { a: { origin: 'MXP', destination: 'BCN', departureFrom: iso(30), departureTo: iso(30), active: true } });
  runTicks(always, 1000);
  assert.equal(always.calls.provider.length, 3);
  const t = always.db.list('execution_logs/')[0];
  assert.equal(t.data.status, 'WARNING');
  assert.match(always.db.get(`execution_logs/${t.id}/tasks/a`).warnings[0], /HTTP 502/);
});

test('a stop requested from the webapp cancels the remaining work at the next block', () => {
  const env = loadScript({ provider: serpProvider });
  seed(env, settingsDueNow(), {
    a: { origin: 'Milano', destination: 'BCN', departureFrom: iso(30), departureTo: iso(40), active: true },
    b: { origin: 'MXP', destination: 'MAD', departureFrom: iso(30), departureTo: iso(40), active: true }
  });
  env.ctx.outOfBudget_ = () => env.calls.provider.length >= 2;
  env.ctx.runScheduler();
  const runId = env.db.get('engine_state/scheduler').activeRunId;
  assert.ok(runId);
  assert.equal(env.db.get('execution_logs/' + runId).status, 'RUNNING');
  assert.ok(env.db.get('execution_logs/' + runId).nextResumeAt instanceof env.ctx.Date);
  // stopFlightSearch
  const run = env.db.get('execution_logs/' + runId);
  env.db.set('execution_logs/' + runId, { ...plain(run), startedAt: run.startedAt, cancelRequestedAt: 'now' });
  runTicks(env, 1000);
  const after = env.db.get('execution_logs/' + runId);
  assert.equal(after.status, 'CANCELLED');
  assert.equal(env.calls.provider.length, 2);
  assert.equal(env.db.get(`execution_logs/${runId}/tasks/a`).status, 'CANCELLED');
  assert.equal(env.db.get(`execution_logs/${runId}/tasks/b`).status, 'CANCELLED');
  assert.equal(env.calls.mails.length, 0);
  assert.equal(env.db.get('engine_state/scheduler').activeRunId, null);
});

test('task errors are retried in later blocks and fail after three attempts', () => {
  const env = loadScript({ provider: serpProvider });
  seed(env, settingsDueNow({ emailTo: '' }), {
    bad: { origin: 'XQZ1', destination: 'BCN', departureFrom: iso(30), departureTo: iso(30), active: true },
    good: { origin: 'MXP', destination: 'BCN', departureFrom: iso(30), departureTo: iso(30), active: true }
  });
  // Catalogo aeroporti senza la località richiesta.
  const fetch = env.ctx.UrlFetchApp.fetch;
  env.ctx.UrlFetchApp.fetch = (url, opts) => (url.includes('ourairports') ? response(200, 'iata_code,name,municipality,iso_country,type\nBCN,El Prat,Barcelona,ES,large_airport') : fetch(url, opts));
  env.ctx.FE_CONFIG.TASK_RETRY_DELAY_MS = 0;
  runTicks(env, 1000);
  const [{ id: runId, data: run }] = env.db.list('execution_logs/');
  const bad = env.db.get(`execution_logs/${runId}/tasks/bad`);
  assert.equal(bad.status, 'ERROR');
  assert.equal(bad.attempts, 3);
  assert.match(bad.warnings[0], /Aeroporto o città non riconosciuti: XQZ1/);
  assert.equal(env.db.get(`execution_logs/${runId}/tasks/good`).status, 'OK');
  assert.equal(run.status, 'ERROR');
  assert.equal(run.failedSearches, 1);
});

test('LOG_RESPONSE_BODIES=false skips body documents; testSingleSearchById runs one search', () => {
  const env = loadScript({ provider: serpProvider, props: { LOG_RESPONSE_BODIES: 'false' } });
  const s = settingsDueNow({ emailTo: '' });
  s.scheduleEnabled = false;
  seed(env, s, { a: { origin: 'MXP', destination: 'BCN', departureFrom: iso(30), departureTo: iso(31), active: true }, b: { origin: 'MXP', destination: 'MAD', departureFrom: iso(30), departureTo: iso(31), active: true } });
  const summary = env.ctx.testSingleSearchById('a');
  assert.equal(summary.outcome, 'DONE');
  assert.equal(summary.status, 'OK');
  const [{ id: runId, data: run }] = env.db.list('execution_logs/');
  assert.equal(run.trigger, 'MANUAL_TEST');
  assert.equal(run.searches, 1);
  assert.equal(env.calls.provider.length, 2);
  const calls = env.db.list(`execution_logs/${runId}/entries/`).filter((e) => e.data.kind === 'CALL');
  assert.ok(calls.every((e) => e.data.bodyChunks === 0 && e.data.bodyLogged === false));
  assert.equal(env.db.list(`execution_logs/${runId}/entries/${calls[0].id}/body/`).length, 0);
  assert.equal(env.db.get('flight_searches/a').lastStatus, 'OK');
  assert.equal(env.db.get('flight_searches/b').lastStatus, undefined);
});

test('setupTrigger installs a single 5-minute trigger and removeTrigger removes it', () => {
  const env = loadScript({ provider: serpProvider });
  seed(env, settingsDueNow(), {});
  env.ctx.setupTrigger();
  env.ctx.setupTrigger();
  assert.deepEqual(env.calls.triggers, ['runScheduler']);
  assert.equal(env.db.get('engine_state/scheduler').triggerInstalled, true);
  assert.equal(env.ctx.removeTrigger(), 1);
  assert.deepEqual(env.calls.triggers, []);
  assert.equal(env.db.get('engine_state/scheduler').triggerInstalled, false);
});

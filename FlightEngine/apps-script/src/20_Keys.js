/**
 * Porting di key-rotation.ts e della gestione chiavi di fetchTrip (index.ts).
 * Gli id delle chiavi sono sha256("Provider:chiave"), identici a quelli del backend Firebase,
 * quindi lo stato globale engine_state/api_keys resta condiviso fra script e Functions.
 */

function keyCandidates_(providers) {
  var seen = new Set(), out = [];
  providers.forEach(function (p) {
    p.keys.forEach(function (value, index) {
      var key = String(value).trim();
      if (!key) return;
      var id = sha256Hex_(p.name + ':' + key);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id: id, provider: p.name, key: key, index: index + 1 });
    });
  });
  return out;
}

function selectKey_(state, candidates, attempted) {
  var start = Math.max(0, candidates.findIndex(function (k) { return k.id === state.startKeyId; }));
  var ordered = candidates.slice(start).concat(candidates.slice(0, start));
  var key = ordered.find(function (k) { return state.exhausted.indexOf(k.id) < 0 && !attempted.has(k.id); });
  return { state: state, key: key, reset: false };
}

// Una volta per esecuzione: riparte dalla prima chiave già utilizzabile e consente un solo giro.
function beginKeyRun_(previous, candidates) {
  var first = selectKey_(previous, candidates, new Set()).key || candidates[0];
  var state = { cycle: previous.cycle + 1, exhausted: [] };
  if (first) state.startKeyId = first.id;
  return state;
}

function runProviders_(settings) {
  var cfg = getConfig_(), providers = [];
  if (settings.serpApiEnabled) providers.push({ name: 'SerpApi', keys: cfg.serpApiKeys });
  if (settings.rapidApiEnabled) providers.push({ name: 'RapidAPI', keys: cfg.rapidApiKeys });
  return providers;
}

/** Stato chiavi dell'esecuzione (execution_logs/{runId}/state/api_keys), creato al primo uso. */
function ensureKeyState_(rt) {
  if (rt.keyState) return rt.keyState;
  var statePath = rt.runPath + '/state/api_keys';
  rt.keyState = fsRunTransaction_(function (tx) {
    var snap = fsGet_(statePath, tx);
    if (snap) return { writes: [], result: { cycle: Number(snap.data.cycle || 0), exhausted: snap.data.exhausted || [], startKeyId: snap.data.startKeyId } };
    var prior = fsGet_('engine_state/api_keys', tx);
    var previous = { cycle: Number((prior && prior.data.cycle) || 0), exhausted: (prior && prior.data.exhausted) || [] };
    var state = beginKeyRun_(previous, rt.candidates);
    return { writes: [fsSet_(statePath, state), fsSet_('engine_state/api_keys', { cycle: state.cycle, exhausted: previous.exhausted })], result: state };
  });
  if (!rt.keyState.startKeyId) delete rt.keyState.startKeyId;
  return rt.keyState;
}

/** HTTP 429: la chiave resta esclusa per tutta l'esecuzione e viene segnata anche nello stato globale. */
function markKeyExhausted_(rt, keyId) {
  var statePath = rt.runPath + '/state/api_keys';
  fsRunTransaction_(function (tx) {
    var local = fsGet_(statePath, tx), global = fsGet_('engine_state/api_keys', tx);
    var localList = unique_(((local && local.data.exhausted) || []).concat([keyId]));
    var globalList = unique_(((global && global.data.exhausted) || []).concat([keyId]));
    return [fsMerge_(statePath, { exhausted: localList }), fsSet_('engine_state/api_keys', { cycle: Number((global && global.data.cycle) || 0), exhausted: globalList })];
  });
  if (rt.keyState.exhausted.indexOf(keyId) < 0) rt.keyState.exhausted.push(keyId);
}

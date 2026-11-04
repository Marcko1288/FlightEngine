/**
 * Diagnostica nello stesso formato di request-log.ts: execution_logs/{runId}/entries con
 * eventi (kind=EVENT) e chiamate (kind=CALL, corpo in entries/{id}/body/{00000000}).
 */

var FE_HTTP_STATUS_TEXT = { 200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** Richiesta di arresto dalla webapp (stopFlightSearch imposta cancelRequestedAt). */
function checkCancel_(rt, force) {
  if (!rt.cancelled && (force || Date.now() - (rt.lastCancelCheck || 0) >= FE_CONFIG.CANCEL_CHECK_INTERVAL_MS)) {
    rt.lastCancelCheck = Date.now();
    var snap = fsGet_(rt.runPath);
    if (!snap || snap.data.cancelRequestedAt || ['RUNNING', 'QUEUED'].indexOf(snap.data.status) < 0) rt.cancelled = true;
  }
  if (rt.cancelled) throw new RunStopped_('CANCELLED', 'Esecuzione arrestata su richiesta.');
}

function eventWrites_(rt, searchId, message, data) {
  var entry = { kind: 'EVENT', startedAt: fsServerTimestamp_(), searchId: searchId, message: message };
  Object.keys(data || {}).forEach(function (k) { if (!(k in entry)) entry[k] = data[k]; });
  return [
    fsUpdate_(rt.runPath, { lastActivityAt: fsServerTimestamp_(), heartbeatAt: fsServerTimestamp_(), lastEvent: message, currentSearchId: searchId }),
    fsCreate_(rt.runPath + '/entries/' + randomId_(), entry)
  ];
}

function logEvent_(rt, ctx, message, data, skipCancelCheck) {
  if (!skipCancelCheck) checkCancel_(rt);
  fsCommit_(eventWrites_(rt, ctx.searchId || '', message, data));
}

function lowerKeys_(headers) {
  var out = {};
  Object.keys(headers || {}).forEach(function (k) { out[k.toLowerCase()] = headers[k]; });
  return out;
}

/** Una chiamata HTTP al provider, registrata come in loggedRequest(). */
function loggedRequest_(rt, request, ctx, key, attempt) {
  checkCancel_(rt);
  var entryPath = rt.runPath + '/entries/' + randomId_(), started = Date.now();
  var safe = function (text) { return redact_(text, [key]); };
  fsCommit_([
    fsCreate_(entryPath, {
      kind: 'CALL', startedAt: fsServerTimestamp_(), searchId: ctx.searchId, leg: ctx.leg || '', provider: request.kind === 'serp' ? 'SerpApi' : 'RapidAPI', status: 'RUNNING',
      request: { method: 'GET', url: safe(request.url), headers: JSON.parse(safe(JSON.stringify(lowerKeys_(request.headers)))) },
      keyIndex: ctx.keyIndex == null ? null : ctx.keyIndex, keyCycle: ctx.keyCycle == null ? null : ctx.keyCycle, attempt: attempt, executor: FE_CONFIG.EXECUTOR
    }),
    fsUpdate_(rt.runPath, { apiCalls: fsIncrement_(1), heartbeatAt: fsServerTimestamp_() })
  ]);
  rt.apiCalls++;
  var res;
  try {
    res = UrlFetchApp.fetch(request.url, { method: 'get', headers: request.headers, muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    var message = safe(['FetchError', errorMessage_(e)].join(': '));
    fsCommit_([fsUpdate_(entryPath, { status: 'ERROR', message: message, finishedAt: fsServerTimestamp_(), durationMs: Date.now() - started })]);
    return { parsed: { status: 'ERROR', message: message }, transient: true, httpStatus: 0 };
  }
  var code = res.getResponseCode(), headers = lowerKeys_(res.getAllHeaders()), body = res.getContentText();
  var parsed = parseResponse_(code, body, request.kind, ctx.maxStops);
  var chunks = rt.cfg.logResponseBodies ? bodyChunks_(safe(body)) : [];
  var writes = chunks.map(function (text, i) { return fsSet_(entryPath + '/body/' + String(i).padStart(8, '0'), { index: i, text: text }); });
  writes.push(fsUpdate_(entryPath, {
    httpStatus: code, httpStatusText: FE_HTTP_STATUS_TEXT[code] || '', responseHeaders: JSON.parse(safe(JSON.stringify(headers))),
    status: parsed.status, message: parsed.status === 'OK' ? 'Offerta trovata' : parsed.message, price: parsed.status === 'OK' ? parsed.price : null,
    bodyChunks: chunks.length, bodyLogged: rt.cfg.logResponseBodies, responseBytes: body.length,
    finishedAt: fsServerTimestamp_(), durationMs: Date.now() - started
  }));
  for (var i = 0; i < writes.length; i += FE_CONFIG.BODY_CHUNKS_PER_COMMIT) fsCommit_(writes.slice(i, i + FE_CONFIG.BODY_CHUNKS_PER_COMMIT));
  var retryAfter = Number(headers['retry-after']);
  return { parsed: parsed, transient: code >= 500 && code <= 599, httpStatus: code, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null };
}

/** Errori transitori (5xx, rete): al massimo HTTP_RETRY_BACKOFF_MS.length nuovi tentativi con backoff. */
function requestWithRetry_(rt, request, ctx, key) {
  var delays = FE_CONFIG.HTTP_RETRY_BACKOFF_MS, attempts = 0;
  for (;;) {
    attempts++;
    var out = loggedRequest_(rt, request, ctx, key, attempts);
    out.attempts = attempts;
    if (!out.transient || attempts > delays.length) return out;
    var wait = delays[attempts - 1];
    if (outOfBudget_(rt, wait + 60000)) throw new PauseSignal_(attempts, []);
    logEvent_(rt, ctx, 'Errore temporaneo del provider: nuovo tentativo', { provider: request.kind === 'serp' ? 'SerpApi' : 'RapidAPI', httpStatus: out.httpStatus, attempt: attempts, waitMs: wait });
    sleep_(wait);
  }
}

/** Porting di fetchTrip(): selezione chiave, chiamata, rotazione su HTTP 429, arresto a giro concluso. */
function fetchTrip_(rt, trip, s, settings, searchId) {
  var calls = 0, warnings = [], attempted = new Set();
  var ctx = { searchId: searchId };
  for (;;) {
    var state = ensureKeyState_(rt);
    var available = selectKey_(state, rt.candidates, new Set()).key;
    var selected = selectKey_(state, rt.candidates, attempted).key;
    if (!selected) {
      var message = 'Tutte le chiavi sono sature o assenti: esecuzione delle chiamate terminata, nessun nuovo giro.';
      warnings.push(message);
      logEvent_(rt, ctx, message, { cycle: state.cycle });
      return { calls: calls, warnings: warnings, options: [], exhausted: !available };
    }
    if (rt.apiCalls >= rt.cfg.maxCallsPerRun) {
      var cap = 'Limite di sicurezza di ' + rt.cfg.maxCallsPerRun + ' chiamate per esecuzione raggiunto: nessuna nuova chiamata.';
      warnings.push(cap);
      logEvent_(rt, ctx, cap, { apiCalls: rt.apiCalls });
      return { calls: calls, warnings: warnings, options: [], exhausted: true };
    }
    if (outOfBudget_(rt, 60000)) throw new PauseSignal_(calls, warnings);
    attempted.add(selected.id);
    var request = tripRequest_(selected.provider, selected.key, trip, s.travelers, s.maxStops, settings.currency);
    logEvent_(rt, ctx, 'Chiave selezionata', { provider: selected.provider, keyIndex: selected.index, cycle: state.cycle, leg: trip.leg, departureDate: trip.departureDate, returnDate: trip.returnDate || null });
    var result;
    try {
      result = requestWithRetry_(rt, request, { searchId: searchId, leg: trip.leg, keyIndex: selected.index, keyCycle: state.cycle, maxStops: s.maxStops }, selected.key);
    } catch (e) {
      if (e instanceof PauseSignal_) { e.calls += calls; e.warnings = warnings.concat(e.warnings); }
      throw e;
    }
    calls += result.attempts;
    var parsed = result.parsed;
    if (parsed.status === 'LIMIT') {
      markKeyExhausted_(rt, selected.id);
      warnings.push(selected.provider + ' chiave ' + selected.index + ': ' + parsed.message);
      var backoff = Math.min(FE_CONFIG.LIMIT_BACKOFF_MAX_MS, result.retryAfterMs == null ? FE_CONFIG.LIMIT_BACKOFF_DEFAULT_MS : result.retryAfterMs);
      logEvent_(rt, ctx, "Quota esaurita: chiave esclusa per tutta l'esecuzione", { provider: selected.provider, keyIndex: selected.index, cycle: state.cycle, backoffMs: backoff });
      sleep_(backoff);
      continue;
    }
    if (parsed.status === 'ERROR') warnings.push(selected.provider + ' ' + trip.origin + '-' + trip.destination + ' ' + trip.departureDate + ': ' + parsed.message);
    return { calls: calls, warnings: warnings, provider: selected.provider, options: parsed.status === 'OK' ? parsed.options : [] };
  }
}

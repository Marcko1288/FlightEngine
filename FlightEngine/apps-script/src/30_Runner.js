/**
 * Esecuzione delle ricerche: porting di enqueueRun / processSearchTask / finishTask
 * (functions/src/index.ts) con elaborazione a blocchi riprendibili.
 *
 * Documenti scritti (stessi che la webapp legge):
 *   execution_logs/{runId}                 sessione (contatori, stato, heartbeat)
 *   execution_logs/{runId}/tasks/{id}      sotto-task per ricerca
 *   execution_logs/{runId}/entries/*       eventi e chiamate (diagnostica)
 *   execution_logs/{runId}/state/api_keys  rotazione chiavi dell'esecuzione
 *   flight_results/{sha256(runId:searchId:index)}
 *   flight_searches/{id}                   lastCheckAt, lastStatus, lastPrice
 * Stato di ripresa (non letto dalla webapp):
 *   execution_logs/{runId}/tasks/{id}/progress/plan     viaggi pianificati
 *   execution_logs/{runId}/tasks/{id}/progress/current  cursore e offerte trattenute
 *   execution_logs/{runId}/tasks/{id}/legs/{sha256}     risposte già ottenute per tratta
 */

var FE_FINAL_TASK_STATUSES = ['OK', 'WARNING', 'CANCELLED', 'ERROR'];

function newRuntime_() {
  return { started: Date.now(), budgetMs: FE_CONFIG.TIME_BUDGET_MS, cfg: getConfig_(), keyState: null, apiCalls: 0, cancelled: false, lastCancelCheck: 0 };
}

/** true se mancano meno di reserveMs al termine del budget del blocco corrente. */
function outOfBudget_(rt, reserveMs) {
  return Date.now() - rt.started > rt.budgetMs - (reserveMs || 0);
}

function bindRun_(rt, runId) {
  rt.runId = runId;
  rt.runPath = 'execution_logs/' + runId;
}

/**
 * Crea una sessione nello stesso formato di enqueueRun (mode SAVED) e i relativi sotto-task.
 * opts: { trigger: "SCHEDULE"|"MANUAL_TEST", slot?: string, searchIds?: string[] }
 */
function createRun_(rt, opts) {
  var settingsSnap = fsGet_('settings/global');
  var settings = mergedSettings_(settingsSnap && settingsSnap.data);
  var docs = opts.searchIds
    ? opts.searchIds.map(function (id) { return fsGet_('flight_searches/' + id); }).filter(Boolean)
    : fsQuery_('', 'flight_searches', [['active', true]]);
  if (opts.searchIds && !docs.length) throw new Error('Ricerca non trovata: ' + opts.searchIds.join(', '));
  var entries = [], invalid = [];
  docs.forEach(function (d) {
    try { entries.push({ id: d.id, search: normalizeSearch_(d.data) }); }
    catch (e) { invalid.push('Ricerca ' + (d.data.destinationName || d.id) + ' ignorata: ' + errorMessage_(e)); }
  });
  bindRun_(rt, randomId_());
  var warnings = invalid.concat(entries.length ? [] : ['Nessuna ricerca attiva salvata.']);
  var run = {
    startedAt: fsServerTimestamp_(), status: entries.length ? 'QUEUED' : 'WARNING', apiCalls: 0, results: 0, alerts: 0, completedSearches: 0,
    runningSearches: 0, queuedSearches: entries.length, failedSearches: 0, warningSearches: 0, searches: entries.length,
    logVersion: 2, controlVersion: 2, mode: 'SAVED', settings: settings,
    executor: FE_CONFIG.EXECUTOR, trigger: opts.trigger, scheduleSlot: opts.slot || null, heartbeatAt: fsServerTimestamp_()
  };
  if (warnings.length) run.warnings = warnings;
  if (!entries.length) { run.finishedAt = fsServerTimestamp_(); run.durationMs = 0; run.postProcessedAt = fsServerTimestamp_(); }
  fsCommit_([fsCreate_(rt.runPath, run)]);
  logEvent_(rt, { searchId: '' }, opts.trigger === 'MANUAL_TEST' ? 'Test manuale accodato (Apps Script)' : 'Sotto-task delle ricerche accodati', { count: entries.length, maxConcurrent: 1, executor: FE_CONFIG.EXECUTOR, trigger: opts.trigger, scheduleSlot: opts.slot || null }, true);
  if (!entries.length) return { runId: rt.runId, status: 'WARNING', searches: 0 };
  if (!settings.serpApiEnabled && !settings.rapidApiEnabled) {
    fsCommit_([fsUpdate_(rt.runPath, { status: 'ERROR', finishedAt: fsServerTimestamp_(), error: 'Nessun provider abilitato.', postProcessedAt: fsServerTimestamp_() })]);
    return { runId: rt.runId, status: 'ERROR', searches: entries.length };
  }
  fsCommitAll_(entries.map(function (e) {
    return fsSet_(rt.runPath + '/tasks/' + e.id, { searchId: e.id, search: e.search, saved: true, status: 'QUEUED', createdAt: fsServerTimestamp_(), attempts: 0 });
  }));
  return { runId: rt.runId, status: 'QUEUED', searches: entries.length };
}

/** Elabora la sessione finché c'è tempo. Restituisce "DONE" o "PAUSED". */
function processRun_(rt, runId) {
  bindRun_(rt, runId);
  var snap = fsGet_(rt.runPath);
  if (!snap) return 'DONE';
  var run = snap.data;
  if (['RUNNING', 'QUEUED'].indexOf(run.status) < 0) {
    if (!run.postProcessedAt && run.finishedAt) finalizeRun_(rt);
    return 'DONE';
  }
  rt.run = run;
  rt.settings = mergedSettings_(run.settings);
  rt.apiCalls = Number(run.apiCalls || 0);
  rt.keyState = null;
  rt.candidates = keyCandidates_(runProviders_(rt.settings));
  rt.cancelled = !!run.cancelRequestedAt;
  rt.lastCancelCheck = Date.now();
  if (run.nextResumeAt) logEvent_(rt, { searchId: '' }, 'Ripresa dell\'esecuzione (nuovo blocco Apps Script)', { apiCalls: rt.apiCalls }, true);

  var pending = false;
  var tasks = fsQuery_(rt.runPath, 'tasks', [], [['createdAt', 'ASCENDING']]);
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (FE_FINAL_TASK_STATUSES.indexOf(t.data.status) >= 0) continue;
    try { checkCancel_(rt, true); }
    catch (e) {
      if (!(e instanceof RunStopped_)) throw e;
      finishTask_(rt, t.id, { status: 'CANCELLED', calls: 0, results: 0, alerts: 0, warnings: [] });
      continue;
    }
    if (t.data.status === 'RETRYING' && t.data.retryNotBefore instanceof Date && t.data.retryNotBefore.getTime() > Date.now()) { pending = true; continue; }
    if (outOfBudget_(rt, 90000)) { pending = true; break; }
    try { processTask_(rt, t); }
    catch (e) {
      if (e instanceof PauseSignal_) { pending = true; break; }
      throw e;
    }
  }
  if (!pending) {
    var open = fsQuery_(rt.runPath, 'tasks', [], []).filter(function (x) { return FE_FINAL_TASK_STATUSES.indexOf(x.data.status) < 0; });
    if (!open.length) { finalizeRun_(rt); return 'DONE'; }
  }
  var resumeAt = new Date(Date.now() + FE_CONFIG.TRIGGER_MINUTES * 60 * 1000);
  fsCommit_(eventWrites_(rt, '', 'Blocco di elaborazione concluso: ripresa al prossimo trigger', { nextResumeAt: resumeAt, apiCalls: rt.apiCalls }).concat([fsUpdate_(rt.runPath, { nextResumeAt: resumeAt })]));
  return 'PAUSED';
}

function updateSearchStatus_(rt, searchId, data) {
  try { fsCommit_([fsUpdate_('flight_searches/' + searchId, data)]); }
  catch (e) {
    if (e instanceof FirestoreError_ && (e.httpStatus === 404 || e.code === 'NOT_FOUND')) logEvent_(rt, { searchId: searchId }, 'Ricerca eliminata durante l\'esecuzione: stato non aggiornato', {}, true);
    else throw e;
  }
}

function latestPrice_(searchId) {
  var docs = fsQuery_('', 'flight_results', [['searchId', searchId]], [['checkedAt', 'DESCENDING']], 1);
  return docs.length ? Number(docs[0].data.pricePerPerson) : null;
}

function isDrop_(old, current, pct) { return old !== null && current <= old * (1 - pct / 100); }

function loadOrCreatePlan_(rt, taskPath, search, settings, ctx) {
  var planPath = taskPath + '/progress/plan', existing = fsGet_(planPath);
  if (existing) return existing.data;
  logEvent_(rt, ctx, 'Avvio sotto-task ricerca', { search: search });
  var dates = departureDates_(search, settings.monthsAhead);
  var queries = tripQueries_(search, dates, airportCodes_(search.origin), airportCodes_(search.destination), airportCodes_(search.returnOrigin || search.destination), airportCodes_(search.returnDestination || search.origin));
  var planned = plannedRequests_(queries), info = { dates: dates, allowedDays: search.allowedDays, nights: search.nights, airportPairsPerDate: dates.length ? queries.length / dates.length : 0 };
  Object.keys(planned).forEach(function (k) { info[k] = planned[k]; });
  info.note = 'Tentativi aggiuntivi solo per cambio chiave satura o errori temporanei (max ' + FE_CONFIG.HTTP_RETRY_BACKOFF_MS.length + '); arresto al termine del giro.';
  logEvent_(rt, ctx, 'Piano chiamate A/R', info);
  var plan = { queries: queries, createdAt: new Date() };
  if (JSON.stringify(plan).length > 900000) throw new Error('Piano di ricerca troppo grande (' + queries.length + ' combinazioni): riduci date o aeroporti.');
  fsCommit_([fsSet_(planPath, plan), fsUpdate_(taskPath, { progressTrips: queries.length, progressCursor: 0 })]);
  return plan;
}

function loadLegs_(taskPath) {
  var cache = {};
  fsQuery_(taskPath, 'legs', [], []).forEach(function (d) { cache[d.data.key] = d.data.reply; });
  return cache;
}

/** Porting di processSearchTask. Restituisce true se la sessione è conclusa. */
function processTask_(rt, t) {
  var task = t.data, taskId = t.id, taskPath = rt.runPath + '/tasks/' + taskId, currentPath = taskPath + '/progress/current';
  var settings = rt.settings, searchId = task.searchId, ctx = { searchId: searchId };
  var attempts = Number(task.attempts || 0);
  if (task.status !== 'RUNNING') {
    attempts++;
    fsCommit_([
      fsUpdate_(taskPath, { status: 'RUNNING', startedAt: fsServerTimestamp_(), attempts: fsIncrement_(1), retryNotBefore: fsDeleteField_() }),
      fsUpdate_(rt.runPath, { status: 'RUNNING', queuedSearches: fsIncrement_(-1), runningSearches: fsIncrement_(1), heartbeatAt: fsServerTimestamp_() })
    ]);
  }
  try {
    var search = normalizeSearch_(task.search);
    if (!insideHorizon_(search.departureFrom, settings.monthsAhead)) {
      var reason = 'Data di partenza oltre i mesi di anticipo configurati.';
      logEvent_(rt, ctx, reason, { search: search });
      if (task.saved) updateSearchStatus_(rt, searchId, { lastCheckAt: fsServerTimestamp_(), lastStatus: reason });
      return finishTask_(rt, taskId, { status: 'WARNING', calls: 0, results: 0, alerts: 0, warnings: [reason] });
    }
    var plan = loadOrCreatePlan_(rt, taskPath, search, settings, ctx);
    var currentSnap = fsGet_(currentPath);
    var current = currentSnap ? currentSnap.data : newRoundTripProgress_();
    var offers;
    if (!current.done) {
      var cache = loadLegs_(taskPath);
      if (currentSnap) logEvent_(rt, ctx, 'Ripresa sotto-task ricerca', { cursor: current.cursor, trips: plan.queries.length, cachedLegs: Object.keys(cache).length });
      var saveProgress = function (extra) {
        return [fsSet_(currentPath, current), fsUpdate_(taskPath, { calls: current.calls, progressCursor: current.cursor, progressTrips: plan.queries.length })].concat(extra || []);
      };
      try {
        offers = collectRoundTripsStep_(plan.queries, search.travelers, settings.topResults, current, cache, {
          request: function (q) { return fetchTrip_(rt, q, search, settings, searchId); },
          onLeg: function (key, reply) { fsCommit_(saveProgress([fsSet_(taskPath + '/legs/' + sha256Hex_(key), { key: key, reply: reply })])); }
        });
      } catch (e) {
        if (e instanceof PauseSignal_) fsCommit_(saveProgress());
        throw e;
      }
      fsCommit_(saveProgress());
    } else {
      offers = { calls: current.calls, warnings: unique_(current.warnings), items: current.items };
    }
    logEvent_(rt, ctx, 'Ricerca completata', { calls: offers.calls, results: offers.items.length, warnings: offers.warnings });
    var warnings = offers.warnings.slice();
    if (!offers.calls) warnings.push('Nessuna chiamata effettuata. Controlla date, giorni, aeroporti e chiavi API.');
    var prior = latestPrice_(searchId), checkedAt = new Date(), writes = [], saved = 0, alerts = 0;
    offers.items.slice(0, Math.max(1, settings.topResults)).forEach(function (offer, index) {
      var out = legDetails_(offer.outbound), back = legDetails_(offer.return);
      var alert = offer.pricePerPerson <= search.pricePerPerson || isDrop_(prior, offer.pricePerPerson, settings.dropAlertPercent);
      var result = {};
      Object.keys(offer).forEach(function (k) { result[k] = offer[k]; });
      result.provider = providerName_(offer.provider);
      result.searchId = searchId;
      result.runId = rt.runId;
      result.destinationName = search.destinationName;
      result.cluster = search.cluster;
      result.currency = settings.currency;
      result.travelers = search.travelers;
      result.maxStops = search.maxStops;
      result.origin = out.origin.code || search.origin;
      result.destination = out.destination.code || search.destination;
      result.returnOrigin = back.origin.code || offer.returnOrigin || search.returnOrigin || search.destination;
      result.returnDestination = back.destination.code || offer.returnDestination || search.returnDestination || search.origin;
      result.checkedAt = checkedAt;
      result.alert = alert;
      writes.push(fsSet_('flight_results/' + sha256Hex_(rt.runId + ':' + searchId + ':' + index), result));
      saved++;
      if (alert) alerts++;
    });
    checkCancel_(rt);
    if (writes.length) fsCommit_(writes);
    if (task.saved) {
      var status = { lastCheckAt: fsServerTimestamp_(), lastStatus: warnings.length ? 'PROVIDER_WARNING' : !offers.calls ? 'NO_CALLS' : offers.items.length ? 'OK' : 'NO_FLIGHTS' };
      if (offers.items[0]) { status.lastPrice = offers.items[0].pricePerPerson; status.lastPriceCurrency = settings.currency; }
      updateSearchStatus_(rt, searchId, status);
    }
    return finishTask_(rt, taskId, { status: warnings.length ? 'WARNING' : 'OK', calls: offers.calls, results: saved, alerts: alerts, warnings: warnings });
  } catch (e) {
    if (e instanceof PauseSignal_) throw e;
    if (e instanceof RunStopped_ && e.status === 'CANCELLED') return finishTask_(rt, taskId, { status: 'CANCELLED', calls: 0, results: 0, alerts: 0, warnings: [e.message] });
    var message = errorMessage_(e);
    console.error('flight-task-error', JSON.stringify({ runId: rt.runId, taskId: taskId, attempts: attempts, error: message }));
    if (attempts >= FE_CONFIG.MAX_TASK_ATTEMPTS) return finishTask_(rt, taskId, { status: 'ERROR', calls: 0, results: 0, alerts: 0, warnings: [message] });
    fsCommit_([
      fsUpdate_(taskPath, { status: 'RETRYING', error: message, finishedAt: fsServerTimestamp_(), retryNotBefore: new Date(Date.now() + FE_CONFIG.TASK_RETRY_DELAY_MS) }),
      fsUpdate_(rt.runPath, { runningSearches: fsIncrement_(-1), queuedSearches: fsIncrement_(1) })
    ].concat(eventWrites_(rt, searchId, 'Errore nel sotto-task: nuovo tentativo programmato', { error: message, attempt: attempts, maxAttempts: FE_CONFIG.MAX_TASK_ATTEMPTS })));
    return false;
  }
}

/** Porting di finishTask (parte transazionale). Restituisce true se è l'ultimo sotto-task. */
function finishTask_(rt, taskId, outcome) {
  var taskPath = rt.runPath + '/tasks/' + taskId, final = false;
  fsRunTransaction_(function (tx) {
    var runSnap = fsGet_(rt.runPath, tx), taskSnap = fsGet_(taskPath, tx);
    var t = taskSnap ? taskSnap.data : {};
    final = false;
    if (FE_FINAL_TASK_STATUSES.indexOf(t.status) >= 0) return [];
    var r = runSnap.data, previous = t.status;
    var completed = Number(r.completedSearches || 0) + 1, total = Number(r.searches || 0);
    var failed = Number(r.failedSearches || 0) + (outcome.status === 'ERROR' ? 1 : 0), warning = Number(r.warningSearches || 0) + (outcome.status === 'WARNING' ? 1 : 0);
    final = completed >= total;
    var taskUpdate = { finishedAt: fsServerTimestamp_(), durationMs: Date.now() - (t.startedAt instanceof Date ? t.startedAt.getTime() : Date.now()) };
    Object.keys(outcome).forEach(function (k) { taskUpdate[k] = outcome[k]; });
    var runUpdate = { completedSearches: completed, results: fsIncrement_(outcome.results), alerts: fsIncrement_(outcome.alerts), warningSearches: warning, failedSearches: failed, heartbeatAt: fsServerTimestamp_() };
    if (['QUEUED', 'RETRYING'].indexOf(previous) >= 0) runUpdate.queuedSearches = Math.max(0, Number(r.queuedSearches || 0) - 1);
    else runUpdate.runningSearches = Math.max(0, Number(r.runningSearches || 0) - 1);
    // Una sessione già archiviata dalla webapp (INTERRUPTED) mantiene il proprio stato.
    if (final && ['RUNNING', 'QUEUED'].indexOf(r.status) >= 0) {
      runUpdate.status = r.cancelRequestedAt ? 'CANCELLED' : failed > 0 ? 'ERROR' : warning > 0 ? 'WARNING' : 'OK';
      runUpdate.finishedAt = fsServerTimestamp_();
      runUpdate.durationMs = Date.now() - (r.startedAt instanceof Date ? r.startedAt.getTime() : Date.now());
      runUpdate.nextResumeAt = fsDeleteField_();
    }
    return [fsUpdate_(taskPath, taskUpdate), fsUpdate_(rt.runPath, runUpdate)];
  });
  return final;
}

/** Parte finale di finishTask: email di alert e chiusura. Idempotente (postProcessedAt). */
function finalizeRun_(rt) {
  var run = fsGet_(rt.runPath).data;
  if (run.postProcessedAt) return;
  var settings = mergedSettings_(run.settings), ctx = { searchId: '' };
  if (!run.cancelRequestedAt && settings.emailTo) {
    var results = fsQuery_('', 'flight_results', [['runId', rt.runId]]).map(function (d) { return d.data; }).filter(function (x) { return x.alert; });
    if (results.length && !rt.cfg.emailEnabled) logEvent_(rt, ctx, 'Email di alert non inviata: EMAIL_ENABLED=false nelle Script Properties', { alerts: results.length }, true);
    else if (results.length) {
      try {
        var thresholds = {};
        fsQuery_(rt.runPath, 'tasks', [], []).forEach(function (d) { if (d.data.search) thresholds[d.id] = Number(d.data.search.pricePerPerson); });
        sendAlertEmail_(settings.emailTo, results, settings.currency, { runId: rt.runId, thresholds: thresholds, dropAlertPercent: settings.dropAlertPercent, startedAt: run.startedAt });
        logEvent_(rt, ctx, 'Email di alert inviata', { alerts: results.length }, true);
      } catch (e) {
        fsCommit_([fsUpdate_(rt.runPath, { status: 'WARNING', emailError: errorMessage_(e) })]);
        logEvent_(rt, ctx, 'Invio email non riuscito', { error: errorMessage_(e) }, true);
      }
    }
  }
  logEvent_(rt, ctx, 'Tutti i sotto-task sono terminati', {}, true);
  fsCommit_([fsUpdate_(rt.runPath, { postProcessedAt: fsServerTimestamp_(), nextResumeAt: fsDeleteField_() })]);
}

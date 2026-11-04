/**
 * Funzioni pubbliche (eseguibili dal menu "Esegui" dell'editor Apps Script).
 *   runScheduler()          handler del trigger time-driven (ogni 5 minuti)
 *   setupTrigger()          verifica la configurazione e installa il trigger
 *   removeTrigger()         rimuove il trigger
 *   checkConfiguration()    verifica Script Properties, accesso Firestore e chiavi
 *   dryRunSchedule()        mostra slot dovuto / prossimo slot senza scrivere né chiamare provider
 *   testSingleSearch()      esegue la ricerca indicata in TEST_SEARCH_ID
 *   testSingleSearchById(id)
 *   clearActiveRun()        sblocca lo scheduler se un'esecuzione è rimasta agganciata
 */

function runScheduler() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('[Flight Engine] Esecuzione precedente ancora attiva: passaggio saltato.'); return; }
  try { return schedulerTick_(); }
  finally { lock.releaseLock(); }
}

function setupTrigger() {
  var report = checkConfiguration();
  removeTriggers_();
  ScriptApp.newTrigger(FE_CONFIG.TRIGGER_HANDLER).timeBased().everyMinutes(FE_CONFIG.TRIGGER_MINUTES).create();
  fsCommit_([schedulerStatusWrite_({ triggerInstalled: true, triggerInstalledAt: fsServerTimestamp_(), lastError: null })]);
  console.log('[Flight Engine] Trigger installato: ' + FE_CONFIG.TRIGGER_HANDLER + ' ogni ' + FE_CONFIG.TRIGGER_MINUTES + ' minuti.');
  return report;
}

function removeTrigger() {
  var removed = removeTriggers_();
  try { fsCommit_([schedulerStatusWrite_({ triggerInstalled: false, triggerRemovedAt: fsServerTimestamp_() })]); }
  catch (e) { console.warn('Stato scheduler non aggiornato: ' + errorMessage_(e)); }
  console.log('[Flight Engine] Trigger rimossi: ' + removed);
  return removed;
}

function removeTriggers_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === FE_CONFIG.TRIGGER_HANDLER) { ScriptApp.deleteTrigger(t); removed++; }
  });
  return removed;
}

function checkConfiguration() {
  FE_CONFIG_CACHE_ = null;
  var cfg = getConfig_();
  firestoreAccessToken_(true);
  var settings = mergedSettings_((fsGet_('settings/global') || { data: {} }).data);
  var active = fsQuery_('', 'flight_searches', [['active', true]]).length;
  var report = {
    projectId: cfg.projectId, serviceAccount: cfg.serviceAccount.client_email,
    serpApiKeys: cfg.serpApiKeys.length, rapidApiKeys: cfg.rapidApiKeys.length,
    serpApiEnabled: settings.serpApiEnabled, rapidApiEnabled: settings.rapidApiEnabled,
    activeSearches: active, logResponseBodies: cfg.logResponseBodies, emailEnabled: cfg.emailEnabled, emailTo: settings.emailTo || '(non impostata)',
    schedule: settings.scheduleEnabled ? settings.scheduleDays.join(',') + ' ' + String(settings.scheduleHour).padStart(2, '0') + ':' + String(settings.scheduleMinute).padStart(2, '0') + ' ' + settings.scheduleTimezone : 'disattivata'
  };
  var problems = [];
  if (settings.serpApiEnabled && !cfg.serpApiKeys.length) problems.push('SerpApi è attiva ma SERPAPI_KEYS è vuota.');
  if (settings.rapidApiEnabled && !cfg.rapidApiKeys.length) problems.push('RapidAPI è attiva ma RAPIDAPI_KEYS è vuota.');
  if (!settings.serpApiEnabled && !settings.rapidApiEnabled) problems.push('Nessun provider abilitato nelle Impostazioni.');
  report.problems = problems;
  console.log('[Flight Engine] Configurazione: ' + JSON.stringify(report, null, 2));
  return report;
}

function dryRunSchedule() {
  var settings = mergedSettings_((fsGet_('settings/global') || { data: {} }).data), now = new Date();
  var due = dueSlot_(settings, now), sched = fsGet_('engine_state/scheduler');
  var report = {
    now: now.toISOString(), scheduleEnabled: settings.scheduleEnabled, lastScheduleSlot: settings.lastScheduleSlot || null,
    dueSlot: due ? due.slot : null, wouldStart: !!due && due.slot !== settings.lastScheduleSlot && !(sched && sched.data.activeRunId),
    activeRunId: (sched && sched.data.activeRunId) || null, nextScheduleAt: (nextScheduleAt_(settings, now) || { toISOString: function () { return null; } }).toISOString(),
    activeSearches: fsQuery_('', 'flight_searches', [['active', true]]).length
  };
  console.log('[Flight Engine] Dry run: ' + JSON.stringify(report, null, 2));
  return report;
}

function testSingleSearch() {
  var id = getConfig_().testSearchId;
  if (!id) throw new Error('Imposta la Script Property TEST_SEARCH_ID con l\'id del documento flight_searches da provare.');
  return testSingleSearchById(id);
}

/** Esegue subito una sola ricerca salvata con la stessa logica delle run schedulate. */
function testSingleSearchById(searchId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Lo scheduler è in esecuzione: riprova fra qualche minuto.');
  try {
    var sched = fsGet_('engine_state/scheduler');
    if (sched && sched.data.activeRunId) throw new Error('Esecuzione ' + sched.data.activeRunId + ' in corso: attendi la fine o usa clearActiveRun().');
    var rt = newRuntime_();
    var created = createRun_(rt, { trigger: 'MANUAL_TEST', searchIds: [String(searchId).trim()] });
    if (created.status !== 'QUEUED') { console.log('[Flight Engine] Test chiuso con stato ' + created.status + ' (run ' + created.runId + ').'); return created; }
    fsCommit_([schedulerStatusWrite_({ activeRunId: created.runId })]);
    var outcome = processRun_(rt, created.runId);
    if (outcome === 'DONE') fsCommit_([schedulerStatusWrite_({ activeRunId: null })]);
    var run = fsGet_('execution_logs/' + created.runId).data;
    var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === FE_CONFIG.TRIGGER_HANDLER; });
    var summary = { runId: created.runId, outcome: outcome, status: run.status, apiCalls: run.apiCalls, results: run.results, alerts: run.alerts, warnings: run.warnings || [] };
    if (outcome !== 'DONE') summary.note = hasTrigger ? 'Tempo esaurito: il trigger riprende l\'esecuzione entro 5 minuti.' : 'Tempo esaurito e trigger non installato: esegui di nuovo runScheduler() o setupTrigger().';
    console.log('[Flight Engine] Test: ' + JSON.stringify(summary, null, 2));
    return summary;
  } finally { lock.releaseLock(); }
}

/** Sblocca lo scheduler (non modifica la sessione: per chiuderla usa "Arresta" nella webapp). */
function clearActiveRun() {
  fsCommit_([schedulerStatusWrite_({ activeRunId: null })]);
  console.log('[Flight Engine] activeRunId azzerato.');
}

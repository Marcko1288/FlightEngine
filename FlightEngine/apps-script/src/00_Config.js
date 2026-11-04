/**
 * Flight Engine – scheduler Google Apps Script.
 *
 * Lo script è legato (container-bound) al foglio "2026_11_Monitoraggio Voli" solo come
 * contenitore: non legge né scrive celle. Legge la configurazione da Firestore, esegue le
 * ricerche schedulate ai provider e scrive risultati e diagnostica negli stessi documenti
 * che la webapp già legge.
 *
 * Credenziali e chiavi stanno SOLO nelle Script Properties (vedi README):
 *   SERVICE_ACCOUNT_JSON  JSON completo della chiave del service account Firebase
 *   FIREBASE_PROJECT_ID   facoltativo, default project_id del service account
 *   SERPAPI_KEYS          array JSON di chiavi SerpApi (stesso formato del secret Firebase)
 *   RAPIDAPI_KEYS         array JSON di chiavi RapidAPI
 *   LOG_RESPONSE_BODIES   "true" (default) / "false": salva il corpo delle risposte nei log
 *   EMAIL_ENABLED         "true" (default) / "false": email di alert a fine esecuzione
 *   MAX_CALLS_PER_RUN     facoltativo, tetto di sicurezza delle chiamate provider per run
 *   TEST_SEARCH_ID        facoltativo, id della ricerca usata da testSingleSearch()
 */
var FE_CONFIG = {
  TRIGGER_HANDLER: 'runScheduler',
  TRIGGER_MINUTES: 5,
  // Apps Script interrompe l'esecuzione a 6 minuti: si lascia margine per l'ultima chiamata
  // in corso (fino a ~60 s) e per il salvataggio dello stato.
  TIME_BUDGET_MS: 4 * 60 * 1000,
  // Tolleranza fra l'orario configurato e l'effettivo avvio del trigger.
  SLOT_GRACE_MINUTES: 60,
  // Tentativi di un sotto-task in errore (equivalente ai 3 tentativi di Cloud Tasks).
  MAX_TASK_ATTEMPTS: 3,
  TASK_RETRY_DELAY_MS: 60 * 1000,
  // Errori transitori del provider (5xx, rete): retry limitati con backoff.
  HTTP_RETRY_BACKOFF_MS: [1000, 3000],
  // HTTP 429: pausa breve (Retry-After, con tetto) prima di passare alla chiave successiva.
  LIMIT_BACKOFF_DEFAULT_MS: 1000,
  LIMIT_BACKOFF_MAX_MS: 2000,
  DEFAULT_MAX_CALLS_PER_RUN: 3000,
  CANCEL_CHECK_INTERVAL_MS: 15 * 1000,
  BODY_CHUNKS_PER_COMMIT: 15,
  EXECUTOR: 'APPS_SCRIPT'
};

var FE_DEFAULT_SETTINGS = {
  monthsAhead: 24, topResults: 3, batchSize: 10, dropAlertPercent: 10, currency: 'EUR', emailTo: '',
  serpApiEnabled: true, rapidApiEnabled: true, scheduleTimezone: 'Europe/Rome', scheduleEnabled: true,
  scheduleHour: 2, scheduleMinute: 30, scheduleDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
};

var FE_CONFIG_CACHE_ = null;

function getConfig_() {
  if (FE_CONFIG_CACHE_) return FE_CONFIG_CACHE_;
  var props = PropertiesService.getScriptProperties().getProperties();
  var raw = props.SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Script Property SERVICE_ACCOUNT_JSON mancante.');
  var sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('SERVICE_ACCOUNT_JSON non è un JSON valido.'); }
  if (!sa.client_email || !sa.private_key) throw new Error('SERVICE_ACCOUNT_JSON: client_email o private_key mancanti.');
  var projectId = String(props.FIREBASE_PROJECT_ID || sa.project_id || '').trim();
  if (!projectId) throw new Error('Script Property FIREBASE_PROJECT_ID mancante.');
  var maxCalls = Number(props.MAX_CALLS_PER_RUN || FE_CONFIG.DEFAULT_MAX_CALLS_PER_RUN);
  FE_CONFIG_CACHE_ = {
    projectId: projectId,
    serviceAccount: sa,
    serpApiKeys: parseKeyList_(props.SERPAPI_KEYS, 'SERPAPI_KEYS'),
    rapidApiKeys: parseKeyList_(props.RAPIDAPI_KEYS, 'RAPIDAPI_KEYS'),
    logResponseBodies: !isFalse_(props.LOG_RESPONSE_BODIES),
    emailEnabled: !isFalse_(props.EMAIL_ENABLED),
    maxCallsPerRun: Number.isFinite(maxCalls) && maxCalls > 0 ? Math.floor(maxCalls) : FE_CONFIG.DEFAULT_MAX_CALLS_PER_RUN,
    testSearchId: String(props.TEST_SEARCH_ID || '').trim()
  };
  return FE_CONFIG_CACHE_;
}

function isFalse_(value) {
  return ['false', '0', 'no', 'off'].indexOf(String(value == null ? '' : value).trim().toLowerCase()) >= 0;
}

/** Stesso formato dei secret Firebase (array JSON); accetta anche un elenco separato da virgole/righe. */
function parseKeyList_(value, name) {
  var text = String(value == null ? '' : value).trim();
  if (!text) return [];
  if (text.charAt(0) === '[') {
    var list;
    try { list = JSON.parse(text); } catch (e) { throw new Error(name + ' non è un array JSON valido.'); }
    if (!Array.isArray(list)) throw new Error(name + ' deve essere un array JSON.');
    return list.map(function (k) { return String(k); });
  }
  return text.split(/[\s,]+/).filter(Boolean);
}

function mergedSettings_(data) {
  var out = {};
  Object.keys(FE_DEFAULT_SETTINGS).forEach(function (k) { out[k] = FE_DEFAULT_SETTINGS[k]; });
  Object.keys(data || {}).forEach(function (k) { if (data[k] !== undefined) out[k] = data[k]; });
  return out;
}

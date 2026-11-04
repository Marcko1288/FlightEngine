/**
 * Scheduler: sostituisce nightlyFlightSearch. La configurazione resta in settings/global
 * (scheduleEnabled, scheduleHour, scheduleMinute, scheduleDays, scheduleTimezone) e la
 * deduplica usa lo stesso campo lastScheduleSlot, con lo stesso formato dello slot.
 *
 * Stato dello scheduler in engine_state/scheduler:
 *   executor, triggerInstalled, triggerMinutes, lastTickAt, lastTickStatus, lastTickMessage,
 *   lastError, activeRunId, nextScheduleAt, lastScheduleSlot, lastScheduledRunId, lastScheduledRunAt
 */

var FE_DAY_MAP_ = { Mon: 'MON', Tue: 'TUE', Wed: 'WED', Thu: 'THU', Fri: 'FRI', Sat: 'SAT', Sun: 'SUN' };
var FE_FORMATTERS_ = {};

function zonedParts_(date, timeZone) {
  var fmt = FE_FORMATTERS_[timeZone] || (FE_FORMATTERS_[timeZone] = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  var out = {};
  fmt.formatToParts(date).forEach(function (p) { out[p.type] = p.value; });
  return out;
}

/** Porting di scheduledSlot (schedule.ts): slot "AAAA-MM-GG HH:MM fuso" se l'istante coincide con la configurazione. */
function scheduledSlot_(cfg, scheduleTime) {
  if (!cfg.scheduleEnabled) return null;
  var timeZone = cfg.scheduleTimezone || 'Europe/Rome';
  var part = zonedParts_(new Date(scheduleTime), timeZone);
  var day = FE_DAY_MAP_[part.weekday], hour = Number(part.hour), minute = Number(part.minute);
  if ((cfg.scheduleDays || []).indexOf(day) < 0 || hour !== Number(cfg.scheduleHour) || minute !== Number(cfg.scheduleMinute)) return null;
  return part.year + '-' + part.month + '-' + part.day + ' ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ' ' + timeZone;
}

/**
 * I trigger Apps Script non partono al minuto esatto: si cerca lo slot configurato più recente
 * negli ultimi SLOT_GRACE_MINUTES minuti. La deduplica con lastScheduleSlot evita doppi avvii.
 */
function dueSlot_(cfg, now) {
  var base = Math.floor(now.getTime() / 60000) * 60000;
  for (var k = 0; k <= FE_CONFIG.SLOT_GRACE_MINUTES; k++) {
    var slot = scheduledSlot_(cfg, new Date(base - k * 60000).toISOString());
    if (slot) return { slot: slot, at: new Date(base - k * 60000) };
  }
  return null;
}

/** Prossimo istante (dopo now) che corrisponde alla configurazione, entro 8 giorni. */
function nextScheduleAt_(cfg, now) {
  if (!cfg.scheduleEnabled || !(cfg.scheduleDays || []).length) return null;
  var step = Number(cfg.scheduleMinute) % 15 === 0 ? 15 : 1, stepMs = step * 60000;
  var t = Math.floor(now.getTime() / stepMs) * stepMs + stepMs;
  for (var end = now.getTime() + 8 * 24 * 3600 * 1000; t <= end; t += stepMs) {
    if (scheduledSlot_(cfg, new Date(t).toISOString())) return new Date(t);
  }
  return null;
}

/** Rivendica lo slot in transazione (stessa semantica di claimScheduledSlot). */
function claimSlot_(slot) {
  return fsRunTransaction_(function (tx) {
    var current = fsGet_('settings/global', tx);
    if (current && current.data.lastScheduleSlot === slot) return { writes: [], result: false };
    return { writes: [fsMerge_('settings/global', { lastScheduleSlot: slot, lastScheduleClaimedAt: fsServerTimestamp_() })], result: true };
  });
}

function schedulerStatusWrite_(data) {
  var out = { executor: FE_CONFIG.EXECUTOR, triggerMinutes: FE_CONFIG.TRIGGER_MINUTES };
  Object.keys(data).forEach(function (k) { out[k] = data[k]; });
  return fsMerge_('engine_state/scheduler', out);
}

/** Un passaggio dello scheduler. Da chiamare sotto LockService. */
function schedulerTick_() {
  var rt = newRuntime_(), now = new Date(), status = 'OK', message = '', lastError = null;
  var sched = fsGet_('engine_state/scheduler'), activeRunId = (sched && sched.data.activeRunId) || null;
  var settingsSnap = fsGet_('settings/global'), settings = mergedSettings_(settingsSnap && settingsSnap.data);
  var extra = {};
  try {
    if (activeRunId) {
      var outcome = processRun_(rt, activeRunId);
      message = outcome === 'DONE' ? 'Esecuzione ' + activeRunId + ' conclusa.' : 'Esecuzione ' + activeRunId + ' in corso: ripresa al prossimo trigger.';
      if (outcome === 'DONE') activeRunId = null;
    }
    if (!activeRunId) {
      var due = dueSlot_(settings, now);
      if (!due) message = message || 'Nessuno slot dovuto.';
      else if (settings.lastScheduleSlot === due.slot) message = message || 'Slot ' + due.slot + ' già eseguito.';
      else if (outOfBudget_(rt, 120000)) message = (message ? message + ' ' : '') + 'Slot ' + due.slot + ' rinviato al prossimo trigger (tempo insufficiente).';
      else if (!claimSlot_(due.slot)) message = message || 'Slot ' + due.slot + ' già rivendicato.';
      else {
        var created = createRun_(rt, { trigger: 'SCHEDULE', slot: due.slot });
        extra.lastScheduleSlot = due.slot;
        extra.lastScheduledRunId = created.runId;
        extra.lastScheduledRunAt = fsServerTimestamp_();
        if (created.status === 'QUEUED') {
          activeRunId = created.runId;
          fsCommit_([schedulerStatusWrite_({ activeRunId: activeRunId, lastScheduledRunId: created.runId, lastScheduleSlot: due.slot })]);
          var first = processRun_(rt, created.runId);
          if (first === 'DONE') activeRunId = null;
          message = 'Avviata esecuzione schedulata ' + created.runId + ' (slot ' + due.slot + ', ' + created.searches + ' ricerche)' + (first === 'DONE' ? ': conclusa.' : ': prosegue al prossimo trigger.');
        } else {
          message = 'Slot ' + due.slot + ': esecuzione ' + created.runId + ' chiusa con stato ' + created.status + '.';
        }
      }
    } else if (sched && sched.data.activeRunId && dueSlot_(settings, now) && dueSlot_(settings, now).slot !== settings.lastScheduleSlot) {
      message += ' Uno slot è dovuto ma un\'esecuzione precedente è ancora in corso: verrà avviato al termine, se entro ' + FE_CONFIG.SLOT_GRACE_MINUTES + ' minuti.';
    }
  } catch (e) {
    status = 'ERROR';
    lastError = errorMessage_(e);
    message = message || 'Errore dello scheduler.';
    console.error('scheduler-error', lastError, e && e.stack);
  }
  var next = nextScheduleAt_(settings, new Date());
  var statusData = { lastTickAt: fsServerTimestamp_(), lastTickStatus: status, lastTickMessage: message.trim(), lastError: lastError, activeRunId: activeRunId, nextScheduleAt: next, scheduleEnabled: !!settings.scheduleEnabled, lastTickDurationMs: Date.now() - rt.started };
  Object.keys(extra).forEach(function (k) { statusData[k] = extra[k]; });
  try { fsCommit_([schedulerStatusWrite_(statusData)]); } catch (e) { console.error('scheduler-status-error', errorMessage_(e)); }
  console.log('[Flight Engine] ' + status + ': ' + message);
  if (status === 'ERROR') throw new Error(lastError);
  return { status: status, message: message, activeRunId: activeRunId, nextScheduleAt: next };
}

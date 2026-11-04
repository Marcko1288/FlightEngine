/**
 * Client minimale per la REST API di Firestore (v1).
 * I valori JS vengono convertiti come fa l'Admin SDK: interi -> integerValue, decimali ->
 * doubleValue, Date -> timestampValue (la webapp le legge come Timestamp), oggetti -> mapValue.
 * Sentinelle: fsServerTimestamp_(), fsIncrement_(n), fsDeleteField_() (solo campi di primo livello).
 */

function fsServerTimestamp_() { return { __fsTransform: 'REQUEST_TIME' }; }
function fsIncrement_(n) { return { __fsTransform: 'INCREMENT', value: n }; }
function fsDeleteField_() { return { __fsDelete: true }; }

function fsToValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter(function (x) { return x !== undefined; }).map(fsToValue_) } };
  switch (typeof v) {
    case 'boolean': return { booleanValue: v };
    case 'number':
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return { integerValue: String(v) };
      return { doubleValue: Number.isFinite(v) ? v : String(v) };
    case 'string': return { stringValue: v };
    case 'object': return { mapValue: { fields: fsFields_(v) } };
    default: return { nullValue: null };
  }
}

function fsFields_(obj) {
  var fields = {};
  Object.keys(obj).forEach(function (k) { if (obj[k] !== undefined) fields[k] = fsToValue_(obj[k]); });
  return fields;
}

function fsFromValue_(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('stringValue' in v) return v.stringValue;
  if ('mapValue' in v) return fsFromFields_(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsFromValue_);
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

function fsFromFields_(fields) {
  var out = {};
  Object.keys(fields || {}).forEach(function (k) { out[k] = fsFromValue_(fields[k]); });
  return out;
}

function fsFieldPath_(name) { return /^[A-Za-z_][A-Za-z_0-9]*$/.test(name) ? name : '`' + name.replace(/[`\\]/g, '\\$&') + '`'; }

function fsRoot_() { return 'projects/' + getConfig_().projectId + '/databases/(default)/documents'; }
function fsBaseUrl_() { return 'https://firestore.googleapis.com/v1/' + fsRoot_(); }

function fsDocFromApi_(doc) {
  var name = doc.name, rel = name.slice(fsRoot_().length + 1);
  return { id: name.split('/').pop(), path: rel, data: fsFromFields_(doc.fields || {}), updateTime: doc.updateTime };
}

/**
 * Costruisce una write. mode: "set" (sostituisce), "merge" (solo i campi indicati),
 * "update" (merge + documento esistente), "create" (documento non esistente).
 */
function fsWrite_(path, data, mode) {
  var fields = {}, transforms = [], deleted = [];
  Object.keys(data || {}).forEach(function (k) {
    var v = data[k];
    if (v === undefined) return;
    if (v && typeof v === 'object' && v.__fsTransform === 'REQUEST_TIME') transforms.push({ fieldPath: fsFieldPath_(k), setToServerValue: 'REQUEST_TIME' });
    else if (v && typeof v === 'object' && v.__fsTransform === 'INCREMENT') transforms.push({ fieldPath: fsFieldPath_(k), increment: fsToValue_(v.value) });
    else if (v && typeof v === 'object' && v.__fsDelete) deleted.push(k);
    else fields[k] = fsToValue_(v);
  });
  var write = { update: { name: fsRoot_() + '/' + path, fields: fields } };
  if (mode === 'merge' || mode === 'update') write.updateMask = { fieldPaths: Object.keys(fields).concat(deleted).map(fsFieldPath_) };
  if (transforms.length) write.updateTransforms = transforms;
  if (mode === 'update') write.currentDocument = { exists: true };
  if (mode === 'create') write.currentDocument = { exists: false };
  return write;
}
function fsSet_(path, data) { return fsWrite_(path, data, 'set'); }
function fsMerge_(path, data) { return fsWrite_(path, data, 'merge'); }
function fsUpdate_(path, data) { return fsWrite_(path, data, 'update'); }
function fsCreate_(path, data) { return fsWrite_(path, data, 'create'); }

function FirestoreError_(status, code, message) {
  this.name = 'FirestoreError';
  this.httpStatus = status;
  this.code = code;
  this.message = 'Firestore ' + (code || status) + ': ' + message;
}
FirestoreError_.prototype = Object.create(Error.prototype);
FirestoreError_.prototype.constructor = FirestoreError_;

/** Richiesta REST con rinnovo del token su 401 e retry limitati su errori transitori. */
function fsRequest_(method, url, payload) {
  var delays = [500, 1500, 4000], lastStatus = 0;
  for (var attempt = 0; ; attempt++) {
    var options = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + firestoreAccessToken_(attempt > 0 && lastStatus === 401) } };
    if (payload !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(payload); }
    var res = UrlFetchApp.fetch(url, options), code = res.getResponseCode(), text = res.getContentText();
    if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
    var body = {};
    try { body = JSON.parse(text); } catch (e) { /* risposta non JSON */ }
    var err = body.error || (Array.isArray(body) && body[0] && body[0].error) || {};
    lastStatus = code;
    var transient = code === 401 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
    // ABORTED (409) va gestito da runTransaction, non qui.
    if (!transient || attempt >= delays.length) throw new FirestoreError_(code, err.status, err.message || text.slice(0, 300));
    if (code !== 401) sleep_(delays[attempt]);
  }
}

function fsGet_(path, transaction) {
  var url = fsBaseUrl_() + '/' + path.split('/').map(encodeURIComponent).join('/') + (transaction ? '?transaction=' + encodeURIComponent(transaction) : '');
  try { return fsDocFromApi_(fsRequest_('get', url)); }
  catch (e) { if (e instanceof FirestoreError_ && e.httpStatus === 404) return null; throw e; }
}

function fsCommit_(writes, transaction) {
  if (!writes.length && !transaction) return null;
  var payload = { writes: writes };
  if (transaction) payload.transaction = transaction;
  return fsRequest_('post', fsBaseUrl_() + ':commit', payload);
}

/** Esegue più write in commit successivi (max 400 write per commit). */
function fsCommitAll_(writes) {
  for (var i = 0; i < writes.length; i += 400) fsCommit_(writes.slice(i, i + 400));
}

/**
 * structuredQuery su una collection. parentPath "" per la radice, altrimenti il documento padre.
 * filters: [[field, value]] in AND con operatore EQUAL. orderBy: [[field, "ASCENDING"|"DESCENDING"]].
 */
function fsQuery_(parentPath, collectionId, filters, orderBy, limit, transaction) {
  var q = { from: [{ collectionId: collectionId }] };
  var f = (filters || []).map(function (x) { return { fieldFilter: { field: { fieldPath: x[0] }, op: 'EQUAL', value: fsToValue_(x[1]) } }; });
  if (f.length === 1) q.where = f[0];
  else if (f.length > 1) q.where = { compositeFilter: { op: 'AND', filters: f } };
  if (orderBy && orderBy.length) q.orderBy = orderBy.map(function (o) { return { field: { fieldPath: o[0] }, direction: o[1] || 'ASCENDING' }; });
  if (limit) q.limit = limit;
  var payload = { structuredQuery: q };
  if (transaction) payload.transaction = transaction;
  var url = fsBaseUrl_() + (parentPath ? '/' + parentPath.split('/').map(encodeURIComponent).join('/') : '') + ':runQuery';
  var rows = fsRequest_('post', url, payload);
  return (rows || []).filter(function (r) { return r.document; }).map(function (r) { return fsDocFromApi_(r.document); });
}

/**
 * Transazione: fn(txId) legge con fsGet_(path, txId) e restituisce l'elenco delle write
 * (oppure { writes, result }). Ripete su ABORTED.
 */
function fsRunTransaction_(fn) {
  for (var attempt = 0; attempt < 5; attempt++) {
    var tx = fsRequest_('post', fsBaseUrl_() + ':beginTransaction', { options: { readWrite: {} } }).transaction;
    var out;
    try { out = fn(tx); } catch (e) {
      try { fsRequest_('post', fsBaseUrl_() + ':rollback', { transaction: tx }); } catch (ignored) { /* best effort */ }
      throw e;
    }
    var writes = Array.isArray(out) ? out : (out && out.writes) || [];
    try { fsCommit_(writes, tx); return Array.isArray(out) ? undefined : out && out.result; }
    catch (e) {
      if (e instanceof FirestoreError_ && (e.httpStatus === 409 || e.code === 'ABORTED') && attempt < 4) { sleep_(200 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

// Carica i file dello script Apps Script in un contesto VM con stub dei servizi Google
// e un Firestore REST in memoria, per testare il codice esattamente come viene pubblicato.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = path.join(__dirname, '..', 'src');
const PROJECT = 'demo-project';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;

function response(code, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text, getAllHeaders: () => headers };
}

function createFakeFirestore(ctx) {
  const docs = new Map(); // path -> fields (formato API)
  const decode = (v) => ctx.fsFromValue_(v);
  const stripTicks = (p) => p.replace(/^`|`$/g, '');
  const now = () => ({ timestampValue: new Date().toISOString() });
  function apply(w) {
    const rel = w.update.name.slice(ROOT.length + 1);
    const exists = docs.has(rel);
    if (w.currentDocument && w.currentDocument.exists === true && !exists) return { code: 404, status: 'NOT_FOUND', message: 'No document to update: ' + rel };
    if (w.currentDocument && w.currentDocument.exists === false && exists) return { code: 409, status: 'ALREADY_EXISTS', message: 'Document already exists: ' + rel };
    let fields;
    if (w.updateMask) {
      fields = { ...(docs.get(rel) || {}) };
      for (const fp of w.updateMask.fieldPaths) {
        const k = stripTicks(fp);
        if (k in w.update.fields) fields[k] = w.update.fields[k]; else delete fields[k];
      }
    } else fields = { ...w.update.fields };
    for (const t of w.updateTransforms || []) {
      const k = stripTicks(t.fieldPath);
      if (t.setToServerValue === 'REQUEST_TIME') fields[k] = now();
      else if (t.increment) {
        const cur = fields[k] ? Number(decode(fields[k])) || 0 : 0;
        fields[k] = { integerValue: String(cur + Number(decode(t.increment))) };
      }
    }
    docs.set(rel, fields);
    return null;
  }
  function api(rel) { return { name: ROOT + '/' + rel, fields: docs.get(rel), updateTime: new Date().toISOString() }; }
  function handle(method, url, payload) {
    if (url.startsWith(BASE + ':commit')) {
      const snapshot = new Map(docs);
      for (const w of payload.writes) {
        const err = apply(w);
        if (err) { docs.clear(); for (const [k, v] of snapshot) docs.set(k, v); return response(err.code, { error: { code: err.code, status: err.status, message: err.message } }); }
      }
      return response(200, { writeResults: [] });
    }
    if (url.startsWith(BASE + ':beginTransaction')) return response(200, { transaction: 'tx-' + Math.random() });
    if (url.startsWith(BASE + ':rollback')) return response(200, {});
    if (url.includes(':runQuery')) {
      const parent = decodeURIComponent(url.slice(BASE.length, url.indexOf(':runQuery')).replace(/^\//, ''));
      const q = payload.structuredQuery, coll = q.from[0].collectionId;
      const prefix = (parent ? parent + '/' : '') + coll + '/';
      let rows = [...docs.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
      const filters = !q.where ? [] : q.where.compositeFilter ? q.where.compositeFilter.filters : [q.where];
      rows = rows.filter((k) => filters.every((f) => {
        const v = docs.get(k)[f.fieldFilter.field.fieldPath];
        return v !== undefined && JSON.stringify(decode(v)) === JSON.stringify(decode(f.fieldFilter.value));
      }));
      for (const o of [...(q.orderBy || [])].reverse()) {
        const dir = o.direction === 'DESCENDING' ? -1 : 1, fp = o.field.fieldPath;
        rows = rows.filter((k) => docs.get(k)[fp] !== undefined);
        rows.sort((a, b) => { const x = decode(docs.get(a)[fp]), y = decode(docs.get(b)[fp]); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      }
      if (q.limit) rows = rows.slice(0, q.limit);
      return response(200, rows.length ? rows.map((k) => ({ document: api(k), readTime: 'x' })) : [{ readTime: 'x' }]);
    }
    if (method === 'get' && url.startsWith(BASE + '/')) {
      const rel = decodeURIComponent(url.slice(BASE.length + 1).split('?')[0]);
      return docs.has(rel) ? response(200, api(rel)) : response(404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } });
    }
    throw new Error('Richiesta Firestore non gestita: ' + method + ' ' + url);
  }
  return {
    docs, handle,
    get: (rel) => (docs.has(rel) ? ctx.fsFromFields_(docs.get(rel)) : null),
    set: (rel, data) => docs.set(rel, ctx.fsFields_(data)),
    list: (prefix) => [...docs.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => ({ path: k, id: k.split('/').pop(), data: ctx.fsFromFields_(docs.get(k)) }))
  };
}

function loadScript(options = {}) {
  const calls = { sleeps: [], mails: [], provider: [], triggers: [] };
  const props = {
    SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@demo-project.iam.gserviceaccount.com', private_key: 'PRIVATE', project_id: PROJECT }),
    SERPAPI_KEYS: JSON.stringify(['serp-key-1']),
    RAPIDAPI_KEYS: JSON.stringify([]),
    ...(options.props || {})
  };
  const cacheStore = new Map();
  let provider = options.provider || (() => response(500, 'no provider'));
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, text) => [...crypto.createHash('sha256').update(String(text), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      computeRsaSha256Signature: () => [1, 2, 3],
      sleep: (ms) => calls.sleeps.push(ms),
      parseCsv: (text) => text.trim().split(/\r?\n/).map((l) => l.split(','))
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cacheStore.get(k) || null, put: (k, v) => cacheStore.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (m) => calls.mails.push(m) },
    ScriptApp: {
      getProjectTriggers: () => calls.triggers.map((h) => ({ getHandlerFunction: () => h })),
      deleteTrigger: (t) => { calls.triggers.splice(calls.triggers.indexOf(t.getHandlerFunction()), 1); },
      newTrigger: (h) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => calls.triggers.push(h) }) }) })
    },
    UrlFetchApp: {
      fetch: (url, opts = {}) => {
        if (url === 'https://oauth2.googleapis.com/token') return response(200, { access_token: 'token' });
        if (url.startsWith('https://firestore.googleapis.com/')) return ctx.__firestore.handle(opts.method || 'get', url, opts.payload ? JSON.parse(opts.payload) : undefined);
        calls.provider.push({ url, headers: opts.headers });
        return provider(url, opts, calls.provider.length);
      }
    }
  };
  vm.createContext(ctx);
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), ctx, { filename: file });
  }
  ctx.Date = vm.runInContext('Date', ctx);
  ctx.__firestore = createFakeFirestore(ctx);
  return { ctx, db: ctx.__firestore, calls, setProvider: (fn) => { provider = fn; }, response };
}

module.exports = { loadScript, response };

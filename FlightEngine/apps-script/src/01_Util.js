/** Utility indipendenti dalla piattaforma (testabili anche in Node). */

function utf8Bytes_(text) {
  var out = [];
  for (var i = 0; i < text.length; i++) {
    var c = text.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

var B64_ALPHABET_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url senza padding (come Buffer#toString("base64url")). Accetta byte con o senza segno. */
function base64Url_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i] & 255, b = i + 1 < bytes.length ? bytes[i + 1] & 255 : 0, c = i + 2 < bytes.length ? bytes[i + 2] & 255 : 0;
    var n = (a << 16) | (b << 8) | c;
    out += B64_ALPHABET_[(n >> 18) & 63] + B64_ALPHABET_[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64_ALPHABET_[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64_ALPHABET_[n & 63];
  }
  return out;
}

function base64UrlString_(text) { return base64Url_(utf8Bytes_(text)); }

/** SHA-256 esadecimale del testo UTF-8: identico a createHash("sha256").update(text).digest("hex"). */
function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}

var ID_ALPHABET_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Id casuale di 20 caratteri, come gli auto-id Firestore. */
function randomId_() {
  var id = '';
  for (var i = 0; i < 20; i++) id += ID_ALPHABET_.charAt(Math.floor(Math.random() * ID_ALPHABET_.length));
  return id;
}

function sleep_(ms) { if (ms > 0) Utilities.sleep(ms); }

function unique_(list) { return Array.from(new Set(list)); }

function errorMessage_(e) { return String(e && e.message ? e.message : e); }

/** Il blocco di esecuzione corrente ha esaurito il tempo: lo stato è salvato e si riprende al trigger successivo. */
function PauseSignal_(calls, warnings) {
  this.name = 'PauseSignal';
  this.message = 'Tempo di esecuzione esaurito: ripresa al prossimo trigger.';
  this.calls = calls || 0;
  this.warnings = warnings || [];
}
PauseSignal_.prototype = Object.create(Error.prototype);
PauseSignal_.prototype.constructor = PauseSignal_;

/** Equivalente di RunStopped del backend Firebase. */
function RunStopped_(status, message) {
  this.name = 'RunStopped';
  this.status = status;
  this.message = message;
}
RunStopped_.prototype = Object.create(Error.prototype);
RunStopped_.prototype.constructor = RunStopped_;

/**
 * OAuth2 con service account (JWT bearer, RS256). Il token è conservato nella cache dello
 * script per 50 minuti; la chiave privata resta nelle Script Properties.
 */
var FE_TOKEN_CACHE_KEY_ = 'fe_firestore_token_v1';
var FE_TOKEN_MEMO_ = null;

function firestoreAccessToken_(forceRefresh) {
  if (!forceRefresh && FE_TOKEN_MEMO_) return FE_TOKEN_MEMO_;
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    var cached = cache.get(FE_TOKEN_CACHE_KEY_);
    if (cached) return (FE_TOKEN_MEMO_ = cached);
  }
  var sa = getConfig_().serviceAccount;
  var aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  var now = Math.floor(Date.now() / 1000);
  var input = base64UrlString_(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + base64UrlString_(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: aud,
    iat: now,
    exp: now + 3600
  }));
  var signature = Utilities.computeRsaSha256Signature(input, sa.private_key);
  var res = UrlFetchApp.fetch(aud, {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + base64Url_(signature) },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('Autenticazione service account non riuscita: HTTP ' + code + ' ' + res.getContentText().slice(0, 300));
  var token = JSON.parse(res.getContentText()).access_token;
  if (!token) throw new Error('Autenticazione service account: access_token assente.');
  cache.put(FE_TOKEN_CACHE_KEY_, token, 50 * 60);
  return (FE_TOKEN_MEMO_ = token);
}

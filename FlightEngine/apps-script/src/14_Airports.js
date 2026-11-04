/**
 * Risoluzione città/aeroporti: stessa mappa CITY_AIRPORTS di functions/src/index.ts e, per i
 * nomi non presenti, stesso catalogo OurAirports (resolveCatalogAirport di airport-catalog.ts).
 * Il catalogo si scarica solo quando serve; le risoluzioni sono memorizzate in CacheService (6 ore).
 */
var FE_CITY_AIRPORTS = { 'TENERIFE': ['TFS', 'TFN'], 'MILANO': ['MXP', 'LIN', 'BGY'], 'MILANO/BERGAMO': ['MXP', 'LIN', 'BGY'], 'ROMA': ['FCO', 'CIA'], 'LONDRA': ['LHR', 'LGW', 'STN', 'LTN', 'LCY'], 'PARIGI': ['CDG', 'ORY', 'BVA'], 'BRUXELLES': ['BRU', 'CRL'], 'ISTANBUL': ['IST', 'SAW'], 'TOKYO': ['NRT', 'HND'], 'NEW YORK': ['JFK', 'EWR'], 'BARCELLONA': ['BCN'], 'MADRID': ['MAD'], 'SIVIGLIA': ['SVQ'], 'LISBONA': ['LIS'], 'PORTO': ['OPO'], 'ATENE': ['ATH'], 'MYKONOS': ['JMK'], 'SANTORINI': ['JTR'], 'PAROS': ['PAS'], 'MILOS': ['MLO'], 'HERAKLION': ['HER'], 'CHANIA': ['CHQ'], 'NAXOS': ['JNX'], 'KOS': ['KGS'], 'BODRUM': ['BJV'], 'BUCAREST': ['OTP'], 'TALLINN': ['TLL'], 'BERGEN': ['BGO'], 'OSLO': ['OSL'], 'BANGKOK': ['BKK'], 'PHUKET': ['HKT'], 'OKINAWA': ['OKA'], 'OSAKA': ['KIX'], 'PECHINO': ['PEK'], 'SHANGHAI': ['PVG'], 'DUBAI': ['DXB'], 'DOHA': ['DOH'], 'SINGAPORE': ['SIN'],
  'NAPOLI': ['NAP'], 'VENEZIA': ['VCE'], 'BOLOGNA': ['BLQ'], 'TORINO': ['TRN'], 'PISA': ['PSA'], 'FIRENZE': ['FLR'], 'BARI': ['BRI'], 'PALERMO': ['PMO'], 'CATANIA': ['CTA'], 'CAGLIARI': ['CAG'], 'VALENCIA': ['VLC'], 'MALAGA': ['AGP'], 'AMSTERDAM': ['AMS'], 'FRANCOFORTE': ['FRA'], 'MONACO': ['MUC'], 'BERLINO': ['BER'], 'VIENNA': ['VIE'], 'ZURIGO': ['ZRH'], 'COPENAGHEN': ['CPH'], 'STOCCOLMA': ['ARN'], 'HELSINKI': ['HEL'], 'PRAGA': ['PRG'], 'BUDAPEST': ['BUD'], 'VARSAVIA': ['WAW'], 'CRACOVIA': ['KRK'], 'LOS ANGELES': ['LAX'], 'SAN FRANCISCO': ['SFO'], 'MIAMI': ['MIA'], 'HONG KONG': ['HKG'], 'SYDNEY': ['SYD'] };

var FE_AIRPORT_SOURCE = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
var FE_AIRPORT_CATALOG_ = null;

function foldText_(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

/** Come parseAirportCatalog (usa il parser CSV nativo di Apps Script per velocità). */
function parseAirportCatalogRows_(rows) {
  var headers = rows.shift() || [];
  ['iata_code', 'name', 'municipality', 'iso_country', 'type'].forEach(function (name) { if (headers.indexOf(name) < 0) throw new Error('Formato catalogo aeroporti non valido.'); });
  var idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  var get = function (row, name) { return idx[name] == null ? '' : row[idx[name]] || ''; };
  var result = new Map();
  rows.forEach(function (row) {
    var code = get(row, 'iata_code');
    if (!/^[A-Z]{3}$/.test(code) || ['closed', 'heliport', 'seaplane_base', 'balloonport'].indexOf(get(row, 'type')) >= 0) return;
    var airport = { code: code, name: get(row, 'name'), city: get(row, 'municipality'), country: get(row, 'iso_country'), region: get(row, 'iso_region'), scheduled: get(row, 'scheduled_service') === 'yes' };
    if (!result.has(code) || airport.scheduled) result.set(code, airport);
  });
  return Array.from(result.values());
}

function airportCatalog_() {
  if (FE_AIRPORT_CATALOG_) return FE_AIRPORT_CATALOG_;
  var res = UrlFetchApp.fetch(FE_AIRPORT_SOURCE, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Catalogo aeroporti: HTTP ' + res.getResponseCode());
  var airports = parseAirportCatalogRows_(Utilities.parseCsv(res.getContentText()));
  if (!airports.length) throw new Error('Catalogo aeroporti vuoto.');
  return (FE_AIRPORT_CATALOG_ = airports);
}

function resolveCatalogAirport_(airports, value) {
  var q = foldText_(value);
  var matches = airports.filter(function (a) { return foldText_(a.city) === q || foldText_(a.name) === q; });
  var regions = new Set(matches.map(function (a) { return a.country + ':' + a.region; }));
  if (regions.size > 1) throw new Error('La località ' + value + ' è ambigua: seleziona i codici IATA dal suggerimento.');
  return matches.filter(function (a) { return a.scheduled; }).map(function (a) { return a.code; });
}

function resolveAirportName_(name) {
  var cache = CacheService.getScriptCache(), key = 'fe_airport_' + sha256Hex_(name).slice(0, 32);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var found = resolveCatalogAirport_(airportCatalog_(), name);
  if (found.length) cache.put(key, JSON.stringify(found), 6 * 60 * 60);
  return found;
}

function airportCodes_(value) {
  var codes = [];
  String(value || '').split(',').forEach(function (token) {
    var v = token.trim().toUpperCase();
    if (!v) return;
    if (FE_CITY_AIRPORTS[v]) codes.push.apply(codes, FE_CITY_AIRPORTS[v]);
    else if (/^[A-Z]{3}$/.test(v)) codes.push(v);
    else {
      var found = resolveAirportName_(v);
      if (!found.length) throw new Error('Aeroporto o città non riconosciuti: ' + v + '. Seleziona un suggerimento o inserisci il codice IATA.');
      codes.push.apply(codes, found);
    }
  });
  return unique_(codes);
}

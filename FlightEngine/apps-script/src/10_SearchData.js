/** Porting di functions/src/search-data.ts (solo la parte usata dal backend). */

var FE_BLANK_SEARCH = { origin: 'Milano', destination: '', returnOrigin: '', returnDestination: '', departureFrom: '', departureTo: '', pricePerPerson: 100, maxStops: 1, nights: 4, travelers: 4, destinationName: '', allowedDays: 'ALL', cluster: '', active: true };

function isoDate_(value) {
  var text = String(value == null ? '' : value).trim();
  var it = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  var iso = it ? it[3] + '-' + it[2] + '-' + it[1] : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('Data non valida: usa GG/MM/AAAA.');
  var date = new Date(iso + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error('Data non valida: ' + text);
  return iso;
}

function formatDate_(value) {
  var text = String(value == null ? '' : value);
  return text.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, function (_, y, m, d) { return d.padStart(2, '0') + '/' + m.padStart(2, '0') + '/' + y; });
}

function normalizeSearch_(raw) {
  var str = function (key, fallback) { return String(raw[key] == null ? (fallback == null ? '' : fallback) : raw[key]).trim(); };
  var number = function (key, min, integer) {
    if (integer === undefined) integer = true;
    var value = raw[key] === undefined || raw[key] === '' ? Number(FE_BLANK_SEARCH[key]) : Number(String(raw[key]).replace(',', '.'));
    if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) throw new Error('Valore non valido: ' + key);
    return value;
  };
  var origin = str('origin').toUpperCase(), destination = str('destination').toUpperCase();
  if (!origin || !destination) throw new Error('Partenza e arrivo sono obbligatori.');
  var departureFrom = isoDate_(raw.departureFrom), departureTo = isoDate_(raw.departureTo);
  if (departureFrom > departureTo) throw new Error('La data finale deve essere successiva o uguale a quella iniziale.');
  var allowedDays = str('allowedDays', 'ALL').toUpperCase();
  if (allowedDays !== 'ALL' && allowedDays !== 'WEEKEND') throw new Error('Giorni non validi: usa ALL o WEEKEND.');
  return {
    origin: origin, destination: destination, returnOrigin: str('returnOrigin').toUpperCase(), returnDestination: str('returnDestination').toUpperCase(),
    departureFrom: departureFrom, departureTo: departureTo, pricePerPerson: number('pricePerPerson', 0, false), maxStops: number('maxStops', 0),
    nights: number('nights', 1), travelers: number('travelers', 1), destinationName: str('destinationName') || destination, allowedDays: allowedDays,
    cluster: str('cluster', str('period')), active: [false, 'false', 'FALSE', 0, '0'].indexOf(raw.active) < 0
  };
}

/** Come insideHorizon() in functions/src/index.ts. */
function insideHorizon_(date, months, now) {
  var max = now ? new Date(now.getTime()) : new Date();
  max.setMonth(max.getMonth() + months);
  return new Date(date) <= max;
}

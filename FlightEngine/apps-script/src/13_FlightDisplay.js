/** Porting di functions/src/flight-display.ts e google-flights-link.ts. */

function providerName_(value) {
  return unique_((value || '').split(' / ').map(function (name) {
    return /rapid/i.test(name) ? 'RapidApi' : /serp/i.test(name) ? 'SerpiApi' : name.replace(/\s*\(.*\)/, '').trim();
  }).filter(Boolean)).join(' / ');
}

function legDetails_(raw) {
  var flights = raw && Array.isArray(raw.flights) ? raw.flights : [];
  var first = flights[0], last = flights[flights.length - 1];
  var airport = function (a) { return { code: (a && (a.airport_code || a.id)) || '', name: (a && (a.airport_name || a.name)) || '', time: formatDate_((a && a.time) || '') }; };
  var minutes = function (value) { return Number(typeof value === 'object' && value !== null ? value.raw : value) || 0; };
  var duration = raw && raw.total_duration != null ? raw.total_duration : raw && raw.duration;
  return {
    origin: airport(first && first.departure_airport),
    destination: airport(last && last.arrival_airport),
    airlines: flights.map(function (f) { return ((f.airline || '') + ' ' + (f.flight_number || '')).trim(); }),
    duration: minutes(duration),
    stops: raw && raw.stops != null ? raw.stops : Math.max(0, flights.length - 1),
    layoverMinutes: (raw && Array.isArray(raw.layovers) ? raw.layovers : []).reduce(function (sum, l) { return sum + minutes(l.duration); }, 0)
  };
}

function routeCodes_(result, back) {
  var details = legDetails_(back ? result.return : result.outbound);
  var start = details.origin.code || (back ? result.returnOrigin : result.origin);
  var end = details.destination.code || (back ? result.returnDestination : result.destination);
  if (start && end) return start + ' → ' + end;
  var old = String(result.provider || '').match(/\(([A-Z]{3})-([A-Z]{3})\)/g) || [];
  var route = old[back ? 1 : 0];
  return route ? route.slice(1, -1).replace('-', ' → ') : '—';
}

function durationText_(minutes) { return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm'; }

function returnDescription_(result) {
  if (result.returnDetailsStatus === 'NOT_REQUESTED') return routeCodes_(result, true) + ' (incluso nel prezzo A/R; dettagli non richiesti)';
  if (result.returnDetailsStatus === 'UNAVAILABLE') return 'Dettagli non disponibili al prezzo A/R indicato';
  return routeCodes_(result, true);
}

// --- Link Google Flights: parametro tfs = protobuf in base64url (vedi google-flights-link.ts) ---
function pbVarint_(value) {
  var bytes = [];
  do { var byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function pbInteger_(field, value) { return pbVarint_(field * 8).concat(pbVarint_(value)); }
function pbMessage_(field, value) {
  var bytes = typeof value === 'string' ? utf8Bytes_(value) : value;
  return pbVarint_(field * 8 + 2).concat(pbVarint_(bytes.length), bytes);
}

function googleFlightsSearchUrl_(from, to, date, returnDate, currency, travelers, maxStops) {
  if (travelers === undefined) travelers = 1;
  var airport = function (code) { return pbMessage_(2, code); };
  var leg = function (origin, destination, departure) {
    var body = pbMessage_(2, departure).concat(pbMessage_(13, airport(origin)), pbMessage_(14, airport(destination)));
    if (Number.isSafeInteger(maxStops) && maxStops >= 0) body = body.concat(pbInteger_(5, maxStops));
    return pbMessage_(3, body);
  };
  var adults = Number.isSafeInteger(travelers) && travelers > 0 && travelers <= 9 ? travelers : 1;
  var ones = [];
  for (var i = 0; i < adults; i++) ones.push(1);
  var tfs = base64Url_(leg(from, to, date).concat(returnDate ? leg(to, from, returnDate) : [], pbMessage_(8, ones), pbInteger_(9, 1), pbInteger_(19, returnDate ? 1 : 2)));
  return 'https://www.google.com/travel/flights/search?' + queryString_([['tfs', tfs], ['hl', 'it'], ['curr', currency]]);
}

function googleFlightsLinks_(offer, currency) {
  var out = legDetails_(offer.outbound), back = legDetails_(offer.return);
  var origin = out.origin.code || offer.origin, destination = out.destination.code || offer.destination;
  var returnOrigin = back.origin.code || offer.returnOrigin || destination, returnDestination = back.destination.code || offer.returnDestination || origin;
  var link = function (label, from, to, date, ret) {
    var travelers = offer.travelers != null ? offer.travelers : Math.round(offer.totalPrice / offer.pricePerPerson);
    return { label: label, url: googleFlightsSearchUrl_(from, to, date, ret, currency, travelers, offer.maxStops) };
  };
  if (offer.priceType === 'SEPARATE_ONE_WAY' || returnOrigin !== destination || returnDestination !== origin) {
    var links = [];
    if (origin && destination && offer.departureDate) links.push(link('Andata su Google Flights', origin, destination, offer.departureDate));
    if (returnOrigin && returnDestination && offer.returnDate) links.push(link('Ritorno su Google Flights', returnOrigin, returnDestination, offer.returnDate));
    return links;
  }
  return origin && destination && offer.departureDate ? [link('Apri su Google Flights', origin, destination, offer.departureDate, offer.returnDate)] : [];
}

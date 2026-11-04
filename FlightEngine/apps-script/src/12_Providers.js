/**
 * Porting di trip-request.ts, rapid-request.ts, provider-response.ts e delle funzioni
 * redact/bodyChunks di request-log.ts. Parametri, URL e regole di parsing sono identici.
 */

function serpStops_(maxStops) { return String(maxStops >= 2 ? 3 : maxStops + 1); }

function queryString_(pairs) {
  return pairs.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
}

// Parametri verificati sulla richiesta del playground RapidAPI.
function rapidQueryPairs_(origin, destination, date, travelers, currency) {
  return [['departure_id', origin], ['arrival_id', destination], ['outbound_date', date], ['travel_class', 'ECONOMY'], ['adults', String(travelers)], ['show_hidden', '1'], ['currency', currency], ['language_code', 'it'], ['country_code', 'IT'], ['search_type', 'best']];
}

function tripRequest_(provider, key, trip, travelers, maxStops, currency) {
  if (provider === 'SerpApi') {
    var q = [['engine', 'google_flights'], ['gl', 'it'], ['hl', 'it'], ['currency', currency], ['type', trip.returnDate ? '1' : '2'], ['adults', String(travelers)], ['stops', serpStops_(maxStops)], ['api_key', key], ['departure_id', trip.origin], ['arrival_id', trip.destination], ['outbound_date', trip.departureDate]];
    if (trip.returnDate) q.push(['return_date', trip.returnDate]);
    return { url: 'https://serpapi.com/search.json?' + queryString_(q), headers: {}, kind: 'serp' };
  }
  var r = rapidQueryPairs_(trip.origin, trip.destination, trip.departureDate, travelers, currency);
  if (trip.returnDate) r.push(['return_date', trip.returnDate]);
  return {
    url: 'https://google-flights2.p.rapidapi.com/api/v1/searchFlights?' + queryString_(r),
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'google-flights2.p.rapidapi.com' },
    kind: 'rapid'
  };
}

/** Come parseResponse(res, kind, maxStops), ricevendo stato HTTP e corpo testuale. */
function parseResponse_(httpStatus, text, kind, maxStops) {
  if (maxStops == null) maxStops = Infinity;
  if (httpStatus === 429) return { status: 'LIMIT', message: 'Quota API esaurita (HTTP 429).' };
  if (httpStatus < 200 || httpStatus > 299) return { status: 'ERROR', message: 'Il provider ha risposto HTTP ' + httpStatus + '.' };
  var j;
  try { j = JSON.parse(text); } catch (e) { return { status: 'ERROR', message: 'Il provider non ha restituito JSON valido.' }; }
  if (!j || typeof j !== 'object') return { status: 'ERROR', message: 'Risposta del provider non riconosciuta.' };
  if (j.error || j.status === false || j.status === 'error' || (j.search_metadata && j.search_metadata.status === 'Error')) return { status: 'ERROR', message: 'Il provider segnala un errore nella risposta. Verifica parametri, credenziali e quota.' };
  var it = j.data && j.data.itineraries;
  var groups = kind === 'serp' ? [j.best_flights, j.other_flights] : [it && it.topFlights, it && it.otherFlights, it];
  if (!groups.some(Array.isArray)) return { status: 'ERROR', message: 'Formato della risposta non riconosciuto: mancano le liste dei voli attese.' };
  var options = [].concat.apply([], groups.filter(Array.isArray)).filter(function (raw) {
    if (raw && raw.stops != null) return Number(raw.stops) <= maxStops;
    return !(raw && Array.isArray(raw.flights)) || raw.flights.length - 1 <= maxStops;
  });
  if (!options.length) return { status: 'EMPTY', message: 'Nessun volo restituito per questa tratta e data.' };
  var priced = options.map(function (raw) {
    var p = raw && raw.price;
    return { raw: raw, price: typeof p === 'number' || (typeof p === 'string' && p.trim() !== '') ? Number(p) : NaN };
  }).filter(function (x) { return Number.isFinite(x.price) && x.price > 0; }).sort(function (a, b) { return a.price - b.price; });
  if (!priced.length) return { status: 'ERROR', message: 'Voli presenti, ma prezzo assente o in un formato non riconosciuto.' };
  return { status: 'OK', raw: priced[0].raw, price: priced[0].price, options: priced };
}

function redact_(text, secrets) {
  (secrets || []).filter(Boolean).forEach(function (secret) {
    unique_([secret, encodeURIComponent(secret)]).forEach(function (value) { text = text.split(value).join('[REDACTED]'); });
  });
  return text.replace(/("(?:api[_-]?key|x-rapidapi-key|authorization|set-cookie|cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/((?:api[_-]?key|x-rapidapi-key|authorization|set-cookie|cookie)["']?\s*[:=]\s*["']?)([^"'\s&,}\r\n]+)/gi, '$1[REDACTED]');
}

/** Anche con caratteri UTF-8 da quattro byte ogni documento resta sotto 1 MiB. */
function bodyChunks_(text) {
  var chunks = [], chunk = '';
  for (var ch of text) { chunk += ch; if (chunk.length >= 100000) { chunks.push(chunk); chunk = ''; } }
  if (chunk) chunks.push(chunk);
  return chunks;
}

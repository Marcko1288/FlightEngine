/**
 * Porting di functions/src/round-trip-search.ts.
 * collectRoundTripsStep_ è la versione riprendibile di collectRoundTrips: stesso algoritmo e
 * stesso risultato, ma lo stato (cursore, offerte trattenute, cache delle tratte) è esterno e
 * può essere salvato su Firestore fra un blocco di 6 minuti e il successivo.
 */

function returnDate_(date, nights) {
  var d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
}

function departureDates_(s, monthsAhead, now) {
  now = now || new Date();
  var today = now.toISOString().slice(0, 10), max = new Date(now.getTime());
  max.setUTCMonth(max.getUTCMonth() + monthsAhead);
  var end = [s.departureTo, max.toISOString().slice(0, 10)].sort()[0], out = [];
  for (var date = [s.departureFrom, today].sort()[1]; date <= end; date = returnDate_(date, 1)) {
    var day = new Date(date + 'T12:00:00Z').getUTCDay();
    if (s.allowedDays === 'ALL' || (day >= 4 && day <= 6)) out.push(date);
  }
  return out;
}

function tripQueries_(s, dates, origins, destinations, returnOrigins, returnDestinations) {
  var trips = [];
  dates.forEach(function (departureDate) {
    origins.forEach(function (origin) {
      destinations.forEach(function (destination) {
        if (origin === destination) return;
        (s.returnOrigin ? returnOrigins : [destination]).forEach(function (backOrigin) {
          (s.returnDestination ? returnDestinations : [origin]).forEach(function (backDestination) {
            if (backOrigin === backDestination) return;
            trips.push({ origin: origin, destination: destination, departureDate: departureDate, returnDate: returnDate_(departureDate, s.nights), returnOrigin: backOrigin, returnDestination: backDestination });
          });
        });
      });
    });
  });
  var map = new Map();
  trips.forEach(function (q) { map.set(JSON.stringify(q), q); });
  return Array.from(map.values());
}

function flightQueries_(trip) {
  if (trip.returnOrigin === trip.destination && trip.returnDestination === trip.origin) {
    return [{ origin: trip.origin, destination: trip.destination, departureDate: trip.departureDate, returnDate: trip.returnDate, leg: 'ANDATA_RITORNO' }];
  }
  return [
    { origin: trip.origin, destination: trip.destination, departureDate: trip.departureDate, leg: 'ANDATA' },
    { origin: trip.returnOrigin, destination: trip.returnDestination, departureDate: trip.returnDate, leg: 'RITORNO' }
  ];
}

function requestKey_(q) { return JSON.stringify([q.origin, q.destination, q.departureDate, q.returnDate || null]); }

function plannedRequests_(trips) {
  var map = new Map();
  trips.forEach(function (t) { flightQueries_(t).forEach(function (q) { map.set(requestKey_(q), q); }); });
  var queries = Array.from(map.values());
  return {
    priceRequests: queries.length,
    roundTripRequests: queries.filter(function (q) { return q.returnDate; }).length,
    oneWayRequests: queries.filter(function (q) { return !q.returnDate; }).length,
    maxReturnDetailRequests: 0
  };
}

function newRoundTripProgress_() { return { cursor: 0, items: [], calls: 0, warnings: [], done: false }; }

/**
 * progress: { cursor, items, calls, warnings, done } – modificato sul posto.
 * cache: { requestKey: reply trattenuto } – modificato sul posto.
 * hooks.request(q) -> TripReply (può lanciare PauseSignal_ con chiamate/avvisi parziali);
 * hooks.onLeg(key, reply) per salvare la tratta appena chiamata.
 * Invariante: progress.items contiene solo i contributi dei viaggi < progress.cursor.
 */
function collectRoundTripsStep_(queries, travelers, topResults, progress, cache, hooks) {
  var limit = Math.max(1, Math.floor(topResults) || 1);
  var fetchOnce = function (q) {
    var key = requestKey_(q);
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    var result;
    try { result = hooks.request(q); }
    catch (e) {
      if (e instanceof PauseSignal_) { progress.calls += e.calls; progress.warnings.push.apply(progress.warnings, e.warnings); e.calls = 0; e.warnings = []; }
      throw e;
    }
    progress.calls += result.calls;
    progress.warnings.push.apply(progress.warnings, result.warnings);
    var retained = {};
    Object.keys(result).forEach(function (k) { retained[k] = result[k]; });
    retained.options = result.options.slice().sort(function (a, b) { return a.price - b.price; }).slice(0, limit);
    cache[key] = retained;
    if (hooks.onLeg) hooks.onLeg(key, retained);
    return retained;
  };
  var retain = function (offer) {
    progress.items.push(offer);
    progress.items.sort(function (a, b) { return a.totalPrice - b.totalPrice; });
    progress.items.splice(limit);
  };
  var withTrip = function (trip, extra) {
    var o = { origin: trip.origin, destination: trip.destination, departureDate: trip.departureDate, returnDate: trip.returnDate, returnOrigin: trip.returnOrigin, returnDestination: trip.returnDestination };
    Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  };
  for (; progress.cursor < queries.length; progress.cursor++) {
    var trip = queries[progress.cursor], fq = flightQueries_(trip);
    var out = fetchOnce(fq[0]);
    if (out.exhausted) break;
    if (!out.options.length) continue;
    if (!fq[1]) {
      out.options.forEach(function (option) {
        retain(withTrip(trip, { provider: out.provider, priceType: 'ROUND_TRIP', outboundPrice: null, returnPrice: null, totalPrice: option.price, pricePerPerson: option.price / travelers, outbound: option.raw, return: null, returnDetailsStatus: 'NOT_REQUESTED' }));
      });
      continue;
    }
    var back = fetchOnce(fq[1]);
    if (back.exhausted) break;
    out.options.forEach(function (a) {
      back.options.forEach(function (b) {
        var total = a.price + b.price;
        retain(withTrip(trip, { provider: unique_([out.provider, back.provider]).join(' / '), priceType: 'SEPARATE_ONE_WAY', outboundPrice: a.price, returnPrice: b.price, totalPrice: total, pricePerPerson: total / travelers, outbound: a.raw, return: b.raw, returnDetailsStatus: 'OK' }));
      });
    });
  }
  progress.done = true;
  return { calls: progress.calls, warnings: unique_(progress.warnings), items: progress.items };
}

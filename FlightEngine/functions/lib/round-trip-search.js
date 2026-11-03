"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.returnDate = returnDate;
exports.departureDates = departureDates;
exports.tripQueries = tripQueries;
exports.flightQueries = flightQueries;
exports.plannedRequests = plannedRequests;
exports.collectRoundTrips = collectRoundTrips;
function returnDate(date, nights) {
    const d = new Date(date + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + nights);
    return d.toISOString().slice(0, 10);
}
function departureDates(s, monthsAhead, now = new Date()) {
    const today = now.toISOString().slice(0, 10), max = new Date(now);
    max.setUTCMonth(max.getUTCMonth() + monthsAhead);
    const end = [s.departureTo, max.toISOString().slice(0, 10)].sort()[0], out = [];
    for (let date = [s.departureFrom, today].sort()[1]; date <= end; date = returnDate(date, 1)) {
        const day = new Date(date + "T12:00:00Z").getUTCDay();
        if (s.allowedDays === "ALL" || (day >= 4 && day <= 6))
            out.push(date);
    }
    return out;
}
function tripQueries(s, dates, origins, destinations, returnOrigins, returnDestinations) {
    const trips = [];
    for (const departureDate of dates)
        for (const origin of origins)
            for (const destination of destinations) {
                if (origin === destination)
                    continue;
                for (const backOrigin of (s.returnOrigin ? returnOrigins : [destination]))
                    for (const backDestination of (s.returnDestination ? returnDestinations : [origin])) {
                        if (backOrigin === backDestination)
                            continue;
                        trips.push({ origin, destination, departureDate, returnDate: returnDate(departureDate, s.nights), returnOrigin: backOrigin, returnDestination: backDestination });
                    }
            }
    return [...new Map(trips.map(q => [JSON.stringify(q), q])).values()];
}
function flightQueries(trip) {
    if (trip.returnOrigin === trip.destination && trip.returnDestination === trip.origin) {
        return [{ origin: trip.origin, destination: trip.destination, departureDate: trip.departureDate, returnDate: trip.returnDate, leg: "ANDATA_RITORNO" }];
    }
    return [
        { origin: trip.origin, destination: trip.destination, departureDate: trip.departureDate, leg: "ANDATA" },
        { origin: trip.returnOrigin, destination: trip.returnDestination, departureDate: trip.returnDate, leg: "RITORNO" },
    ];
}
function requestKey(q) { return JSON.stringify([q.origin, q.destination, q.departureDate, q.returnDate || null]); }
function plannedRequests(trips) {
    const queries = [...new Map(trips.flatMap(flightQueries).map(q => [requestKey(q), q])).values()];
    return { priceRequests: queries.length, roundTripRequests: queries.filter(q => q.returnDate).length, oneWayRequests: queries.filter(q => !q.returnDate).length, maxReturnDetailRequests: 0 };
}
// One search prices a standard A/R. Open jaw uses two independent one-way
// fares, reusing identical legs across combinations. Tokens are never followed.
async function collectRoundTrips(queries, travelers, topResults, request) {
    let calls = 0;
    const warnings = [], items = [];
    const limit = Math.max(1, Math.floor(topResults) || 1);
    const cache = new Map();
    const fetchOnce = async (q) => {
        const key = requestKey(q), cached = cache.get(key);
        if (cached)
            return cached;
        const result = await request(q);
        calls += result.calls;
        warnings.push(...result.warnings);
        const retained = { ...result, options: [...result.options].sort((a, b) => a.price - b.price).slice(0, limit) };
        cache.set(key, retained);
        return retained;
    };
    const retain = (offer) => { items.push(offer); items.sort((a, b) => a.totalPrice - b.totalPrice); items.splice(limit); };
    for (const trip of queries) {
        const [outQuery, backQuery] = flightQueries(trip);
        const out = await fetchOnce(outQuery);
        if (out.exhausted)
            break;
        if (!out.options.length)
            continue;
        if (!backQuery) {
            for (const option of out.options)
                retain({ ...trip, provider: out.provider, priceType: "ROUND_TRIP", outboundPrice: null, returnPrice: null, totalPrice: option.price, pricePerPerson: option.price / travelers, outbound: option.raw, return: null, returnDetailsStatus: "NOT_REQUESTED" });
            continue;
        }
        const back = await fetchOnce(backQuery);
        if (back.exhausted)
            break;
        for (const a of out.options)
            for (const b of back.options) {
                const total = a.price + b.price;
                retain({ ...trip, provider: [...new Set([out.provider, back.provider])].join(" / "), priceType: "SEPARATE_ONE_WAY", outboundPrice: a.price, returnPrice: b.price, totalPrice: total, pricePerPerson: total / travelers, outbound: a.raw, return: b.raw, returnDetailsStatus: "OK" });
            }
    }
    return { calls, warnings: [...new Set(warnings)], items };
}

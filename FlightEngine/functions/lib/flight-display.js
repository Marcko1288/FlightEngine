"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providerName = providerName;
exports.legDetails = legDetails;
exports.routeCodes = routeCodes;
exports.durationText = durationText;
exports.returnDescription = returnDescription;
const search_data_1 = require("./search-data");
function providerName(value) {
    return [...new Set((value || "").split(" / ").map(name => /rapid/i.test(name) ? "RapidApi" : /serp/i.test(name) ? "SerpiApi" : name.replace(/\s*\(.*\)/, "").trim()).filter(Boolean))].join(" / ");
}
function legDetails(raw) {
    const flights = Array.isArray(raw?.flights) ? raw.flights : [];
    const first = flights[0], last = flights[flights.length - 1];
    const airport = (a) => ({ code: a?.airport_code || a?.id || "", name: a?.airport_name || a?.name || "", time: (0, search_data_1.formatDate)(a?.time || "") });
    const minutes = (value) => Number(typeof value === "object" ? value?.raw : value) || 0;
    return { origin: airport(first?.departure_airport), destination: airport(last?.arrival_airport), airlines: flights.map((f) => `${f.airline || ""} ${f.flight_number || ""}`.trim()), duration: minutes(raw?.total_duration ?? raw?.duration), stops: raw?.stops ?? Math.max(0, flights.length - 1), layoverMinutes: (Array.isArray(raw?.layovers) ? raw.layovers : []).reduce((sum, l) => sum + minutes(l.duration), 0) };
}
function routeCodes(result, back = false) {
    const details = legDetails(back ? result.return : result.outbound);
    const start = details.origin.code || (back ? result.returnOrigin : result.origin);
    const end = details.destination.code || (back ? result.returnDestination : result.destination);
    if (start && end)
        return `${start} → ${end}`;
    const old = String(result.provider || "").match(/\(([A-Z]{3})-([A-Z]{3})\)/g) || [];
    const route = old[back ? 1 : 0];
    return route ? route.slice(1, -1).replace("-", " → ") : "—";
}
function durationText(minutes) { return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
function returnDescription(result) {
    if (result.returnDetailsStatus === "NOT_REQUESTED")
        return `${routeCodes(result, true)} (incluso nel prezzo A/R; dettagli non richiesti)`;
    if (result.returnDetailsStatus === "UNAVAILABLE")
        return "Dettagli non disponibili al prezzo A/R indicato";
    return routeCodes(result, true);
}

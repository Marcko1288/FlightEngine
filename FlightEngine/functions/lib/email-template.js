"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = escapeHtml;
exports.googleFlightsLinks = googleFlightsLinks;
exports.renderAlertEmail = renderAlertEmail;
const search_data_1 = require("./search-data");
const flight_display_1 = require("./flight-display");
const google_flights_link_1 = require("./google-flights-link");
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function googleFlightsLinks(offer, currency) {
    const out = (0, flight_display_1.legDetails)(offer.outbound), back = (0, flight_display_1.legDetails)(offer.return);
    const origin = out.origin.code || offer.origin, destination = out.destination.code || offer.destination;
    const returnOrigin = back.origin.code || offer.returnOrigin || destination, returnDestination = back.destination.code || offer.returnDestination || origin;
    const link = (label, from, to, date, returnDate) => {
        const travelers = offer.travelers ?? Math.round(offer.totalPrice / offer.pricePerPerson);
        return { label, url: (0, google_flights_link_1.googleFlightsSearchUrl)(from, to, date, returnDate, currency, travelers, offer.maxStops) };
    };
    if (offer.priceType === "SEPARATE_ONE_WAY" || returnOrigin !== destination || returnDestination !== origin) {
        return [
            ...(origin && destination && offer.departureDate ? [link("Apri andata su Google Flights", origin, destination, offer.departureDate)] : []),
            ...(returnOrigin && returnDestination && offer.returnDate ? [link("Apri ritorno su Google Flights", returnOrigin, returnDestination, offer.returnDate)] : [])
        ];
    }
    return origin && destination && offer.departureDate ? [link("Apri su Google Flights", origin, destination, offer.departureDate, offer.returnDate)] : [];
}
function renderAlertEmail(offers, currency) {
    const esc = escapeHtml, money = (n) => esc(new Intl.NumberFormat("it-IT", { style: "currency", currency }).format(n));
    const groups = new Map();
    for (const offer of offers) {
        const cluster = offer.cluster || offer.period || "Senza cluster";
        groups.set(cluster, [...(groups.get(cluster) || []), offer]);
    }
    const legRow = (raw, date, origin, destination) => {
        const leg = (0, flight_display_1.legDetails)(raw), hasFlights = Array.isArray(raw?.flights) && raw.flights.length > 0;
        const airport = (name, code) => [esc(name), code ? `(${esc(code)})` : ""].filter(Boolean).join("<br>") || "—";
        return `<tr><td>${airport(leg.origin.name, leg.origin.code || origin)}</td><td>${airport(leg.destination.name, leg.destination.code || destination)}</td><td>${leg.airlines.filter(Boolean).map(esc).join("<br>") || "—"}</td><td>${esc(leg.origin.time || (0, search_data_1.formatDate)(date)) || "—"}</td><td>${esc(leg.destination.time) || "—"}</td><td>${raw?.total_duration != null || raw?.duration != null ? esc((0, flight_display_1.durationText)(leg.duration)) : "—"}</td><td>${raw?.stops != null || hasFlights ? esc(leg.stops) : "—"}</td><td>${Array.isArray(raw?.layovers) ? esc((0, flight_display_1.durationText)(leg.layoverMinutes)) : "—"}</td></tr>`;
    };
    return `<!doctype html><html lang="it"><body style="font-family:Arial,sans-serif;color:#111">${[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cluster, items]) => `<h2>${esc(cluster)}</h2>${items.sort((a, b) => Number(a.pricePerPerson) - Number(b.pricePerPerson) || a.departureDate.localeCompare(b.departureDate)).map(offer => `<div style="margin:0 0 28px"><p><b>${esc(offer.destinationName)}</b>: ${esc((0, search_data_1.formatDate)(offer.departureDate))} → ${esc((0, search_data_1.formatDate)(offer.returnDate))}${offer.priceType === "SEPARATE_ONE_WAY" ? " ? Due voli di sola andata" : ""}</p><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;border-color:#bbb;font-size:12px;width:100%;max-width:900px"><thead><tr>${["Città Partenza", "Città Arrivo", "Compagnia", "Partenza", "Arrivo", "Durata Volo", "Scali", "Durata Scali"].map(title => `<th align="left">${title}</th>`).join("")}</tr></thead><tbody>${legRow(offer.outbound, offer.departureDate, offer.origin, offer.destination)}${legRow(offer.return, offer.returnDate, offer.returnOrigin || offer.destination, offer.returnDestination || offer.origin)}${["UNAVAILABLE", "NOT_REQUESTED"].includes(offer.returnDetailsStatus) ? `<tr><td colspan="8">Ritorno: ${esc((0, flight_display_1.returnDescription)(offer))}</td></tr>` : ""}<tr><th colspan="7" align="left">TOTALE:</th><td><b>${money(offer.totalPrice)}</b></td></tr><tr><th colspan="7" align="left">TOTALE PER PERSONA:</th><td><b>${money(offer.pricePerPerson)}</b></td></tr></tbody></table><p>${googleFlightsLinks(offer, currency).map(link => `<a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin:8px 12px 0 0;color:#155eef;font-weight:bold">${esc(link.label)}</a>`).join("")}</p></div>`).join("")}`).join("")}</body></html>`;
}

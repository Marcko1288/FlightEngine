"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tripRequest = tripRequest;
const rapid_request_1 = require("./rapid-request");
const provider_response_1 = require("./provider-response");
function tripRequest(provider, key, trip, travelers, maxStops, currency) {
    if (provider === "SerpApi") {
        const q = new URLSearchParams({ engine: "google_flights", gl: "it", hl: "it", currency, type: trip.returnDate ? "1" : "2", adults: String(travelers), stops: (0, provider_response_1.serpStops)(maxStops), api_key: key, departure_id: trip.origin, arrival_id: trip.destination, outbound_date: trip.departureDate });
        if (trip.returnDate)
            q.set("return_date", trip.returnDate);
        return { url: "https://serpapi.com/search.json?" + q, init: {}, kind: "serp" };
    }
    const headers = { "x-rapidapi-key": key, "x-rapidapi-host": "google-flights2.p.rapidapi.com" };
    const base = "https://google-flights2.p.rapidapi.com/api/v1/";
    const q = (0, rapid_request_1.rapidQuery)(trip.origin, trip.destination, trip.departureDate, travelers, currency);
    if (trip.returnDate)
        q.set("return_date", trip.returnDate);
    return { url: base + "searchFlights?" + q, init: { headers }, kind: "rapid" };
}

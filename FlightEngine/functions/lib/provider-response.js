"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serpStops = serpStops;
exports.parseResponse = parseResponse;
function serpStops(maxStops) { return String(maxStops >= 2 ? 3 : maxStops + 1); }
async function parseResponse(res, kind, maxStops = Infinity) {
    if (res.status === 429)
        return { status: "LIMIT", message: "Quota API esaurita (HTTP 429)." };
    if (!res.ok)
        return { status: "ERROR", message: `Il provider ha risposto HTTP ${res.status}.` };
    let j;
    try {
        j = await res.json();
    }
    catch {
        return { status: "ERROR", message: "Il provider non ha restituito JSON valido." };
    }
    if (!j || typeof j !== "object")
        return { status: "ERROR", message: "Risposta del provider non riconosciuta." };
    if (j.error || j.status === false || j.status === "error" || j.search_metadata?.status === "Error")
        return { status: "ERROR", message: "Il provider segnala un errore nella risposta. Verifica parametri, credenziali e quota." };
    const groups = kind === "serp" ? [j.best_flights, j.other_flights] : [j.data?.itineraries?.topFlights, j.data?.itineraries?.otherFlights, j.data?.itineraries];
    if (!groups.some(Array.isArray))
        return { status: "ERROR", message: "Formato della risposta non riconosciuto: mancano le liste dei voli attese." };
    const options = groups.filter(Array.isArray).flat().filter((raw) => {
        if (raw?.stops != null)
            return Number(raw.stops) <= maxStops;
        return !Array.isArray(raw?.flights) || raw.flights.length - 1 <= maxStops;
    });
    if (!options.length)
        return { status: "EMPTY", message: "Nessun volo restituito per questa tratta e data." };
    const priced = options.map((raw) => ({ raw, price: typeof raw?.price === "number" || typeof raw?.price === "string" && raw.price.trim() !== "" ? Number(raw.price) : NaN })).filter(x => Number.isFinite(x.price) && x.price > 0).sort((a, b) => a.price - b.price);
    if (!priced.length)
        return { status: "ERROR", message: "Voli presenti, ma prezzo assente o in un formato non riconosciuto." };
    return { status: "OK", ...priced[0], options: priced };
}

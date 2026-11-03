"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.csvColumns = exports.blankSearch = void 0;
exports.isoDate = isoDate;
exports.formatDate = formatDate;
exports.formatTimestamp = formatTimestamp;
exports.normalizeSearch = normalizeSearch;
exports.parseCsv = parseCsv;
exports.importSearches = importSearches;
exports.exportSearches = exportSearches;
exports.blankSearch = { origin: "Milano", destination: "", returnOrigin: "", returnDestination: "", departureFrom: "", departureTo: "", pricePerPerson: 100, maxStops: 1, nights: 4, travelers: 4, destinationName: "", allowedDays: "ALL", cluster: "", active: true };
function isoDate(value) {
    const text = String(value ?? "").trim();
    const it = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    const iso = it ? `${it[3]}-${it[2]}-${it[1]}` : text;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso))
        throw Error("Data non valida: usa GG/MM/AAAA.");
    const date = new Date(iso + "T12:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
        throw Error(`Data non valida: ${text}`);
    return iso;
}
function formatDate(value) {
    const text = String(value ?? "");
    return text.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_, y, m, d) => `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}`);
}
function formatTimestamp(value) {
    const date = value?.toDate?.();
    return date ? date.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}
function normalizeSearch(raw) {
    const str = (key, fallback = "") => String(raw[key] ?? fallback).trim();
    const number = (key, min, integer = true) => {
        const value = raw[key] === undefined || raw[key] === "" ? Number(exports.blankSearch[key]) : Number(String(raw[key]).replace(",", "."));
        if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value)))
            throw Error(`Valore non valido: ${key}`);
        return value;
    };
    const origin = str("origin").toUpperCase(), destination = str("destination").toUpperCase();
    if (!origin || !destination)
        throw Error("Partenza e arrivo sono obbligatori.");
    const departureFrom = isoDate(raw.departureFrom), departureTo = isoDate(raw.departureTo);
    if (departureFrom > departureTo)
        throw Error("La data finale deve essere successiva o uguale a quella iniziale.");
    const allowedDays = str("allowedDays", "ALL").toUpperCase();
    if (allowedDays !== "ALL" && allowedDays !== "WEEKEND")
        throw Error("Giorni non validi: usa ALL o WEEKEND.");
    return { origin, destination, returnOrigin: str("returnOrigin").toUpperCase(), returnDestination: str("returnDestination").toUpperCase(), departureFrom, departureTo, pricePerPerson: number("pricePerPerson", 0, false), maxStops: number("maxStops", 0), nights: number("nights", 1), travelers: number("travelers", 1), destinationName: str("destinationName") || destination, allowedDays, cluster: str("cluster", str("period")), active: ![false, "false", "FALSE", 0, "0"].includes(raw.active) };
}
exports.csvColumns = ["origin", "destination", "returnOrigin", "returnDestination", "departureFrom", "departureTo", "pricePerPerson", "maxStops", "nights", "destinationName", "travelers", "allowedDays", "cluster", "active"];
function parseCsv(text) {
    text = text.replace(/^\uFEFF/, "");
    const first = text.split(/\r?\n/)[0];
    const delimiter = first.includes(";") ? ";" : ",";
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (quoted && text[i + 1] === '"') {
                cell += '"';
                i++;
            }
            else
                quoted = !quoted;
        }
        else if (c === delimiter && !quoted) {
            row.push(cell);
            cell = "";
        }
        else if ((c === "\n" || c === "\r") && !quoted) {
            if (c === "\r" && text[i + 1] === "\n")
                i++;
            row.push(cell);
            if (row.some(v => v.trim()))
                rows.push(row);
            row = [];
            cell = "";
        }
        else
            cell += c;
    }
    if (quoted)
        throw Error("CSV non valido: virgolette non chiuse.");
    row.push(cell);
    if (row.some(v => v.trim()))
        rows.push(row);
    return rows;
}
function importSearches(text, json = false) {
    let raw;
    if (json) {
        raw = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (!Array.isArray(raw))
            throw Error("Il JSON deve contenere un elenco di ricerche.");
    }
    else {
        const rows = parseCsv(text);
        if (!rows.length)
            throw Error("Il file è vuoto.");
        const hasHeader = rows[0].some(v => v.trim().toLowerCase() === "origin");
        const headers = hasHeader ? rows.shift().map(v => v.trim() === "period" ? "cluster" : v.trim()) : exports.csvColumns;
        raw = rows.map((values, i) => { if (values.length > headers.length || (!hasHeader && values.length < 13))
            throw Error(`Riga ${i + 1}: numero di colonne non valido.`); return Object.fromEntries(values.map((value, index) => [headers[index], value])); });
    }
    if (!raw.length)
        throw Error("Il file non contiene ricerche.");
    return raw.map((row, i) => { try {
        return normalizeSearch(row);
    }
    catch (e) {
        throw Error(`Riga ${i + 1}: ${e.message}`);
    } });
}
function exportSearches(rows, format) {
    const data = rows.map(row => { const normalized = normalizeSearch(row); return { ...normalized, departureFrom: formatDate(normalized.departureFrom), departureTo: formatDate(normalized.departureTo) }; });
    if (format === "json")
        return JSON.stringify(data, null, 2);
    const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return "\uFEFF" + [exports.csvColumns.join(";"), ...data.map(row => exports.csvColumns.map(key => escape(row[key])).join(";"))].join("\r\n");
}

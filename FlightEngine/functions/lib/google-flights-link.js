"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleFlightsSearchUrl = googleFlightsSearchUrl;
// Google Flights' tfs query is a base64url protobuf, not a free-text q.
// Field reference: https://github.com/AWeirdDev/flights/blob/dev/fast_flights/pb/flights.proto
function varint(value) {
    const bytes = [];
    do {
        const byte = value % 128;
        value = Math.floor(value / 128);
        bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(bytes);
}
const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]); };
function googleFlightsSearchUrl(from, to, date, returnDate, currency, travelers = 1, maxStops) {
    const airport = (code) => message(2, code);
    const leg = (origin, destination, departure) => message(3, Buffer.concat([
        message(2, departure), message(13, airport(origin)), message(14, airport(destination)),
        ...(Number.isSafeInteger(maxStops) && maxStops >= 0 ? [integer(5, maxStops)] : [])
    ]));
    const adults = Number.isSafeInteger(travelers) && travelers > 0 && travelers <= 9 ? travelers : 1;
    const tfs = Buffer.concat([
        leg(from, to, date), ...(returnDate ? [leg(to, from, returnDate)] : []),
        message(8, Buffer.alloc(adults, 1)), integer(9, 1), integer(19, returnDate ? 1 : 2)
    ]).toString("base64url");
    return `https://www.google.com/travel/flights/search?${new URLSearchParams({ tfs, hl: "it", curr: currency })}`;
}

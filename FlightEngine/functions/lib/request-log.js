"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redact = redact;
exports.bodyChunks = bodyChunks;
exports.logEvent = logEvent;
exports.loggedRequest = loggedRequest;
const firestore_1 = require("firebase-admin/firestore");
const provider_response_1 = require("./provider-response");
function redact(text, secrets = []) {
    for (const secret of secrets.filter(Boolean))
        for (const value of new Set([secret, encodeURIComponent(secret)]))
            text = text.split(value).join("[REDACTED]");
    return text.replace(/("(?:api[_-]?key|x-rapidapi-key|authorization|set-cookie|cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
        .replace(/((?:api[_-]?key|x-rapidapi-key|authorization|set-cookie|cookie)["']?\s*[:=]\s*["']?)([^"'\s&,}\r\n]+)/gi, "$1[REDACTED]");
}
function bodyChunks(text) {
    // Even four-byte UTF-8 characters keep each document well below 1 MiB.
    const chunks = [];
    let chunk = "";
    for (const char of text) {
        chunk += char;
        if (chunk.length >= 100000) {
            chunks.push(chunk);
            chunk = "";
        }
    }
    if (chunk)
        chunks.push(chunk);
    return chunks;
}
async function logEvent(ctx, message, data = {}) {
    await ctx.checkpoint?.();
    await ctx.runRef.update({ lastActivityAt: firestore_1.FieldValue.serverTimestamp(), lastEvent: message, currentSearchId: ctx.searchId });
    await ctx.runRef.collection("entries").add({ kind: "EVENT", startedAt: firestore_1.FieldValue.serverTimestamp(), searchId: ctx.searchId, message, ...data });
}
async function loggedRequest(url, init, kind, ctx, key) {
    await ctx.checkpoint?.();
    const ref = ctx.runRef.collection("entries").doc(), started = Date.now();
    const safe = (text) => redact(text, [key]);
    await ref.set({ kind: "CALL", startedAt: firestore_1.FieldValue.serverTimestamp(), searchId: ctx.searchId, leg: ctx.leg || "", provider: kind === "serp" ? "SerpApi" : "RapidAPI", status: "RUNNING", request: { method: init.method || "GET", url: safe(url), ...(typeof init.body === "string" ? { body: safe(init.body) } : {}), headers: JSON.parse(safe(JSON.stringify(Object.fromEntries(new Headers(init.headers))))) } });
    await ctx.runRef.update({ apiCalls: firestore_1.FieldValue.increment(1) });
    await ref.update({ keyIndex: ctx.keyIndex ?? null, keyCycle: ctx.keyCycle ?? null });
    let res, body;
    try {
        res = await fetch(url, { ...init, signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
        await ref.update({ httpStatus: res.status, httpStatusText: res.statusText, responseHeaders: JSON.parse(safe(JSON.stringify(Object.fromEntries(res.headers)))) });
        body = await res.clone().text();
    }
    catch (e) {
        const message = safe([e?.name, e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(": "));
        await ref.update({ status: "ERROR", message, finishedAt: firestore_1.FieldValue.serverTimestamp(), durationMs: Date.now() - started });
        ctx.signal?.throwIfAborted();
        return { status: "ERROR", message };
    }
    const chunks = bodyChunks(safe(body));
    for (let i = 0; i < chunks.length; i++)
        await ref.collection("body").doc(String(i).padStart(8, "0")).set({ index: i, text: chunks[i] });
    const parsed = await (0, provider_response_1.parseResponse)(res, kind, ctx.maxStops);
    await ref.update({ status: parsed.status, message: parsed.status === "OK" ? "Offerta trovata" : parsed.message, price: parsed.status === "OK" ? parsed.price : null, bodyChunks: chunks.length, finishedAt: firestore_1.FieldValue.serverTimestamp(), durationMs: Date.now() - started });
    await ctx.checkpoint?.();
    return parsed;
}

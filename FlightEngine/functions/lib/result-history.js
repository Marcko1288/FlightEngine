"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resultTime = resultTime;
exports.latestPerSearch = latestPerSearch;
function resultTime(r) { return r.checkedAt?.toMillis?.() || 0; }
function latestPerSearch(results) {
    const latest = new Map();
    for (const r of results) {
        const old = latest.get(r.searchId);
        if (!old || ((r.runId && r.runId === old.runId) ? r.pricePerPerson < old.pricePerPerson : resultTime(r) > resultTime(old) || (resultTime(r) === resultTime(old) && r.pricePerPerson < old.pricePerPerson)))
            latest.set(r.searchId, r);
    }
    return [...latest.values()].sort((a, b) => resultTime(b) - resultTime(a));
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.keyCandidates = keyCandidates;
exports.selectKey = selectKey;
exports.beginKeyRun = beginKeyRun;
const node_crypto_1 = require("node:crypto");
function keyCandidates(providers) {
    const seen = new Set();
    return providers.flatMap(p => p.keys.flatMap((value, index) => {
        const key = value.trim();
        if (!key)
            return [];
        const id = (0, node_crypto_1.createHash)("sha256").update(`${p.name}:${key}`).digest("hex");
        if (seen.has(id))
            return [];
        seen.add(id);
        return [{ id, provider: p.name, key, index: index + 1 }];
    }));
}
function selectKey(state, candidates, attempted) {
    const start = Math.max(0, candidates.findIndex(k => k.id === state.startKeyId));
    const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
    const key = ordered.find(k => !state.exhausted.includes(k.id) && !attempted.has(k.id));
    return { state, key, reset: false };
}
// Called once per execution, transactionally shared by all its tasks and retries.
// Resume at the first previously usable key and permit only one full turn.
function beginKeyRun(previous, candidates) {
    const first = selectKey(previous, candidates, new Set()).key || candidates[0];
    return { cycle: previous.cycle + 1, exhausted: [], ...(first ? { startKeyId: first.id } : {}) };
}

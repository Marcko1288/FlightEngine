"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunStopped = void 0;
exports.startRunControl = startRunControl;
const firestore_1 = require("firebase-admin/firestore");
class RunStopped extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
exports.RunStopped = RunStopped;
function startRunControl(ref, durationMs = 27 * 60 * 1000) {
    const controller = new AbortController();
    const stop = (reason) => { if (!controller.signal.aborted)
        controller.abort(reason); };
    const deadline = setTimeout(() => stop(new RunStopped("TIMED_OUT", "Limite di durata raggiunto. I risultati già salvati sono disponibili.")), durationMs);
    const unsubscribe = ref.onSnapshot(snap => { if (snap.data()?.cancelRequestedAt)
        stop(new RunStopped("CANCELLED", "Esecuzione arrestata su richiesta.")); }, error => {
        console.error("run-control", { runId: ref.id, error: error.message });
        stop(new RunStopped("CANCELLED", "Monitoraggio arresto non disponibile: esecuzione fermata per evitare chiamate senza controllo."));
    });
    let pending = false;
    const heartbeat = setInterval(async () => { if (pending)
        return; pending = true; try {
        await ref.update({ heartbeatAt: firestore_1.FieldValue.serverTimestamp() });
    }
    catch (error) {
        console.error("run-heartbeat", { runId: ref.id, error });
    }
    finally {
        pending = false;
    } }, 15000);
    return { signal: controller.signal, checkpoint: async () => { controller.signal.throwIfAborted(); }, close: () => { clearTimeout(deadline); clearInterval(heartbeat); unsubscribe(); } };
}

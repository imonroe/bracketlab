import { getContext } from "@/server/context";
import { json } from "@/server/http";

/** Readiness: fails when the database is unreachable or the worker has stopped beating. */
export async function GET() {
  try {
    const { store, config } = getContext();
    const beat = store.lastHeartbeat();
    const worker = beat !== undefined && Date.now() - beat.beatAt < config.workerStaleMs;
    return json({ ok: worker, database: true, worker }, { status: worker ? 200 : 503 });
  } catch {
    return json({ ok: false, database: false, worker: false }, { status: 503 });
  }
}

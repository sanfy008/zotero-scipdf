import { getString } from "../utils/locale";
import { Utils } from "../utils/utils";

// Guards every long-running library operation against another one starting in
// parallel. All three entry points (fetch, DOI audit, metadata enrichment) read
// and write the same item fields, so overlapping runs can interleave writes and
// produce duplicate attachments or lost field updates.
//
// A hung task must not disable the plugin forever: the lock carries a watchdog
// that releases a stale lock after a generous deadline. Releasing is best-effort
// cancellation is impossible here, so the user is told the old task may still be
// running; a generation counter ensures the old task's eventual completion can
// never unlock a *newer* operation.

const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;

export interface OperationGateState {
  busy: boolean;
  label: string;
  startedAt: number;
  elapsedMs: number;
}

export interface RunExclusiveOptions {
  /** Human-readable name shown in the busy/stale notices. */
  label?: string;
  /** Watchdog deadline; 0 or Infinity disables it. */
  maxDurationMs?: number;
  /** Test/diagnostic hook fired when a stale lock is released. */
  onStale?: (state: OperationGateState) => void;
}

interface LockState {
  token: number;
  label: string;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

let lock: LockState | null = null;
let generation = 0;

function stateOf(current: LockState): OperationGateState {
  return {
    busy: true,
    label: current.label,
    startedAt: current.startedAt,
    elapsedMs: Date.now() - current.startedAt,
  };
}

export function getOperationGateState(): OperationGateState {
  return lock
    ? stateOf(lock)
    : { busy: false, label: "", startedAt: 0, elapsedMs: 0 };
}

export function isPluginBusy(): boolean {
  return lock !== null;
}

/**
 * Runs `task` exclusively. Returns false without running when another operation
 * already holds the lock, after showing a short "busy" notice.
 */
export async function runExclusive(
  task: () => Promise<void>,
  options: RunExclusiveOptions = {},
): Promise<boolean> {
  if (lock) {
    const busyLabel = lock.label;
    Utils.showPopWin(
      getString("popwin-busy-hint"),
      busyLabel
        ? getString("popwin-busy-hint-detail", {
            args: { label: busyLabel },
          })
        : getString("popwin-busy-hint"),
      "default",
    );
    return false;
  }

  const token = ++generation;
  const current: LockState = {
    token,
    label: options.label ?? "",
    startedAt: Date.now(),
  };
  lock = current;

  const limit = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (Number.isFinite(limit) && limit > 0) {
    current.timer = setTimeout(() => {
      if (!lock || lock.token !== token) {
        return;
      }
      const stale = stateOf(lock);
      lock = null;
      generation++;
      current.timer = undefined;
      try {
        if (typeof Zotero !== "undefined" && Zotero?.debug) {
          Zotero.debug(
            `[Sci-PDF] released stale operation lock "${stale.label}" after ${stale.elapsedMs}ms`,
          );
        }
      } catch {
        // ignore: diagnostics only
      }
      try {
        options.onStale?.(stale);
      } catch {
        // ignore: a broken hook must not break the gate
      }
      Utils.showPopWin(
        getString("popwin-gate-stale-title"),
        getString("popwin-gate-stale", {
          args: { label: stale.label || getString("popwin-busy-hint") },
        }),
        "fail",
        8000,
      );
    }, limit);
    // Never keep a Node/test process alive just for the watchdog.
    (current.timer as { unref?: () => void })?.unref?.();
  }

  try {
    await task();
    return true;
  } finally {
    if (lock && lock.token === token) {
      if (lock.timer) {
        clearTimeout(lock.timer);
      }
      lock = null;
      generation++;
    }
  }
}

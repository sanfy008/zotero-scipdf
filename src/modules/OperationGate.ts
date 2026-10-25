import { getString } from "../utils/locale";
import { Utils } from "../utils/utils";

// Guards every long-running library operation against another one starting in
// parallel. All three entry points (fetch, DOI audit, metadata enrichment) read
// and write the same item fields, so overlapping runs can interleave writes and
// produce duplicate attachments or lost field updates.
let running = false;

export function isPluginBusy(): boolean {
  return running;
}

/**
 * Runs `task` exclusively. Returns false without running when another operation
 * already holds the lock, after showing a short "busy" notice.
 */
export async function runExclusive(
  task: () => Promise<void>,
): Promise<boolean> {
  if (running) {
    Utils.showPopWin(
      getString("popwin-busy-hint"),
      getString("popwin-busy-hint"),
      "default",
    );
    return false;
  }
  running = true;
  try {
    await task();
    return true;
  } finally {
    running = false;
  }
}

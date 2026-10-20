import fs from "node:fs/promises";
import path from "node:path";

import { GuardError, abortError, abortableSleep } from "./util.js";

/**
 * Cross-process mutex built on the atomic `mkdir` primitive.
 *
 * The guard state file coordinates limits inside one OpenCode process; this
 * lock makes "only one agy process at a time" hold across terminals, the
 * Desktop app and the CLI, as long as they share the same state path.
 *
 * The holder refreshes the directory mtime as a heartbeat. A crashed holder
 * leaves the directory behind; waiters take it over once the heartbeat is
 * older than `staleMs` (rename to a tombstone, then delete, so only one waiter
 * wins the takeover race).
 */
export function lockPathForStatePath(statePath) {
  return `${statePath}.lock`;
}

const DEFAULT_STALE_MS = 120_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 30_000;

export class FileLock {
  constructor(options = {}) {
    if (!options.lockPath) throw new Error("FileLock requires a lockPath");
    this.lockPath = options.lockPath;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  /**
   * Acquire the lock. `timeoutMs = 0` means "wait forever" (the guard always
   * passes a bounded timeout). Resolves to an idempotent release function.
   */
  async acquire(signal, timeoutMs = 0) {
    const startedAt = this.now();
    await fs
      .mkdir(path.dirname(this.lockPath), { recursive: true })
      .catch(() => {});

    for (;;) {
      if (signal?.aborted) throw abortError(signal);

      try {
        await fs.mkdir(this.lockPath);
        return await this.own();
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      // A crashed holder leaves the directory behind. Take it over once its
      // heartbeat is older than staleMs.
      try {
        const stat = await fs.stat(this.lockPath);
        if (this.now() - stat.mtimeMs > this.staleMs) {
          const tombstone = `${this.lockPath}.stale-${process.pid}-${this.now()}`;
          try {
            await fs.rename(this.lockPath, tombstone);
            await fs.rm(tombstone, { recursive: true, force: true });
          } catch {
            // Another waiter won the takeover race; keep polling.
          }
          continue;
        }
      } catch (error) {
        if (error?.code === "ENOENT") continue; // Released while we looked.
      }

      if (timeoutMs > 0 && this.now() - startedAt >= timeoutMs) {
        throw new GuardError(
          "AGY_GUARD_QUEUE_TIMEOUT",
          "agy is busy in another OpenCode process and the request queue timed out",
          { retryAfterMs: 5_000 },
        );
      }

      const jitter = Math.floor(this.random() * Math.max(this.pollMs, 1));
      await abortableSleep(this.pollMs + jitter, signal);
    }
  }

  /** Mark the directory as owned and keep its mtime fresh while held. */
  async own() {
    const ownerPath = path.join(this.lockPath, "owner.json");
    await fs
      .writeFile(
        ownerPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      )
      .catch(() => {});

    const timer = setInterval(() => {
      fs.utimes(this.lockPath, new Date(), new Date()).catch(() => {});
    }, Math.max(this.heartbeatMs, 1_000));
    timer.unref?.();

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
    };
  }
}

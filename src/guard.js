import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileLock, lockPathForStatePath } from "./lock.js";
import { GuardError, abortError, abortableSleep } from "./util.js";

export { GuardError };

/**
 * Default guard state path. Kept under OpenCode's local data directory so the
 * daily cap and circuit breaker survive terminal/desktop restarts.
 */
export const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "agy-guard-state.json",
);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  statePath: DEFAULT_STATE_PATH,
  minIntervalMs: 1_500,
  jitterMs: 500,
  windowMs: 60_000,
  maxPerWindow: 10,
  breakerThreshold: 4,
  breakerCooldownMs: 300_000,
  dailyCap: 500,
  queueTimeoutMs: 120_000,
  crossProcess: true,
  maxQueueDepth: 4,
  lockStaleMs: 120_000,
  lockPollMs: 250,
  lockHeartbeatMs: 30_000,
});

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value);
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read tunables from the environment. Invalid values fall back silently. */
export function guardConfigFromEnv() {
  return {
    enabled: envBool("AGY_GUARD_ENABLED", true),
    statePath: process.env.AGY_GUARD_STATE || DEFAULT_STATE_PATH,
    minIntervalMs: envInt("AGY_GUARD_MIN_INTERVAL_MS", DEFAULT_CONFIG.minIntervalMs),
    jitterMs: envInt("AGY_GUARD_JITTER_MS", DEFAULT_CONFIG.jitterMs),
    windowMs: envInt("AGY_GUARD_WINDOW_MS", DEFAULT_CONFIG.windowMs),
    maxPerWindow: envInt("AGY_GUARD_MAX_PER_WINDOW", DEFAULT_CONFIG.maxPerWindow),
    breakerThreshold: envInt(
      "AGY_GUARD_BREAKER_THRESHOLD",
      DEFAULT_CONFIG.breakerThreshold,
    ),
    breakerCooldownMs: envInt(
      "AGY_GUARD_BREAKER_COOLDOWN_MS",
      DEFAULT_CONFIG.breakerCooldownMs,
    ),
    dailyCap: envInt("AGY_GUARD_DAILY_CAP", DEFAULT_CONFIG.dailyCap),
    queueTimeoutMs: envInt(
      "AGY_GUARD_QUEUE_TIMEOUT_MS",
      DEFAULT_CONFIG.queueTimeoutMs,
    ),
    crossProcess: envBool("AGY_GUARD_CROSS_PROCESS", DEFAULT_CONFIG.crossProcess),
    maxQueueDepth: envInt("AGY_GUARD_MAX_QUEUE", DEFAULT_CONFIG.maxQueueDepth),
    lockStaleMs: envInt("AGY_GUARD_LOCK_STALE_MS", DEFAULT_CONFIG.lockStaleMs),
    lockPollMs: envInt("AGY_GUARD_LOCK_POLL_MS", DEFAULT_CONFIG.lockPollMs),
    lockHeartbeatMs: envInt(
      "AGY_GUARD_LOCK_HEARTBEAT_MS",
      DEFAULT_CONFIG.lockHeartbeatMs,
    ),
  };
}

export function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * FIFO mutex with abort and queue-timeout support. The returned release
 * function is idempotent, so a double call in finally cannot unlock twice.
 */
class Mutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  acquire(signal, timeoutMs) {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    if (!this.locked) {
      this.locked = true;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        this.release();
      });
    }

    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        resolve,
        reject,
        timer: null,
        onAbort: null,
        settled: false,
      };

      const cleanup = () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.signal?.removeEventListener("abort", entry.onAbort);
      };

      const settle = (fn, value) => {
        if (entry.settled) return;
        entry.settled = true;
        cleanup();
        fn(value);
      };

      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        settle(reject, abortError(signal));
      };

      if (signal) signal.addEventListener("abort", entry.onAbort, { once: true });

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          settle(
            reject,
            new GuardError(
              "AGY_GUARD_QUEUE_TIMEOUT",
              "agy is busy and the request queue timed out",
              { retryAfterMs: 5_000 },
            ),
          );
        }, timeoutMs);
      }

      this.queue.push(entry);
    });
  }

  release() {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next.settled) continue;
      if (next.signal?.aborted) {
        next.settled = true;
        if (next.timer) clearTimeout(next.timer);
        next.signal?.removeEventListener("abort", next.onAbort);
        next.reject(abortError(next.signal));
        continue;
      }

      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      next.signal?.removeEventListener("abort", next.onAbort);
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.release();
      });
      return;
    }

    this.locked = false;
  }
}

const RATE_LIMIT_PATTERN =
  /429|resource_exhausted|quota|rate.?limit|too many requests|overloaded/i;

export function isRateLimitText(value) {
  return RATE_LIMIT_PATTERN.test(String(value ?? ""));
}

/**
 * Anti-ban scheduler for agy. It is deliberately a rate limiter, not a
 * security sandbox:
 *
 * - one in-flight agy process globally per state path (cross-process file lock)
 * - one in-flight agy process per OpenCode instance (in-process FIFO mutex)
 * - a bounded local wait queue (rejects with AGY_GUARD_QUEUE_FULL when full)
 * - minimum spacing between starts (with jitter)
 * - sliding window cap
 * - persisted local-midnight daily cap
 * - circuit breaker on repeated errors or any explicit quota/429
 */
export class RequestGuard {
  constructor(config = {}, deps = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.mutex = new Mutex();
    this.statePath = this.config.statePath;
    this.lock = this.config.crossProcess
      ? new FileLock({
          lockPath: lockPathForStatePath(this.statePath),
          staleMs: this.config.lockStaleMs,
          pollMs: this.config.lockPollMs,
          heartbeatMs: this.config.lockHeartbeatMs,
        })
      : null;
    this.state = this.emptyState();
    this.ready = this.load().catch(() => {
      this.state = this.emptyState();
    });
  }

  emptyState() {
    return {
      date: localDate(new Date(this.now())),
      dailyCount: 0,
      breakerOpenUntil: 0,
      errorStreak: 0,
      halfOpenProbe: false,
      windowStarts: [],
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      const state = this.emptyState();

      if (typeof parsed.date === "string") state.date = parsed.date;
      if (Number.isFinite(parsed.dailyCount)) {
        state.dailyCount = Math.max(0, Math.trunc(parsed.dailyCount));
      }
      if (Number.isFinite(parsed.breakerOpenUntil)) {
        state.breakerOpenUntil = Math.max(0, parsed.breakerOpenUntil);
      }
      if (Number.isFinite(parsed.errorStreak)) {
        state.errorStreak = Math.max(0, Math.trunc(parsed.errorStreak));
      }
      state.halfOpenProbe = parsed.halfOpenProbe === true;
      if (Array.isArray(parsed.windowStarts)) {
        state.windowStarts = parsed.windowStarts
          .filter((value) => Number.isFinite(value))
          .slice(-Math.max(this.config.maxPerWindow, 1));
      }

      if (state.date !== localDate(new Date(this.now()))) {
        state.date = localDate(new Date(this.now()));
        state.dailyCount = 0;
      }
      state.windowStarts = state.windowStarts.filter(
        (startedAt) => startedAt > this.now() - this.config.windowMs,
      );
      this.state = state;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Keep the corrupt file for inspection instead of silently deleting it.
        try {
          await fs.rename(
            this.statePath,
            `${this.statePath}.corrupt-${Date.now()}`,
          );
        } catch {
          // Ignore: the in-memory state is still safe.
        }
      }
    }
  }

  async save() {
    const directory = path.dirname(this.statePath);
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        date: this.state.date,
        dailyCount: this.state.dailyCount,
        breakerOpenUntil: this.state.breakerOpenUntil,
        errorStreak: this.state.errorStreak,
        halfOpenProbe: this.state.halfOpenProbe,
        windowStarts: this.state.windowStarts,
      },
      null,
      2,
    );

    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporary, payload, "utf8");
      try {
        await fs.rename(temporary, this.statePath);
      } catch {
        await fs.rm(this.statePath, { force: true });
        await fs.rename(temporary, this.statePath);
      }
    } catch {
      // A read-only home directory must not stop the tool. The in-memory guard
      // still enforces every limit for this process.
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  rollDate() {
    const today = localDate(new Date(this.now()));
    if (this.state.date !== today) {
      this.state.date = today;
      this.state.dailyCount = 0;
    }
  }

  pruneWindow() {
    const cutoff = this.now() - this.config.windowMs;
    this.state.windowStarts = this.state.windowStarts.filter(
      (startedAt) => startedAt > cutoff,
    );
  }

  async admitOrThrow() {
    this.rollDate();
    const now = this.now();

    if (this.state.breakerOpenUntil > 0) {
      if (now < this.state.breakerOpenUntil) {
        throw new GuardError(
          "AGY_GUARD_BREAKER",
          `agy circuit breaker is open; retry in ${Math.ceil(
            (this.state.breakerOpenUntil - now) / 1_000,
          )}s`,
          { retryAfterMs: this.state.breakerOpenUntil - now },
        );
      }

      if (this.state.halfOpenProbe) {
        throw new GuardError(
          "AGY_GUARD_BREAKER",
          "agy circuit breaker half-open probe is already in progress",
          { retryAfterMs: 5_000 },
        );
      }

      // Cooldown elapsed: allow exactly one probe. A success closes the
      // breaker; any failure trips it again for another full cooldown.
      this.state.halfOpenProbe = true;
      this.state.breakerOpenUntil = 0;
      await this.save();
    }

    if (
      this.config.dailyCap > 0 &&
      this.state.dailyCount >= this.config.dailyCap
    ) {
      throw new GuardError(
        "AGY_GUARD_DAILY_CAP",
        `agy daily cap reached (${this.config.dailyCap}); resets at local midnight`,
      );
    }
  }

  async waitForWindow(signal) {
    if (!(this.config.maxPerWindow > 0)) return;

    while (true) {
      this.pruneWindow();
      if (this.state.windowStarts.length < this.config.maxPerWindow) return;
      const oldest = this.state.windowStarts[0];
      const wait = oldest + this.config.windowMs - this.now() + 10;
      await abortableSleep(Math.max(wait, 10), signal);
    }
  }

  async waitForPacing(signal) {
    if (!(this.config.minIntervalMs > 0)) return;
    const lastStart = this.state.windowStarts.at(-1) ?? 0;
    const jitter =
      this.config.jitterMs > 0
        ? Math.floor(this.random() * (this.config.jitterMs + 1))
        : 0;
    const wait = lastStart + this.config.minIntervalMs + jitter - this.now();
    if (wait > 0) await abortableSleep(wait, signal);
  }

  async recordStart() {
    this.rollDate();
    this.state.windowStarts.push(this.now());
    this.pruneWindow();
    this.state.dailyCount += 1;
    await this.save();
  }

  classifyFailure(error, signal) {
    if (
      signal?.aborted ||
      error?.name === "AbortError" ||
      error?.code === "AGY_ABORTED" ||
      error?.code === "AGY_GUARD_ABORTED"
    ) {
      return "aborted";
    }
    if (
      error?.kind === "rate-limit" ||
      error?.code === "AGY_RATE_LIMITED" ||
      isRateLimitText(error?.message)
    ) {
      return "rate-limit";
    }
    return "error";
  }

  async recordOutcome(outcome) {
    const wasHalfOpen = this.state.halfOpenProbe;
    const now = this.now();

    switch (outcome) {
      case "success":
        this.state.errorStreak = 0;
        this.state.breakerOpenUntil = 0;
        this.state.halfOpenProbe = false;
        break;
      case "aborted":
        this.state.halfOpenProbe = false;
        if (wasHalfOpen) {
          // The probe never produced a result; keep the breaker closed to new
          // traffic for another cooldown.
          this.state.breakerOpenUntil = now + this.config.breakerCooldownMs;
        }
        break;
      case "rate-limit":
        this.state.halfOpenProbe = false;
        this.state.errorStreak = 0;
        this.state.breakerOpenUntil = now + this.config.breakerCooldownMs;
        break;
      case "error":
      default:
        this.state.halfOpenProbe = false;
        this.state.errorStreak += 1;
        if (
          this.config.breakerThreshold > 0 &&
          this.state.errorStreak >= this.config.breakerThreshold
        ) {
          this.state.errorStreak = 0;
          this.state.breakerOpenUntil = now + this.config.breakerCooldownMs;
        }
        break;
    }

    await this.save();
  }

  /** Number of callers waiting on the in-process FIFO mutex. */
  activeQueueDepth() {
    return this.mutex.queue.filter((entry) => !entry.settled).length;
  }

  remainingQueueMs(deadline) {
    if (!(this.config.queueTimeoutMs > 0)) return 0;
    return Math.max(1, deadline - Date.now());
  }

  /**
   * Run one entire agy turn under the guard. Local waiters queue on the
   * in-process FIFO mutex; the winner then takes the cross-process file lock,
   * reloads the shared state and only then starts pacing. The lock is held for
   * the whole turn, so title/compaction/subagent calls from any OpenCode
   * process cannot stampede the account.
   */
  async run(signal, start) {
    if (signal?.aborted) throw abortError(signal);
    await this.ready;
    if (signal?.aborted) throw abortError(signal);

    if (!this.config.enabled) {
      return start();
    }

    if (
      this.config.maxQueueDepth > 0 &&
      this.activeQueueDepth() >= this.config.maxQueueDepth
    ) {
      throw new GuardError(
        "AGY_GUARD_QUEUE_FULL",
        `agy guard queue is full (${this.config.maxQueueDepth}); retry later`,
        { retryAfterMs: 5_000 },
      );
    }

    const deadline = Date.now() + Math.max(this.config.queueTimeoutMs, 0);
    const release = await this.mutex.acquire(
      signal,
      this.config.queueTimeoutMs,
    );
    let releaseLock = null;
    let admitted = false;

    try {
      if (this.lock) {
        releaseLock = await this.lock.acquire(
          signal,
          this.remainingQueueMs(deadline),
        );
      }

      // Reload while holding the global lock so the daily cap, the sliding
      // window and the breaker are shared across OpenCode processes.
      await this.load();
      await this.admitOrThrow();
      await this.waitForWindow(signal);
      await this.waitForPacing(signal);
      await this.recordStart();
      admitted = true;

      const result = await start();
      await this.recordOutcome("success");
      return result;
    } catch (error) {
      if (admitted) {
        await this.recordOutcome(this.classifyFailure(error, signal));
      } else if (this.state.halfOpenProbe) {
        this.state.halfOpenProbe = false;
        await this.save();
      }
      throw error;
    } finally {
      if (releaseLock) await releaseLock();
      release();
    }
  }

  snapshot() {
    this.pruneWindow();
    return {
      enabled: this.config.enabled,
      statePath: this.statePath,
      date: this.state.date,
      queueDepth: this.activeQueueDepth(),
      queueCap: this.config.maxQueueDepth,
      crossProcess: Boolean(this.lock),
      lockPath: this.lock?.lockPath,
      windowCount: this.state.windowStarts.length,
      windowCap: this.config.maxPerWindow,
      minIntervalMs: this.config.minIntervalMs,
      dailyCount: this.state.dailyCount,
      dailyCap: this.config.dailyCap,
      errorStreak: this.state.errorStreak,
      breakerOpenFor: Math.max(0, this.state.breakerOpenUntil - this.now()),
      halfOpenProbe: this.state.halfOpenProbe,
    };
  }

  async resetBreaker() {
    let releaseLock = null;
    try {
      if (this.lock) releaseLock = await this.lock.acquire(undefined, 5_000);
    } catch {
      // Best effort: another process may be mid-turn. Reset in memory anyway;
      // that turn's outcome will reconcile the shared file.
    }

    try {
      await this.load();
      this.state.breakerOpenUntil = 0;
      this.state.errorStreak = 0;
      this.state.halfOpenProbe = false;
      await this.save();
    } finally {
      if (releaseLock) await releaseLock();
    }
  }
}

export const globalGuard = new RequestGuard(guardConfigFromEnv());

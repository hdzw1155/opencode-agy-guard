import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GuardError,
  RequestGuard,
  isRateLimitText,
  localDate,
} from "../src/guard.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeGuard(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-guard-test-"));
  return new RequestGuard({
    statePath: path.join(directory, "state.json"),
    minIntervalMs: 0,
    jitterMs: 0,
    windowMs: 60_000,
    maxPerWindow: 100,
    breakerThreshold: 0,
    breakerCooldownMs: 120,
    dailyCap: 100,
    queueTimeoutMs: 5_000,
    ...overrides,
  });
}

test("serializes concurrent turns and preserves FIFO order", async () => {
  const guard = await makeGuard();
  let running = 0;
  let maxRunning = 0;
  const starts = [];

  const run = (value) =>
    guard.run(undefined, async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      starts.push(value);
      await sleep(40);
      running -= 1;
      return value;
    });

  const results = await Promise.all([run(1), run(2), run(3)]);

  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(starts, [1, 2, 3]);
  assert.equal(maxRunning, 1);
});

test("enforces minimum spacing between starts", async () => {
  const guard = await makeGuard({ minIntervalMs: 80 });
  const starts = [];

  await guard.run(undefined, async () => {
    starts.push(Date.now());
  });
  await guard.run(undefined, async () => {
    starts.push(Date.now());
  });

  assert.equal(starts.length, 2);
  assert.ok(
    starts[1] - starts[0] >= 65,
    `expected >=65ms spacing, got ${starts[1] - starts[0]}ms`,
  );
});

test("enforces the sliding window", async () => {
  const guard = await makeGuard({
    minIntervalMs: 0,
    windowMs: 250,
    maxPerWindow: 2,
    dailyCap: 100,
  });
  const starts = [];

  await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      guard.run(undefined, async () => {
        starts.push(Date.now());
        return index;
      }),
    ),
  );

  assert.equal(starts.length, 3);
  assert.ok(
    starts[2] - starts[0] >= 200,
    `third start should wait for the window, got ${starts[2] - starts[0]}ms`,
  );
});

test("enforces the daily cap", async () => {
  const guard = await makeGuard({ dailyCap: 1 });

  await guard.run(undefined, async () => "first");

  await assert.rejects(
    () => guard.run(undefined, async () => "second"),
    (error) =>
      error instanceof GuardError && error.code === "AGY_GUARD_DAILY_CAP",
  );
});

test("opens the breaker after repeated errors and recovers with a half-open probe", async () => {
  const guard = await makeGuard({
    breakerThreshold: 2,
    breakerCooldownMs: 120,
  });

  const fail = () => guard.run(undefined, async () => {
    throw new Error("ordinary failure");
  });

  await assert.rejects(fail, /ordinary failure/);
  await assert.rejects(fail, /ordinary failure/);

  await assert.rejects(
    () => guard.run(undefined, async () => "blocked"),
    (error) =>
      error instanceof GuardError && error.code === "AGY_GUARD_BREAKER",
  );

  await sleep(140);

  const result = await guard.run(undefined, async () => "probe ok");
  assert.equal(result, "probe ok");

  const snapshot = guard.snapshot();
  assert.equal(snapshot.breakerOpenFor, 0);
  assert.equal(snapshot.halfOpenProbe, false);
});

test("a rate-limit failure trips the breaker immediately", async () => {
  const guard = await makeGuard({ breakerThreshold: 99 });

  await assert.rejects(
    () =>
      guard.run(undefined, async () => {
        const error = new Error("429 quota exceeded");
        error.code = "AGY_RATE_LIMITED";
        error.kind = "rate-limit";
        throw error;
      }),
    /429 quota exceeded/,
  );

  await assert.rejects(
    () => guard.run(undefined, async () => "blocked"),
    (error) =>
      error instanceof GuardError && error.code === "AGY_GUARD_BREAKER",
  );
});

test("aborting a queued request rejects it without running", async () => {
  const guard = await makeGuard();
  let releaseFirst;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const first = guard.run(
    undefined,
    () =>
      new Promise((resolve) => {
        releaseFirst = resolve;
        started();
      }),
  );

  await startedPromise;
  const controller = new AbortController();
  const second = guard.run(controller.signal, async () => "should not run");
  controller.abort();

  await assert.rejects(second, (error) => error.name === "AbortError");
  releaseFirst("first");
  assert.equal(await first, "first");
});

test("persists the daily count across guard instances", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-guard-state-"));
  const statePath = path.join(directory, "state.json");
  const config = {
    statePath,
    minIntervalMs: 0,
    jitterMs: 0,
    dailyCap: 2,
    breakerThreshold: 0,
  };

  const first = new RequestGuard(config);
  await first.run(undefined, async () => "one");

  const second = new RequestGuard(config);
  await second.run(undefined, async () => "two");
  await assert.rejects(
    () => second.run(undefined, async () => "three"),
    (error) =>
      error instanceof GuardError && error.code === "AGY_GUARD_DAILY_CAP",
  );

  const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(saved.dailyCount, 2);
  assert.equal(saved.date, localDate());
});

test("rate-limit text detection is case-insensitive", () => {
  assert.equal(isRateLimitText("429 Too Many Requests"), true);
  assert.equal(isRateLimitText("RESOURCE_EXHAUSTED"), true);
  assert.equal(isRateLimitText("ordinary failure"), false);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RequestGuard } from "../src/guard.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agy-guard-xproc-"));
}

function baseConfig(statePath, overrides = {}) {
  return {
    statePath,
    minIntervalMs: 0,
    jitterMs: 0,
    windowMs: 60_000,
    maxPerWindow: 100,
    breakerThreshold: 0,
    breakerCooldownMs: 120,
    dailyCap: 100,
    queueTimeoutMs: 5_000,
    lockStaleMs: 5_000,
    lockPollMs: 5,
    lockHeartbeatMs: 1_000,
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("waitFor timed out");
}

test("rejects new turns when the local wait queue is full", async () => {
  const directory = await makeStateDir();
  const guard = new RequestGuard(
    baseConfig(path.join(directory, "state.json"), { maxQueueDepth: 1 }),
  );

  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = guard.run(undefined, () => firstGate);
  const second = guard.run(undefined, async () => "second");
  await waitFor(() => guard.activeQueueDepth() === 1);

  await assert.rejects(
    guard.run(undefined, async () => "third"),
    (error) => error.code === "AGY_GUARD_QUEUE_FULL",
  );

  releaseFirst("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});

test("shares the daily count across guard instances with the same state file", async () => {
  const directory = await makeStateDir();
  const statePath = path.join(directory, "state.json");
  const config = baseConfig(statePath, { dailyCap: 1 });
  const first = new RequestGuard(config);
  const second = new RequestGuard(config);

  assert.equal(await first.run(undefined, async () => "one"), "one");
  assert.equal(first.snapshot().dailyCount, 1);

  await assert.rejects(
    second.run(undefined, async () => "two"),
    (error) => error.code === "AGY_GUARD_DAILY_CAP",
  );
});

test("two guard instances never run agy at the same time", async () => {
  const directory = await makeStateDir();
  const statePath = path.join(directory, "state.json");
  const config = baseConfig(statePath, { maxQueueDepth: 10 });
  const first = new RequestGuard(config);
  const second = new RequestGuard(config);

  let running = 0;
  let maxRunning = 0;
  const start = (value) => async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await sleep(30);
    running -= 1;
    return value;
  };

  const results = await Promise.all([
    first.run(undefined, start("a")),
    second.run(undefined, start("b")),
    first.run(undefined, start("c")),
  ]);

  assert.equal(maxRunning, 1);
  assert.deepEqual([...results].sort(), ["a", "b", "c"]);
});

test("snapshot exposes the cross-process queue settings", async () => {
  const directory = await makeStateDir();
  const statePath = path.join(directory, "state.json");
  const guard = new RequestGuard(baseConfig(statePath));
  const snapshot = guard.snapshot();

  assert.equal(snapshot.crossProcess, true);
  assert.equal(snapshot.queueCap, 4);
  assert.equal(snapshot.lockPath, `${statePath}.lock`);
});

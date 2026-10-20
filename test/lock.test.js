import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileLock, lockPathForStatePath } from "../src/lock.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeLock(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-lock-"));
  const lockPath = path.join(directory, "state.json.lock");
  return new FileLock({
    lockPath,
    staleMs: 10_000,
    pollMs: 5,
    heartbeatMs: 1_000,
    ...overrides,
  });
}

test("lockPathForStatePath derives the lock directory from the state file", () => {
  assert.equal(
    lockPathForStatePath(path.join("C:", "data", "state.json")),
    path.join("C:", "data", "state.json.lock"),
  );
});

test("serializes holders and releases the lock directory", async () => {
  const first = await makeLock();
  const second = await makeLock({ lockPath: first.lockPath });
  const releaseFirst = await first.acquire();

  let secondAcquired = false;
  const secondPending = second.acquire(undefined, 2_000).then((release) => {
    secondAcquired = true;
    return release;
  });

  await sleep(40);
  assert.equal(secondAcquired, false);

  await releaseFirst();
  const releaseSecond = await secondPending;
  assert.equal(secondAcquired, true);

  await releaseSecond();
  await assert.rejects(
    fs.stat(first.lockPath),
    (error) => error.code === "ENOENT",
  );
});

test("takes over a lock whose heartbeat is stale", async () => {
  const lock = await makeLock({ staleMs: 50 });
  await fs.mkdir(lock.lockPath, { recursive: true });
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(lock.lockPath, old, old);

  const release = await lock.acquire(undefined, 2_000);
  assert.equal(typeof release, "function");
  await release();
});

test("times out while another process holds the lock", async () => {
  const first = await makeLock();
  const second = await makeLock({ lockPath: first.lockPath });
  const releaseFirst = await first.acquire();

  await assert.rejects(
    second.acquire(undefined, 80),
    (error) => error.code === "AGY_GUARD_QUEUE_TIMEOUT",
  );

  await releaseFirst();
});

test("rejects with an AbortError when the signal aborts while waiting", async () => {
  const first = await makeLock();
  const second = await makeLock({ lockPath: first.lockPath });
  const releaseFirst = await first.acquire();
  const controller = new AbortController();

  const pending = second.acquire(controller.signal, 5_000);
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(pending, (error) => error.name === "AbortError");
  await releaseFirst();
});

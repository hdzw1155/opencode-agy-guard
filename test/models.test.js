import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  DEFAULT_MODEL_ID,
  FALLBACK_AGY_MODELS,
  buildCatalog,
  discoverAgyModels,
  getCatalog,
  getCatalogSource,
  listTierKeys,
  parseAgyModels,
  refreshModels,
  resetModelCache,
} from "../src/models.js";

test.beforeEach(() => {
  resetModelCache();
});

test("parseAgyModels accepts tabs, spaces, ANSI, and drops duplicates", () => {
  const models = parseAgyModels(
    [
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "\u001b[32mgemini-3.8-flash-high\u001b[0m  Gemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "not a model line",
      "",
    ].join("\n"),
  );

  assert.deepEqual(models, [
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  ]);
});

test("buildCatalog maps ids, display names, and friendly aliases", () => {
  const catalog = buildCatalog([
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  ]);

  assert.equal(catalog.defaultModel, DEFAULT_MODEL_ID);
  assert.equal(catalog.byKey.get("flash-3.8-med").id, DEFAULT_MODEL_ID);
  assert.equal(catalog.byKey.get("flash-3.8").id, DEFAULT_MODEL_ID);
  assert.equal(catalog.byKey.get("Gemini 3.8 Flash (Medium)").id, DEFAULT_MODEL_ID);
  assert.equal(catalog.byKey.get("sonnet-4.6").id, "claude-sonnet-4-6");
  assert.equal(catalog.byKey.get("gemini-3.8-flash-none"), undefined);
});

test("listTierKeys includes aliases and exact ids without duplicates", () => {
  const keys = listTierKeys(buildCatalog(FALLBACK_AGY_MODELS));

  assert.ok(keys.includes("flash-3.8-med"));
  assert.ok(keys.includes("gemini-3.8-flash-medium"));
  assert.equal(new Set(keys).size, keys.length);
});

function fakeModelsChild(stdout, { exitCode = 1 } = {}) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stderr.push(null);
  child.kill = () => child.emit("close", exitCode, null);
  setImmediate(() => {
    child.stdout.push(stdout);
    child.stdout.push(null);
    child.emit("close", exitCode, null);
  });
  return child;
}

test("discoverAgyModels parses stdout even when agy models exits 1", async () => {
  const child = fakeModelsChild(
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n",
  );

  const models = await discoverAgyModels({
    spawnFn: () => child,
  });

  assert.deepEqual(models, [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  ]);
});

test("discoverAgyModels returns an empty list when the spawn throws", async () => {
  const models = await discoverAgyModels({
    spawnFn: () => {
      throw new Error("agy missing");
    },
  });

  assert.deepEqual(models, []);
});

test("refreshModels caches the discovered catalog and shares inflight work", async () => {
  let spawnCount = 0;
  const options = {
    spawnFn: () => {
      spawnCount += 1;
      return fakeModelsChild(
        "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n",
      );
    },
  };

  const first = refreshModels(options);
  const second = refreshModels(options);
  const [a, b] = await Promise.all([first, second]);

  assert.equal(spawnCount, 1);
  assert.equal(a, b);
  assert.equal(getCatalogSource(), "agy");
  assert.equal(a.byKey.get("opus-4.6-thinking").id, "claude-opus-4-6-thinking");
  assert.equal(getCatalog().byKey.get("claude-opus-4-6-thinking").name, "Claude Opus 4.6 (Thinking)");
});

test("refreshModels keeps the fallback catalog when discovery fails", async () => {
  const catalog = await refreshModels({
    spawnFn: () => {
      throw new Error("agy missing");
    },
  });

  assert.equal(getCatalogSource(), "fallback");
  assert.equal(catalog.byKey.get("flash-3.8-med").id, DEFAULT_MODEL_ID);
});

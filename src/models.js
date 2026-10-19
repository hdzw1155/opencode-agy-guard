import { spawn } from "node:child_process";

import { buildEnv } from "./env.js";

/**
 * Model discovery for `agy models`.
 *
 * `agy models` prints `<id>\t<display name>` lines and often exits with code
 * 1 even on success, so the parser must not depend on the exit code. The
 * catalog is refreshed in the background and cached; when discovery fails the
 * known-good fallback list keeps the tool usable offline.
 */

export const FALLBACK_AGY_MODELS = Object.freeze([
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
]);

export const DEFAULT_MODEL_ID = "gemini-3.8-flash-medium";
export const DEFAULT_TIER = "flash-3.8-med";

/** Friendly aliases kept for continuity with the first release. */
export const FRIENDLY_ALIASES = Object.freeze({
  "flash-3.8": "gemini-3.8-flash-medium",
  "flash-3.8-hi": "gemini-3.8-flash-high",
  "flash-3.8-med": "gemini-3.8-flash-medium",
  "flash-3.8-lo": "gemini-3.8-flash-low",
  "sonnet-4.6": "claude-sonnet-4-6",
  "opus-4.6-thinking": "claude-opus-4-6-thinking",
  "gpt-oss-120b": "gpt-oss-120b-medium",
});

/**
 * Parse stdout from `agy models`.
 * Accepts tab-separated lines and tolerates a couple of spaces instead.
 */
export function parseAgyModels(stdout) {
  const models = [];
  const seen = new Set();

  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!line) continue;

    const tab = line.indexOf("\t");
    let id;
    let name;
    if (tab >= 0) {
      id = line.slice(0, tab).trim();
      name = line.slice(tab + 1).trim();
    } else {
      const match = line.match(/^(\S+)\s{2,}(.+)$/);
      if (!match) continue;
      id = match[1].trim();
      name = match[2].trim();
    }

    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }

  return models;
}

/**
 * Build a lookup catalog from discovered models.
 * Keys include the agy model id, the display name, and the friendly aliases.
 */
export function buildCatalog(models = FALLBACK_AGY_MODELS) {
  const list = (Array.isArray(models) && models.length
    ? models
    : FALLBACK_AGY_MODELS
  ).map((model) => ({ id: String(model.id), name: String(model.name) }));

  const byKey = new Map();
  for (const model of list) {
    byKey.set(model.id, model);
    byKey.set(model.name, model);
  }
  for (const [alias, targetId] of Object.entries(FRIENDLY_ALIASES)) {
    const target = byKey.get(targetId);
    if (target) byKey.set(alias, target);
  }

  const defaultEntry =
    byKey.get(DEFAULT_MODEL_ID) ?? byKey.get(FALLBACK_AGY_MODELS[0].id) ?? list[0];

  return {
    models: list,
    byKey,
    defaultModel: defaultEntry.id,
    defaultKey: byKey.get(DEFAULT_TIER) ? DEFAULT_TIER : defaultEntry.id,
  };
}

/** Short list for tool descriptions and error messages. */
export function listTierKeys(catalog) {
  const keys = Object.keys(FRIENDLY_ALIASES).filter((key) => catalog.byKey.has(key));
  const ids = catalog.models.map((model) => model.id);
  return [...new Set([...keys, ...ids])];
}

let cache = {
  catalog: buildCatalog(FALLBACK_AGY_MODELS),
  source: "fallback",
  successAt: 0,
  attemptAt: 0,
};

let inflight = null;

export function getCatalog() {
  return cache.catalog;
}

export function getCatalogSource() {
  return cache.source;
}

export function resetModelCache() {
  cache = {
    catalog: buildCatalog(FALLBACK_AGY_MODELS),
    source: "fallback",
    successAt: 0,
    attemptAt: 0,
  };
  inflight = null;
}

/**
 * Run `agy models` and return parsed entries. Never throws: discovery is a
 * best-effort feature and the caller keeps the previous catalog on failure.
 */
export async function discoverAgyModels(options = {}) {
  const agyPath = options.agyPath || "agy";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const spawnFn = options.spawnFn ?? spawn;
  const env = options.env ?? buildEnv();

  let child;
  try {
    child = spawnFn(agyPath, ["models"], {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }

  return await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timer;

    const finish = (models) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(models);
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore: the process may already be gone.
      }
      finish([]);
    }, timeoutMs);

    child.on("error", () => finish([]));

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(-200_000);
      });
    }

    child.on("close", () => finish(parseAgyModels(stdout)));
  });
}

/**
 * Refresh the catalog if it is stale. Concurrent callers share one refresh.
 * - success: cache for ttlMs (default 30 minutes)
 * - failure: retry after retryMs (default 5 minutes), keep the old catalog
 */
export async function refreshModels(options = {}) {
  if (inflight) return inflight;

  const ttlMs = options.ttlMs ?? 30 * 60_000;
  const retryMs = options.retryMs ?? 5 * 60_000;
  const now = Date.now();

  if (!options.force && cache.successAt && now - cache.successAt < ttlMs) {
    return cache.catalog;
  }
  if (!options.force && cache.attemptAt && now - cache.attemptAt < retryMs) {
    return cache.catalog;
  }

  inflight = (async () => {
    cache.attemptAt = Date.now();
    const found = await discoverAgyModels(options);
    if (found.length) {
      cache.catalog = buildCatalog(found);
      cache.source = "agy";
      cache.successAt = Date.now();
    }
    return cache.catalog;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

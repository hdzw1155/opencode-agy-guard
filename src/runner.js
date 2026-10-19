import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { buildEnv } from "./env.js";
import { getCatalog } from "./models.js";
import { globalGuard } from "./guard.js";

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_OUTPUT_CHARS = 100_000;

export class AgyError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = options.name ?? "AgyError";
    this.code = code;
    this.kind = options.kind ?? "error";
    this.retryAfterMs = options.retryAfterMs ?? 0;
    this.details = options.details;
  }
}

export function resolveModel({ tier, model } = {}, catalog = getCatalog()) {
  if (model) return String(model);
  if (tier) {
    const entry = catalog.byKey.get(String(tier));
    if (!entry) {
      const keys = [...catalog.byKey.keys()].join(", ");
      throw new AgyError(
        "AGY_BAD_REQUEST",
        `Unknown agy tier "${tier}". Known keys: ${keys}`,
      );
    }
    return entry.id;
  }
  return catalog.defaultModel;
}

export function parseTimeout(value) {
  if (value == null || value === "") return DEFAULT_TIMEOUT_MS;
  if (typeof value === "number") {
    return validateTimeout(value);
  }

  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    throw new AgyError(
      "AGY_BAD_REQUEST",
      `Invalid timeout "${value}". Use e.g. 90000, 90s, 15m, or 900000ms.`,
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier =
    unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return validateTimeout(amount * multiplier);
}

function validateTimeout(ms) {
  if (!Number.isFinite(ms) || ms < 1_000 || ms > MAX_TIMEOUT_MS) {
    throw new AgyError(
      "AGY_BAD_REQUEST",
      `Timeout must be between 1000ms and ${MAX_TIMEOUT_MS}ms (4h).`,
    );
  }
  return Math.trunc(ms);
}

/**
 * Build the same headless stream-json invocation used by dsh-agy-safe.
 * The caller must close stdin after writing one user event.
 */
export function buildAgyArgs(options = {}) {
  const timeoutMs = options.timeoutMs ?? parseTimeout(options.timeout);
  const model = resolveModel(options, options.catalog ?? getCatalog());
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];

  if (options.yolo !== false) {
    args.push("--dangerously-skip-permissions");
  }
  args.push("--print-timeout", `${timeoutMs}ms`, "--model", model);

  if (options.sandbox) args.push("--sandbox");
  if (options.project) args.push("--project", String(options.project));
  if (options["continue"]) args.push("--continue");
  if (options.conversation) {
    if (options["continue"]) {
      throw new AgyError(
        "AGY_BAD_REQUEST",
        "Use either continue or conversation, not both.",
      );
    }
    args.push("--conversation", String(options.conversation));
  }

  return args;
}

/**
 * Parse one NDJSON line from `agy --output-format stream-json`.
 * The same parser is exported for unit tests.
 */
export function parseAgyLine(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    state.malformedLines.push(line);
    return state;
  }

  state.eventCount += 1;

  if (event.event === "init") {
    state.conversationId =
      state.conversationId ??
      event.conversation_id ??
      event.init?.conversation_id;
    state.init = event.init;
    return state;
  }

  if (event.event === "step_update") {
    const update = event.step_update;
    if (!update) return state;

    state.conversationId =
      state.conversationId ?? update.conversation_id;

    if (update.step_type === "agent_response") {
      if (typeof update.text_delta === "string") {
        state.text += update.text_delta;
      }
      if (update.state === "DONE") {
        state.finalStep = update;
        if (update.usage) state.usage = update.usage;
      }
    }
    return state;
  }

  if (event.event === "result") {
    const result = event.result;
    if (!result) return state;

    state.result = result;
    state.status = result.status;
    state.conversationId =
      state.conversationId ?? result.conversation_id;
    if (typeof result.response === "string") {
      state.finalText = result.response;
    }
    if (result.usage) state.usage = result.usage;
    if (result.error) state.error = String(result.error);
  }

  return state;
}

export function createAgyState() {
  return {
    conversationId: undefined,
    init: undefined,
    text: "",
    finalText: undefined,
    finalStep: undefined,
    result: undefined,
    status: undefined,
    usage: undefined,
    error: undefined,
    eventCount: 0,
    malformedLines: [],
  };
}

export function parseAgyOutput(stdout) {
  const state = createAgyState();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (line.trim()) parseAgyLine(line, state);
  }
  return state;
}

export function classifyAgyFailure(message) {
  const text = String(message ?? "");

  if (
    /(429|resource_exhausted|quota|rate.?limit|too many requests|overloaded)/i.test(
      text,
    )
  ) {
    return {
      code: "AGY_RATE_LIMITED",
      kind: "rate-limit",
      retryAfterMs: 60_000,
    };
  }
  if (
    /(not available in your (country|region)|unsupported (country|region)|geo.?block|region.*not.*available)/i.test(
      text,
    )
  ) {
    return { code: "AGY_GEO_BLOCKED", kind: "geo" };
  }
  if (/(401|403|unauthor|login|sign in|authenticate|auth required)/i.test(text)) {
    return { code: "AGY_AUTH_REQUIRED", kind: "auth" };
  }
  if (
    /(model.*(not found|unavailable|unknown|invalid)|invalid model|no such model)/i.test(
      text,
    )
  ) {
    return { code: "AGY_MODEL_UNAVAILABLE", kind: "model" };
  }
  if (/(timed?\s?out|timeout)/i.test(text)) {
    return { code: "AGY_TIMEOUT", kind: "timeout" };
  }
  return { code: "AGY_UPSTREAM_ERROR", kind: "error" };
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new AgyError("AGY_ABORTED", "agy request aborted", {
    name: "AbortError",
    kind: "aborted",
  });
}

function killTree(child) {
  if (!child || child.killed) return;

  if (process.platform === "win32" && child.pid) {
    const killer = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.on("error", () => {
      try {
        child.kill();
      } catch {
        // Ignore: the process may already be gone.
      }
    });
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore: the process may already be gone.
  }
}

/**
 * Run one agy turn WITHOUT the guard. Exported so tests can exercise the
 * process/parser layer directly.
 */
export async function runAgyUnlocked(options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);

  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) {
    throw new AgyError("AGY_BAD_REQUEST", "prompt must not be empty");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new AgyError(
      "AGY_BAD_REQUEST",
      `prompt is too long (${prompt.length} > ${MAX_PROMPT_CHARS} characters)`,
    );
  }

  const cwd = path.resolve(options.dir || process.cwd());
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) {
      throw new AgyError("AGY_BAD_DIR", `Not a directory: ${cwd}`);
    }
  } catch (error) {
    if (error instanceof AgyError) throw error;
    throw new AgyError("AGY_BAD_DIR", `Working directory not found: ${cwd}`, {
      cause: error,
    });
  }

  if (signal?.aborted) throw abortError(signal);

  const timeoutMs = parseTimeout(options.timeout);
  const model = resolveModel(options);
  const args = buildAgyArgs({ ...options, timeoutMs, model });
  const agyPath = options.agyPath || process.env.AGY_PATH || "agy";
  const spawnFn = options.spawnFn ?? spawn;
  const startedAt = Date.now();
  const state = createAgyState();
  let stderr = "";
  let stdoutBuffer = "";
  let child;

  try {
    child = spawnFn(agyPath, args, {
      cwd,
      env: buildEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new AgyError("AGY_SPAWN_FAILED", `Failed to start agy: ${error.message}`, {
      cause: error,
    });
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let killTimer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };

    const onAbort = () => {
      killTree(child);
      finish(abortError(signal));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    // agy has its own --print-timeout. This is a safety net in case the child
    // hangs while shutting down.
    killTimer = setTimeout(() => {
      killTree(child);
      finish(
        new AgyError(
          "AGY_TIMEOUT",
          `agy did not finish within ${timeoutMs + 15_000}ms`,
          { kind: "timeout", retryAfterMs: 0 },
        ),
      );
    }, timeoutMs + 15_000);

    child.on("error", (error) => {
      finish(
        new AgyError("AGY_SPAWN_FAILED", `Failed to start agy: ${error.message}`, {
          cause: error,
          kind: "spawn",
        }),
      );
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) parseAgyLine(line, state);
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16_384);
    });

    child.stdin.on("error", () => {
      // EPIPE is normal when agy exits early (auth error, bad model, etc.).
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;

      if (stdoutBuffer.trim()) {
        parseAgyLine(stdoutBuffer.trim(), state);
        stdoutBuffer = "";
      }

      const rawText = state.finalText ?? state.text ?? "";
      const truncated = rawText.length > MAX_OUTPUT_CHARS;
      const text = truncated ? rawText.slice(0, MAX_OUTPUT_CHARS) : rawText;

      if (state.status && String(state.status).toUpperCase() !== "SUCCESS") {
        const failure = classifyAgyFailure(
          [state.error, stderr, state.status].filter(Boolean).join("\n"),
        );
        finish(
          new AgyError(
            failure.code,
            state.error || `agy returned status ${state.status}`,
            {
              ...failure,
              details: { code, closeSignal, stderr: stderr.slice(0, 4_000) },
            },
          ),
        );
        return;
      }

      if (code !== 0) {
        const failure = classifyAgyFailure(stderr);
        finish(
          new AgyError(
            failure.code,
            `agy exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
            {
              ...failure,
              details: { code, closeSignal, stderr: stderr.slice(0, 4_000) },
            },
          ),
        );
        return;
      }

      if (!text.trim()) {
        finish(
          new AgyError("AGY_EMPTY", "agy returned no text", {
            details: {
              code,
              closeSignal,
              stderr: stderr.slice(0, 4_000),
              eventCount: state.eventCount,
              malformedLines: state.malformedLines.slice(0, 5),
              cwd,
            },
          }),
        );
        return;
      }

      finish(null, {
        text,
        truncated,
        conversationId: state.conversationId,
        status: state.status ?? "SUCCESS",
        usage: state.usage,
        durationMs: Date.now() - startedAt,
        model,
        stderr: stderr.slice(0, 4_000),
        eventCount: state.eventCount,
        malformedLines: state.malformedLines.slice(0, 5),
      });
    });

    try {
      child.stdin.write(
        `${JSON.stringify({
          event: "user",
          message: { content: prompt },
        })}\n`,
      );
      child.stdin.end();
    } catch (error) {
      killTree(child);
      finish(
        new AgyError("AGY_SPAWN_FAILED", `Failed to send prompt to agy: ${error.message}`, {
          cause: error,
        }),
      );
    }
  });
}

/**
 * Errors that are worth one more guarded attempt. Mirrors the dsh retry policy:
 * only transport/timeout failures retry; rate limits, geo blocks, auth errors,
 * model errors, and empty responses surface immediately.
 */
export function isRetryableAgyError(error) {
  return (
    error?.kind === "timeout" ||
    error?.kind === "spawn" ||
    error?.code === "AGY_TIMEOUT" ||
    error?.code === "AGY_SPAWN_FAILED"
  );
}

function retryAttemptsFromEnv() {
  const parsed = Number(process.env.AGY_RETRY_ATTEMPTS);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.min(Math.trunc(parsed), 3);
}

/**
 * Run one agy turn under the global anti-ban guard.
 * Transport/timeout failures get one more attempt by default; each attempt
 * goes through the guard again, so retries are paced and counted like normal
 * calls. Set `retryAttempts: 0` or `AGY_RETRY_ATTEMPTS=0` to disable.
 */
export async function runAgy(options = {}, guard = globalGuard) {
  const maxRetries =
    options.retryAttempts ?? retryAttemptsFromEnv();
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await guard.run(options.signal, () =>
        runAgyUnlocked({ ...options, attempt }),
      );
    } catch (error) {
      lastError = error;
      if (
        attempt >= maxRetries ||
        options.signal?.aborted ||
        !isRetryableAgyError(error)
      ) {
        throw error;
      }
    }
  }

  throw lastError;
}

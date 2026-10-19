import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import {
  AgyError,
  buildAgyArgs,
  classifyAgyFailure,
  isRetryableAgyError,
  parseAgyOutput,
  parseTimeout,
  resolveModel,
  runAgy,
  runAgyUnlocked,
} from "../src/runner.js";
import { buildCatalog } from "../src/models.js";

function ndjson(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const SUCCESS_OUTPUT = ndjson([
  {
    event: "init",
    conversation_id: "conv-test",
    init: { model: "Gemini 3.8 Flash (Medium)", cwd: os.tmpdir() },
  },
  {
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      state: "ACTIVE",
      text_delta: "OK",
    },
  },
  {
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      state: "DONE",
      text_delta: "\n",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  },
  {
    event: "result",
    result: {
      status: "SUCCESS",
      response: "OK\n",
      conversation_id: "conv-test",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  },
]);

function makeFakeChild(output, { exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.killed = false;
  child.prompt = "";
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stderr.push(null);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.prompt += chunk.toString();
      callback();
    },
  });
  child.kill = () => {
    child.killed = true;
  };
  child.stdin.on("finish", () => {
    setImmediate(() => {
      child.stdout.push(output);
      child.stdout.push(null);
      setImmediate(() => child.emit("close", exitCode, null));
    });
  });
  return child;
}

test("buildAgyArgs uses the dsh stream-json shape", () => {
  const args = buildAgyArgs({
    model: "Gemini 3.8 Flash (Medium)",
    timeout: "90s",
  });

  assert.deepEqual(args, [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "90000ms",
    "--model",
    "Gemini 3.8 Flash (Medium)",
  ]);
});

test("buildAgyArgs supports optional flags", () => {
  const args = buildAgyArgs({
    model: "Claude Sonnet 4.6 (Thinking)",
    timeout: "5m",
    yolo: false,
    sandbox: true,
    project: "demo",
    conversation: "conv-1",
  });

  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--project"));
  assert.equal(args[args.indexOf("--project") + 1], "demo");
  assert.ok(args.includes("--conversation"));
  assert.equal(args[args.indexOf("--conversation") + 1], "conv-1");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("resolveModel and parseTimeout validate input", () => {
  const catalog = buildCatalog();
  assert.equal(
    resolveModel({ tier: "flash-3.8-hi" }, catalog),
    "gemini-3.8-flash-high",
  );
  assert.equal(resolveModel({ model: "exact-model" }, catalog), "exact-model");
  assert.equal(resolveModel({ tier: "gemini-3.8-flash-low" }, catalog), "gemini-3.8-flash-low");
  assert.throws(
    () => resolveModel({ tier: "does-not-exist" }, catalog),
    (error) => error instanceof AgyError && error.code === "AGY_BAD_REQUEST",
  );
  assert.equal(parseTimeout("15m"), 900_000);
  assert.equal(parseTimeout("900000"), 900_000);
  assert.throws(() => parseTimeout("0"), /Timeout must be between/);
  assert.throws(() => parseTimeout("5h"), /Timeout must be between/);
});

test("parseAgyOutput extracts text, usage, and conversation id", () => {
  const state = parseAgyOutput(SUCCESS_OUTPUT);

  assert.equal(state.conversationId, "conv-test");
  assert.equal(state.status, "SUCCESS");
  assert.equal(state.text, "OK\n");
  assert.equal(state.finalText, "OK\n");
  assert.equal(state.usage.total_tokens, 12);
  assert.equal(state.eventCount, 4);
});

test("classifyAgyFailure maps the important upstream errors", () => {
  assert.equal(classifyAgyFailure("429 quota exceeded").code, "AGY_RATE_LIMITED");
  assert.equal(
    classifyAgyFailure("not available in your country").code,
    "AGY_GEO_BLOCKED",
  );
  assert.equal(classifyAgyFailure("401 unauthorized").code, "AGY_AUTH_REQUIRED");
  assert.equal(classifyAgyFailure("model not found").code, "AGY_MODEL_UNAVAILABLE");
  assert.equal(classifyAgyFailure("operation timed out").code, "AGY_TIMEOUT");
  assert.equal(classifyAgyFailure("something else").code, "AGY_UPSTREAM_ERROR");
});

test("runAgyUnlocked sends one user event and parses a successful result", async () => {
  const child = makeFakeChild(SUCCESS_OUTPUT);
  let spawnedArgs;

  const result = await runAgyUnlocked({
    prompt: "Reply with OK",
    model: "Gemini 3.8 Flash (Medium)",
    timeout: "5s",
    dir: os.tmpdir(),
    spawnFn: (_command, args) => {
      spawnedArgs = args;
      return child;
    },
  });

  assert.equal(result.text, "OK\n");
  assert.equal(result.conversationId, "conv-test");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.usage.total_tokens, 12);
  assert.ok(spawnedArgs.includes("--input-format"));
  assert.ok(spawnedArgs.includes("--dangerously-skip-permissions"));

  const sent = JSON.parse(child.prompt.trim());
  assert.equal(sent.event, "user");
  assert.equal(sent.message.content, "Reply with OK");
});

test("runAgyUnlocked maps an upstream ERROR result to AGY_RATE_LIMITED", async () => {
  const output = ndjson([
    { event: "init", conversation_id: "conv-error" },
    {
      event: "result",
      result: {
        status: "ERROR",
        error: "429 quota exceeded",
        conversation_id: "conv-error",
      },
    },
  ]);
  const child = makeFakeChild(output);

  await assert.rejects(
    () =>
      runAgyUnlocked({
        prompt: "test",
        model: "Gemini 3.8 Flash (Medium)",
        timeout: "5s",
        dir: os.tmpdir(),
        spawnFn: () => child,
      }),
    (error) =>
      error instanceof AgyError &&
      error.code === "AGY_RATE_LIMITED" &&
      error.kind === "rate-limit",
  );
});

test("runAgyUnlocked abort kills the child and rejects with AbortError", async () => {
  const child = makeFakeChild(SUCCESS_OUTPUT);
  const controller = new AbortController();
  let spawned;
  const spawnedPromise = new Promise((resolve) => {
    spawned = resolve;
  });

  const promise = runAgyUnlocked({
    prompt: "test",
    model: "Gemini 3.8 Flash (Medium)",
    timeout: "5s",
    dir: os.tmpdir(),
    signal: controller.signal,
    spawnFn: () => {
      spawned();
      return child;
    },
  });

  await spawnedPromise;
  controller.abort();

  await assert.rejects(promise, (error) => error.name === "AbortError");
  assert.equal(child.killed, true);
});

function makeErrorChild(code = "ENOENT") {
  const child = new EventEmitter();
  child.pid = undefined;
  child.killed = false;
  child.stdout = new Readable({ read() {} });
  child.stdout.push(null);
  child.stderr = new Readable({ read() {} });
  child.stderr.push(null);
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.kill = () => {
    child.killed = true;
  };
  setImmediate(() => {
    child.emit("error", Object.assign(new Error("spawn failed"), { code }));
  });
  return child;
}

test("isRetryableAgyError matches dsh TIMEOUT/TRANSPORT only", () => {
  assert.equal(
    isRetryableAgyError(new AgyError("AGY_TIMEOUT", "x")),
    true,
  );
  assert.equal(
    isRetryableAgyError(new AgyError("AGY_SPAWN_FAILED", "x")),
    true,
  );
  assert.equal(
    isRetryableAgyError(new AgyError("AGY_RATE_LIMITED", "x")),
    false,
  );
  assert.equal(
    isRetryableAgyError(new AgyError("AGY_EMPTY", "x")),
    false,
  );
});

test("runAgy retries a transport failure once under the guard", async () => {
  let spawnCount = 0;
  const guard = { run: async (_signal, start) => start() };

  const result = await runAgy(
    {
      prompt: "retry me",
      model: "Gemini 3.8 Flash (Medium)",
      timeout: "5s",
      dir: os.tmpdir(),
      retryAttempts: 1,
      spawnFn: () => {
        spawnCount += 1;
        return spawnCount === 1
          ? makeErrorChild("ENOENT")
          : makeFakeChild(SUCCESS_OUTPUT);
      },
    },
    guard,
  );

  assert.equal(result.text, "OK\n");
  assert.equal(spawnCount, 2);
});

test("runAgy does not retry a rate limit", async () => {
  const output = ndjson([
    {
      event: "result",
      result: {
        status: "ERROR",
        error: "429 quota exceeded",
        conversation_id: "conv-rate",
      },
    },
  ]);
  let spawnCount = 0;
  const guard = { run: async (_signal, start) => start() };

  await assert.rejects(
    () =>
      runAgy(
        {
          prompt: "test",
          model: "Gemini 3.8 Flash (Medium)",
          timeout: "5s",
          dir: os.tmpdir(),
          retryAttempts: 1,
          spawnFn: () => {
            spawnCount += 1;
            return makeFakeChild(output);
          },
        },
        guard,
      ),
    (error) => error.code === "AGY_RATE_LIMITED",
  );
  assert.equal(spawnCount, 1);
});

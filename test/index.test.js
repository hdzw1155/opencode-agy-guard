import assert from "node:assert/strict";
import test from "node:test";

import plugin, {
  PLUGIN_ID,
  createStatusTool,
  setupV2Plugin,
} from "../src/index.js";

test("registers the agy + agy_status tools and /agy commands on OpenCode V2", async () => {
  const tools = [];
  const commands = [];
  const ctx = {
    tool: {
      transform: async (callback) => {
        const editor = { add: (tool) => tools.push(tool) };
        await callback(editor);
      },
    },
    command: {
      transform: async (callback) => {
        const editor = { add: (command) => commands.push(command) };
        await callback(editor);
      },
    },
  };

  await setupV2Plugin(ctx, { refreshModels: false });

  assert.equal(tools.length, 2);
  const agyTool = tools.find((tool) => tool.name === "agy");
  const statusTool = tools.find((tool) => tool.name === "agy_status");
  assert.ok(agyTool);
  assert.ok(statusTool);
  assert.equal(agyTool.schema.required[0], "prompt");
  assert.equal(typeof agyTool.execute, "function");
  assert.equal(typeof statusTool.execute, "function");

  assert.equal(commands.length, 2);
  const commandNames = commands.map((command) => command.name).sort();
  assert.deepEqual(commandNames, ["agy", "agy-status"]);
  for (const command of commands) {
    assert.match(command.template, /\$ARGUMENTS/);
  }
});

test("agy_status reports guard state and reset clears the breaker", async () => {
  let resetCalled = false;
  const guard = {
    resetBreaker: async () => {
      resetCalled = true;
    },
    snapshot: () => ({
      enabled: true,
      statePath: "C:\\test\\state.json",
      date: "2026-10-19",
      queueDepth: 0,
      queueCap: 4,
      crossProcess: true,
      lockPath: "C:\\test\\state.json.lock",
      windowCount: 2,
      windowCap: 10,
      minIntervalMs: 1500,
      dailyCount: 3,
      dailyCap: 500,
      errorStreak: 4,
      breakerOpenFor: 120000,
      halfOpenProbe: false,
    }),
  };

  const tool = createStatusTool({ guard });
  const result = await tool.execute({ action: "reset" });

  assert.equal(resetCalled, true);
  assert.match(result.content, /breaker reset/);
  assert.match(result.content, /daily: 3\/500/);
  assert.equal(result.metadata.action, "reset");
});

test("exports a V2-compatible plugin entrypoint", () => {
  assert.equal(typeof plugin, "object");
  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin.setup, setupV2Plugin);
});

test("rejects a V1 context without ctx.tool.transform", async () => {
  await assert.rejects(
    () => setupV2Plugin({ tool: {} }),
    /requires OpenCode V2/,
  );
});

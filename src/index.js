import { globalGuard } from "./guard.js";
import {
  getCatalog,
  getCatalogSource,
  listTierKeys,
  refreshModels,
} from "./models.js";
import { DEFAULT_TIMEOUT_MS, runAgy } from "./runner.js";

export const PLUGIN_ID = "opencode-agy-guard";

function buildToolSchema(catalog) {
  const tierKeys = listTierKeys(catalog);

  return {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Self-contained task for agy. Include relevant file paths, constraints, and the expected output. agy cannot see this OpenCode conversation.",
      },
      tier: {
        type: "string",
        description: `Model tier or exact model id. The list is synced from \`agy models\`; current keys: ${tierKeys.join(
          ", ",
        )}. Defaults to ${catalog.defaultKey} (${catalog.defaultModel}).`,
      },
      model: {
        type: "string",
        description:
          'Exact agy model id or display name override, e.g. "gemini-3.8-flash-medium" or "Claude Sonnet 4.6 (Thinking)". Takes precedence over tier.',
      },
      dir: {
        type: "string",
        description:
          "Working directory for agy. Defaults to the current OpenCode project directory.",
      },
      timeout: {
        type: "string",
        description:
          "Wall-clock limit: 90s, 15m, 900000ms, etc. Default 15m; maximum 4h.",
      },
      yolo: {
        type: "boolean",
        description:
          "Skip agy permission prompts (default true, matching dsh-agy-safe). Set false only if you can answer prompts in a terminal.",
      },
      sandbox: {
        type: "boolean",
        description:
          "Run agy with terminal restrictions (--sandbox). Default false.",
      },
      project: {
        type: "string",
        description: "Optional agy project name (--project).",
      },
      continue: {
        type: "boolean",
        description: "Continue the most recent agy conversation (--continue).",
      },
      conversation: {
        type: "string",
        description: "Resume a specific agy conversation ID (--conversation).",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  };
}

const TOOL_DESCRIPTION = `Delegate a self-contained task to the local agy CLI (Google Antigravity).

Use this for a second opinion, a large read-only analysis, or when OpenCode's main models are exhausted. agy is a separate agent: it cannot see this conversation, so include all relevant context. By default it runs with --dangerously-skip-permissions and can read or modify files in \`dir\`; prefer read-only tasks and never pass secrets.

Models are synced from \`agy models\` on startup and refreshed in the background; exact new model ids can be passed with the \`model\` parameter.

Calls are serialized by a local anti-ban guard: one in-flight turn, minimum spacing, a sliding window, a daily cap, and a circuit breaker on 429/quota errors.`;

function getSignal(context) {
  const signal = context?.signal;
  if (signal && typeof signal.aborted === "boolean") return signal;

  const abort = context?.abort;
  if (abort && typeof abort.aborted === "boolean") return abort;
  if (abort?.signal) return abort.signal;

  return undefined;
}

function formatError(error) {
  const code = error?.code ? `[${error.code}] ` : "";
  const retry =
    error?.retryAfterMs > 0
      ? ` Retry in about ${Math.ceil(error.retryAfterMs / 1_000)}s.`
      : "";
  const details = error?.details;
  const diagnostics = [];
  if (details?.cwd) diagnostics.push(`cwd=${details.cwd}`);
  if (details?.eventCount != null) diagnostics.push(`events=${details.eventCount}`);
  if (details?.malformedLines?.length) {
    diagnostics.push(`malformed=${details.malformedLines.length}`);
  }
  if (details?.stderr?.trim()) diagnostics.push(`stderr:\n${details.stderr.trim()}`);
  const suffix = diagnostics.length ? `\n${diagnostics.join("\n")}` : "";
  return `agy failed: ${code}${error?.message ?? String(error)}${retry}${suffix}`;
}

function createTool({ defaultDir, catalog = getCatalog() } = {}) {
  // OpenCode V2 and the V1 compatibility layer use different names for the
  // same JSON schema. Supplying all three is harmless and keeps the tool
  // usable across versions.
  const schema = buildToolSchema(catalog);

  return {
    name: "agy",
    description: TOOL_DESCRIPTION,
    schema,
    input: schema,
    parameters: schema,

    async execute(args = {}, context = {}) {
      // Keep the model catalog fresh without blocking startup. If the setup
      // refresh is still running, this shares it.
      try {
        await refreshModels();
      } catch {
        // Discovery is best-effort; keep the current catalog.
      }

      let result;
      try {
        result = await runAgy({
          prompt: args.prompt,
          tier: args.tier,
          model: args.model,
          dir: args.dir || defaultDir || context.directory || context.worktree,
          timeout: args.timeout ?? DEFAULT_TIMEOUT_MS,
          yolo: args.yolo !== false,
          sandbox: args.sandbox === true,
          project: args.project,
          continue: args.continue === true,
          conversation: args.conversation,
          signal: getSignal(context),
        });
      } catch (error) {
        const failure = new Error(formatError(error));
        failure.code = error?.code;
        throw failure;
      }

      let text = result.text;
      if (result.truncated) {
        text += "\n\n[agy output truncated at 100000 characters]";
      }

      // No `output` key: this tool declares no structured output schema, and
      // the V2 runtime rejects a result that carries `output` anyway
      // ("Tool result declared output without an output schema"), which
      // turned every call into a defect. `content` carries the text.
      return {
        title: `agy · ${result.model}`,
        content: text,
        metadata: {
          model: result.model,
          conversationId: result.conversationId,
          durationMs: result.durationMs,
          usage: result.usage,
          truncated: result.truncated,
          guard: globalGuard.snapshot(),
        },
      };
    },
  };
}

const STATUS_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "reset"],
      description:
        'Use "status" to inspect the guard; use "reset" to clear a tripped circuit breaker and error streak immediately.',
    },
  },
  additionalProperties: false,
};

const STATUS_TOOL_DESCRIPTION = `Show or reset the local agy anti-ban guard.

Use it when an agy call was blocked by the circuit breaker, or when the user asks about agy quota/state. "reset" clears an open breaker without restarting OpenCode. It does not bypass the daily cap or the sliding window.`;

export function createStatusTool({ guard = globalGuard } = {}) {
  const schema = STATUS_SCHEMA;

  return {
    name: "agy_status",
    description: STATUS_TOOL_DESCRIPTION,
    schema,
    input: schema,
    parameters: schema,

    async execute(args = {}) {
      const action = args.action === "reset" ? "reset" : "status";
      if (action === "reset") await guard.resetBreaker();

      const snapshot = guard.snapshot();
      const breaker =
        snapshot.breakerOpenFor > 0
          ? `open, ${Math.ceil(snapshot.breakerOpenFor / 1_000)}s left`
          : snapshot.halfOpenProbe
            ? "half-open probe in progress"
            : "closed";

      const lines = [
        `agy guard: ${snapshot.enabled ? "enabled" : "disabled"}${
          action === "reset" ? " (breaker reset)" : ""
        }`,
        `breaker: ${breaker}`,
        `queue: ${snapshot.queueDepth}`,
        `window: ${snapshot.windowCount}/${snapshot.windowCap} starts (min interval ${snapshot.minIntervalMs}ms)`,
        `daily: ${snapshot.dailyCount}/${snapshot.dailyCap} on ${snapshot.date}`,
        `error streak: ${snapshot.errorStreak}`,
        `models: ${getCatalogSource()} (${getCatalog().models.length})`,
        `state: ${snapshot.statePath}`,
      ];

      return {
        title: `agy_status · breaker ${breaker}`,
        content: lines.join("\n"),
        metadata: {
          action,
          snapshot,
          catalogSource: getCatalogSource(),
        },
      };
    },
  };
}

const COMMAND_TEMPLATE = `Use the \`agy\` tool to delegate this task to the local agy CLI.

Give the tool a self-contained prompt with all relevant paths and constraints. Prefer read-only analysis. agy has local file access and may modify files when yolo is enabled.

Task:
$ARGUMENTS`;

const STATUS_COMMAND_TEMPLATE = `Report the local agy anti-ban guard state by calling the \`agy_status\` tool.

Use action "reset" only when the user explicitly asks to clear a tripped breaker; otherwise use the default "status".

Arguments:
$ARGUMENTS`;

/**
 * Register the agy tool and /agy command on OpenCode V2.
 * The guard wraps the whole agy process, including tool and command paths.
 */
export async function setupV2Plugin(ctx, options = {}) {
  if (!ctx?.tool?.transform) {
    throw new Error(
      "opencode-agy-guard requires OpenCode V2 (ctx.tool.transform not found).",
    );
  }

  // ctx.location.directory is the project directory of the current session;
  // it is the default working directory for agy.
  const defaultDir = ctx?.location?.directory;
  const catalog = options.catalog ?? getCatalog();

  // Sync models from `agy models` in the background. Registration uses the
  // current catalog immediately, so a slow or missing agy cannot block the
  // OpenCode server. Tests pass `refreshModels: false` or an explicit catalog.
  if (!options.catalog && options.refreshModels !== false) {
    void refreshModels({ force: true }).catch(() => {});
  }

  await ctx.tool.transform((editor) => {
    editor.add(createTool({ defaultDir, catalog }));
    editor.add(createStatusTool());
  });

  if (ctx?.command?.transform) {
    await ctx.command.transform((editor) => {
      editor.add({
        name: "agy",
        description: "Delegate a task to the local agy CLI",
        template: COMMAND_TEMPLATE,
      });
      editor.add({
        name: "agy-status",
        description: "Show or reset the local agy anti-ban guard",
        template: STATUS_COMMAND_TEMPLATE,
      });
    });
  }

  return {};
}

// OpenCode V2 expects the default export to be a definition object:
// { id, setup } (or { id, effect }). A bare function is rejected by the
// plugin module schema even if it carries .id/.setup properties.
const plugin = { id: PLUGIN_ID, setup: setupV2Plugin };

export { setupV2Plugin as setup };
export default plugin;

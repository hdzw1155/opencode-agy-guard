/**
 * OpenCode V2 plugin entrypoint.
 *
 * A local-directory plugin is resolved as `<plugin-dir>/index` (or
 * `<plugin-dir>/server`); package.json "main" is never consulted for a
 * directory target, so this root file is what makes the
 * `file:///.../opencode/agy-guard` config entry load at all.
 * Without it the entry is dropped silently and the `agy` tool never
 * registers.
 *
 * The default export must be a plain `{ id, setup }` object - the V2 plugin
 * module schema rejects a function export, even one that carries `id` and
 * `setup` properties.
 */
import { PLUGIN_ID, setupV2Plugin } from "./src/index.js";

export { PLUGIN_ID, setupV2Plugin };
export { setupV2Plugin as setup };

export default { id: PLUGIN_ID, setup: setupV2Plugin };

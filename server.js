// Local directory plugins are resolved by OpenCode V2 via `Host.resolve`,
// which looks for a `server` entrypoint before falling back to `index`.
// Keeping this file at the package root makes the directory loadable without
// requiring OpenCode to understand package.json `exports` for local paths.
export { default } from "./src/index.js";

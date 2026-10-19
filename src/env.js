/**
 * Environment for child agy processes.
 *
 * agy uses its own login/state; API keys and tokens from the OpenCode host
 * are not needed and should not leak into the child. `AGY_*` / `AV_*` names
 * are allowed through because they are agy's own configuration.
 */
const SECRET_PATTERN = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const ALLOWED_SECRET_LIKE = /^(AGY_|AV_)/i;

export function buildEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    if (SECRET_PATTERN.test(key) && !ALLOWED_SECRET_LIKE.test(key)) continue;
    env[key] = value;
  }
  return env;
}

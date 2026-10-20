/**
 * Shared error and async helpers used by the guard, the cross-process lock and
 * the plugin entrypoints.
 */

export class GuardError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "GuardError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs ?? 0;
    this.details = options.details;
  }
}

export function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new GuardError("AGY_GUARD_ABORTED", "agy request aborted");
  error.name = "AbortError";
  return error;
}

export function abortableSleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

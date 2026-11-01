export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Rejects early, with this message, as soon as it returns one (e.g. the awaited process already exited). */
  abortWhen?: () => string | undefined;
}

/**
 * Calls `probe` until it returns something other than `undefined`, `null` or `false`.
 * Exceptions from the probe count as "not yet" and are reported if the deadline passes.
 */
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined | null | false>,
  options: WaitOptions,
): Promise<T> {
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  for (;;) {
    const abort = options.abortWhen?.();
    if (abort !== undefined) throw new Error(`Stopped waiting for ${description}: ${abort}`);
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  const reason = lastError instanceof Error ? `: ${lastError.message.slice(0, 300)}` : '';
  throw new Error(`Timed out after ${String(Math.round(options.timeoutMs / 1000))}s waiting for ${description}${reason}`);
}

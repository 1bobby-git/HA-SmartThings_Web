/** Read-only, command-scoped light checks. Eight reads at most, never overlapping.
 * Front-load the existing read budget while a user is waiting; this is not a
 * background poller and does not change Home Monitor's verification schedule.
 */
export function scheduleLightStateRechecks(
  read: () => Promise<unknown>,
  options: { timeoutMs: number; early: boolean }
): () => void {
  const timeout = Math.max(1, options.timeoutMs);
  const finalAt = Math.max(0, timeout - Math.min(5_000, Math.max(1, Math.floor(timeout / 3))));
  const offsets = [...new Set([
    ...(options.early ? [0, 500, 1_250, 2_500, 4_500, 8_000, 14_000].filter((at) => at < finalAt) : []),
    finalAt
  ])];
  const start = Date.now();
  let stopped = false, index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (minimumDelay = 0) => {
    if (stopped || index >= offsets.length) return;
    const delay = Math.max(minimumDelay, offsets[index++]! - (Date.now() - start));
    if (Date.now() - start + delay >= timeout) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      void Promise.resolve().then(read).catch(() => undefined).finally(() => schedule(250));
    }, delay);
  };
  schedule();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}

/** Command-scoped, bounded READ-only verification. Never schedules a control. */
export function scheduleLocationRechecks(
  read: () => Promise<unknown>,
  options: { timeoutMs: number; firstDelayMs?: number }
): () => void {
  const timeout = Math.max(1, options.timeoutMs);
  const finalAt = Math.max(0, timeout - Math.min(5_000, Math.max(1, Math.floor(timeout / 3))));
  const first = options.firstDelayMs;
  const early = first !== undefined && Number.isFinite(first) && first >= 0 && first < timeout;
  const offsets = [...new Set([
    ...(early ? [first!, first! + 1_000, first! + 3_000, first! + 6_000, first! + 9_000, first! + 14_000, first! + 19_000]
      .filter((at) => at < finalAt) : []), finalAt
  ])].sort((a, b) => a - b);
  const start = Date.now();
  let stopped = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (minimumDelay = 0) => {
    if (stopped || index >= offsets.length) return;
    const delay = Math.max(minimumDelay, offsets[index++]! - (Date.now() - start));
    if (Date.now() - start + delay >= timeout) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      // There is only one in-flight read, including at the final verification window.
      void Promise.resolve().then(read).catch(() => undefined).finally(() => schedule(Math.min(250, Math.max(1, timeout / 20))));
    }, delay);
  };
  schedule();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}

/** A hung/custom status reader must not block the command before dispatch forever. */
export async function boundedLocationRead<T>(read: () => Promise<T>, timeoutMs = 2_250): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

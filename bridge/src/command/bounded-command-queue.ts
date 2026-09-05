/** Keep ordering intact even when a caller's not-yet-started work expires. */
export function enqueueWithDeadline<T>(
  previous: Promise<unknown>, work: () => Promise<T>, waitMs: number,
  timeoutError: () => Error = () => new Error("command_queue_timeout")
): { result: Promise<T>; completion: Promise<void> } {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  timer = setTimeout(() => { expired = true; rejectResult(timeoutError()); }, Math.max(1, waitMs));
  const operation = previous.catch(() => undefined).then(async () => {
    if (timer) clearTimeout(timer);
    if (expired) return; // Never perform a stale security request minutes later.
    try { resolveResult(await work()); } catch (error) { rejectResult(error); }
  });
  // This tail must not race the deadline: later commands must still wait for the running work.
  const completion = operation.then(() => undefined, (error) => { rejectResult(error); });
  return { result, completion };
}

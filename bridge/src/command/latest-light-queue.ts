/** Supersede only explicit light intents. Never release an in-flight POST's lane. */
export function enqueueLightIntent<T>(
  previous: Promise<unknown>, work: () => Promise<T>, signal: AbortSignal,
  waitMs: number, error: (code: "command_superseded" | "command_queue_timeout") => Error
): { result: Promise<T>; completion: Promise<void> } {
  let started = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const supersede = () => {
    // A caller may stop waiting now, but completion still follows the real work.
    if (timer !== undefined) clearTimeout(timer);
    reject(error("command_superseded"));
  };
  signal.addEventListener("abort", supersede, { once: true });
  timer = setTimeout(() => {
    if (!started) { expired = true; reject(error("command_queue_timeout")); }
  }, waitMs);
  const completion = previous.catch(() => undefined).then(async () => {
    if (timer !== undefined) clearTimeout(timer);
    if (expired || signal.aborted) { if (signal.aborted) supersede(); return; }
    started = true;
    try { resolve(await work()); } catch (failure) { reject(failure); }
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", supersede);
  });
  if (signal.aborted) supersede();
  return { result, completion };
}

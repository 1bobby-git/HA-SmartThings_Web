/** Coalesce the entire maintenance transaction, not only its individual steps.
 * No backlog is accumulated while a slow SSO redirect or browser call is pending.
 */
export class SessionMaintenanceGate {
  #pending: Promise<void> | undefined;

  isRunning(): boolean { return this.#pending !== undefined; }

  run(operation: () => Promise<void>): Promise<void> {
    if (this.#pending) return this.#pending;
    const pending = Promise.resolve().then(operation).finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }
}

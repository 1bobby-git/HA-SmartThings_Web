import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface BrowserSupervisorOptions {
  maxRestarts: number;
  launch: () => Promise<unknown>;
  status: RuntimeStatusStore;
  now?: () => number;
  onLaunchError?: () => void;
}

export class BrowserSupervisor {
  #cumulativeFailures = 0;

  constructor(private readonly options: BrowserSupervisorOptions) {}

  async start(): Promise<unknown | undefined> {
    let cycleFailures = 0;
    this.options.status.update({ state: "BROWSER_STARTING" });
    while (cycleFailures <= this.options.maxRestarts) {
      try {
        const context = await this.options.launch();
        this.options.status.update({
          chromiumRunning: true,
          lastBrowserStartAtMs: this.options.now?.() ?? Date.now(),
          state: "LOGIN_REQUIRED"
        });
        return context;
      } catch {
        this.options.onLaunchError?.();
        cycleFailures += 1;
        this.#cumulativeFailures += 1;
        this.options.status.update({
          chromiumRunning: false,
          restartCount: this.#cumulativeFailures,
          state: cycleFailures > this.options.maxRestarts ? "BROWSER_FAILED" : "BROWSER_STARTING"
        });
      }
    }

    return undefined;
  }
}

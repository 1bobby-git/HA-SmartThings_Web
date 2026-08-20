import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface BrowserSupervisorOptions {
  maxRestarts: number;
  launch: () => Promise<unknown>;
  status: RuntimeStatusStore;
}

export class BrowserSupervisor {
  #failures = 0;

  constructor(private readonly options: BrowserSupervisorOptions) {}

  async start(): Promise<unknown | undefined> {
    this.options.status.update({ state: "BROWSER_STARTING" });
    while (this.#failures <= this.options.maxRestarts) {
      try {
        const context = await this.options.launch();
        this.options.status.update({
          chromiumRunning: true,
          lastBrowserStartAtMs: Date.now(),
          state: "LOGIN_REQUIRED"
        });
        return context;
      } catch {
        this.#failures += 1;
        this.options.status.update({
          chromiumRunning: false,
          restartCount: this.#failures,
          state: this.#failures > this.options.maxRestarts ? "BROWSER_FAILED" : "BROWSER_STARTING"
        });
      }
    }

    return undefined;
  }
}

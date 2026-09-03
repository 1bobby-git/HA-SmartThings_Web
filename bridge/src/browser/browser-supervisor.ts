import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface BrowserSupervisorOptions {
  maxRestarts: number;
  launch: () => Promise<unknown>;
  status: RuntimeStatusStore;
  now?: () => number;
  onLaunchError?: (token: string) => void;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
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
      } catch (error: unknown) {
        this.options.onLaunchError?.(browserLaunchFailureToken(error));
        cycleFailures += 1;
        this.#cumulativeFailures += 1;
        this.options.status.update({
          chromiumRunning: false,
          restartCount: this.#cumulativeFailures,
          state: cycleFailures > this.options.maxRestarts ? "BROWSER_FAILED" : "BROWSER_STARTING"
        });
        if (cycleFailures <= this.options.maxRestarts && (this.options.retryDelayMs ?? 0) > 0) {
          await (this.options.wait ?? wait)(this.options.retryDelayMs ?? 0);
        }
      }
    }

    return undefined;
  }
}

export function browserLaunchFailureToken(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "UNKNOWN";
  }
  if ("code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) {
      return code;
    }
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if (/executable doesn't exist/i.test(message)) {
    return "EXECUTABLE_MISSING";
  }
  if (/running as root without --no-sandbox|no usable sandbox/i.test(message)) {
    return "SANDBOX_REQUIRED";
  }
  if (/suid sandbox helper binary was found, but is not configured correctly/i.test(message)) {
    return "SUID_SANDBOX_CONFIG";
  }
  if (/timeout\s+\d+ms\s+exceeded|timed out/i.test(message)) {
    return "LAUNCH_TIMEOUT";
  }
  const permissionLine = message
    .split(/\r?\n/)
    .find((line) => /permission denied|operation not permitted/i.test(line));
  if (permissionLine) {
    if (/chrome[_-]sandbox|suid sandbox/i.test(permissionLine)) {
      return "SUID_SANDBOX_PERMISSION";
    }
    if (/crashpad/i.test(permissionLine)) {
      return "CRASHPAD_PERMISSION";
    }
    if (/zygote/i.test(permissionLine)) {
      return "ZYGOTE_PERMISSION";
    }
    if (/credentials\.cc|\bcapset\b|\bsetpcap\b/i.test(permissionLine)) {
      return "CREDENTIALS_PERMISSION";
    }
    if (/\bnamespace\b|\buserns\b|\bunshare\b/i.test(permissionLine)) {
      return "USERNS_PERMISSION";
    }
    if (/\bseccomp\b/i.test(permissionLine)) {
      return "SECCOMP_PERMISSION";
    }
    const sourceMatch = permissionLine.match(
      /\[(?:FATAL|ERROR):[^\]]*\/([A-Z0-9_.-]+):\d+\]/i
    );
    if (sourceMatch?.[1]) {
      const sourceToken = sourceMatch[1]
        .replace(/\.cc$/i, "")
        .replace(/[^A-Z0-9]+/gi, "_")
        .toUpperCase()
        .slice(0, 24);
      if (sourceToken) {
        return `CHROMIUM_${sourceToken}_PERMISSION`;
      }
    }
    if (/sandbox/i.test(permissionLine)) {
      return "SANDBOX_PERMISSION";
    }
    if (/\/ms-playwright\//i.test(permissionLine)) {
      return "PLAYWRIGHT_BUNDLE_PERMISSION";
    }
    if (/\/data\/chromium-profile/i.test(permissionLine)) {
      return "PROFILE_PERMISSION";
    }
    if (/\/root\//i.test(permissionLine)) {
      return "HOME_PERMISSION";
    }
    if (/\/etc\/fonts\//i.test(permissionLine)) {
      return "FONTS_PERMISSION";
    }
    if (/\/tmp\/\.X11-unix|\bdisplay\b|\bx11\b/i.test(permissionLine)) {
      return "DISPLAY_PERMISSION";
    }
    if (/\/proc\//i.test(permissionLine)) {
      return "PROC_PERMISSION";
    }
    if (/\/dev\/shm/i.test(permissionLine)) {
      return "SHM_PERMISSION";
    }
    if (/\/tmp\//i.test(permissionLine)) {
      return "TMP_PERMISSION";
    }
    return "PERMISSION_DENIED";
  }
  if (/target page, context or browser has been closed|browser closed/i.test(message)) {
    return "BROWSER_CLOSED";
  }
  return "UNKNOWN";
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

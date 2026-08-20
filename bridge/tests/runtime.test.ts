import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  classifySmartThingsUrl,
  createBridgeRuntime,
  type BridgeRuntimeDependencies
} from "../src/runtime.js";
import type { RuntimeStatusPatch } from "../src/state/runtime-state.js";

class FakeEmitter {
  readonly handlers = new Map<string, ((payload: unknown) => void | Promise<void>)[]>();

  on(event: string, handler: (payload: unknown) => void | Promise<void>): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  async emit(event: string, payload?: unknown): Promise<void> {
    await Promise.all((this.handlers.get(event) ?? []).map((handler) => handler(payload)));
  }
}

class FakePage extends FakeEmitter {
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });
  readonly close = vi.fn(async () => {
    this.closed = true;
  });

  constructor(public currentUrl: string, public closed = false) {
    super();
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class FakeCdpSession extends FakeEmitter {
  readonly send = vi.fn(async () => ({}));
}

class FakeContext extends FakeEmitter {
  readonly cdpSessions: FakeCdpSession[] = [];
  readonly closed = vi.fn(async () => undefined);
  readonly fakeBrowser = { version: vi.fn(() => "Chromium 141.0.7390.122") };
  cdpFailure: Error | undefined;

  constructor(public existingPages: FakePage[] = [new FakePage("about:blank")]) {
    super();
  }

  pages(): FakePage[] {
    return this.existingPages;
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage("about:blank");
    this.existingPages.push(page);
    await this.emit("page", page);
    return page;
  }

  async newCDPSession(_page: FakePage): Promise<FakeCdpSession> {
    if (this.cdpFailure) {
      throw this.cdpFailure;
    }
    const session = new FakeCdpSession();
    this.cdpSessions.push(session);
    return session;
  }

  browser(): { version: () => string } {
    return this.fakeBrowser;
  }

  async close(): Promise<void> {
    await this.closed();
  }
}

const runtimes: { stop: () => Promise<void> }[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  vi.useRealTimers();
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stw-runtime-"));
  tempRoots.push(root);
  return root;
}

function createDeps(
  root: string,
  overrides: Partial<BridgeRuntimeDependencies> = {}
): BridgeRuntimeDependencies {
  return {
    config: {
      dataDir: root,
      host: "127.0.0.1",
      port: 0,
      heartbeatIntervalMs: 10_000,
      browserMaxRestarts: 2
    },
    chromium: {
      launchPersistentContext: vi.fn(async () => new FakeContext())
    },
    log: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    },
    ...overrides
  };
}

describe("createBridgeRuntime", () => {
  test("returns after HTTP is ready while browser startup is still pending", async () => {
    const root = createTempRoot();
    let resolveLaunch: ((context: FakeContext) => void) | undefined;
    const launchPersistentContext = vi.fn(
      () =>
        new Promise<FakeContext>((resolve) => {
          resolveLaunch = resolve;
        })
    );

    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext }
      })
    );
    runtimes.push(runtime);

    const live = await fetch(`http://127.0.0.1:${runtime.port}/health/live`);
    expect(live.status).toBe(200);
    expect(runtime.status.getSnapshot().state).toBe("BROWSER_STARTING");

    resolveLaunch?.(new FakeContext());
    await expect(runtime.browserStartup).resolves.toBeUndefined();
    expect(runtime.status.getSnapshot().keeperPresent).toBe(true);
  });

  test("closes a context that resolves after stop while browser startup is pending", async () => {
    const root = createTempRoot();
    const context = new FakeContext();
    let resolveLaunch: ((context: FakeContext) => void) | undefined;
    const launchPersistentContext = vi.fn(
      () =>
        new Promise<FakeContext>((resolve) => {
          resolveLaunch = resolve;
        })
    );
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    };

    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext },
        log
      })
    );
    runtimes.push(runtime);
    await runtime.stop();

    resolveLaunch?.(context);
    await expect(runtime.browserStartup).resolves.toBeUndefined();

    expect(context.closed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/runtime stopped|secret|token/i);
  });

  test("closes a context when post-launch keeper setup fails before assignment", async () => {
    const root = createTempRoot();
    const brokenPage = new FakePage("about:blank");
    brokenPage.goto.mockRejectedValueOnce(new Error("raw keeper token=secret"));
    const context = new FakeContext([brokenPage]);
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    };
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        config: {
          dataDir: root,
          host: "127.0.0.1",
          port: 0,
          heartbeatIntervalMs: 10_000,
          browserMaxRestarts: 0
        },
        chromium: { launchPersistentContext: vi.fn(async () => context) },
        log
      })
    );
    runtimes.push(runtime);

    await expect(runtime.browserStartup).resolves.toBeUndefined();

    expect(context.closed).toHaveBeenCalledTimes(1);
    expect(runtime.status.getSnapshot().state).toBe("BROWSER_FAILED");
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/raw keeper|secret|token/i);
  });

  test("starts HTTP before browser launch and remains live through failed browser/login state", async () => {
    const root = createTempRoot();
      const launchPersistentContext = vi.fn(async () => {
        throw new Error("raw token=secret browser failure");
      });
      const deps = createDeps(root, {
        chromium: { launchPersistentContext }
      });

      const runtime = await createBridgeRuntime(deps);
      runtimes.push(runtime);
      await runtime.browserStartup;
      const live = await fetch(`http://127.0.0.1:${runtime.port}/health/live`);
      const ready = await fetch(`http://127.0.0.1:${runtime.port}/health/ready`);
      const details = await fetch(`http://127.0.0.1:${runtime.port}/health/details`).then((response) =>
        response.json()
      );

      expect(launchPersistentContext).toHaveBeenCalledTimes(3);
      expect(live.status).toBe(200);
      expect(ready.status).toBe(503);
      expect(details.details.state).toBe("BROWSER_FAILED");
      expect(JSON.stringify(details)).not.toMatch(/secret|raw token|browser failure/i);
  });

  test("heartbeats on the configured interval, probes CaptureStore DB, and clears the interval on stop", async () => {
    vi.useFakeTimers();
    const root = createTempRoot();
      const runtime = await createBridgeRuntime(
        createDeps(root, {
          config: {
            dataDir: root,
            host: "127.0.0.1",
            port: 0,
            heartbeatIntervalMs: 1_000,
            browserMaxRestarts: 0
          }
        })
      );
      runtimes.push(runtime);
      await runtime.browserStartup;
      const firstHeartbeat = runtime.status.getSnapshot().heartbeatAtMs;

      await vi.advanceTimersByTimeAsync(1_500);
      const secondHeartbeat = runtime.status.getSnapshot().heartbeatAtMs;
      await runtime.stop();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(secondHeartbeat).toBeGreaterThan(firstHeartbeat);
      expect(runtime.status.getSnapshot().dbAvailable).toBe(true);
      expect(runtime.status.getSnapshot().heartbeatAtMs).toBe(secondHeartbeat);
  });

  test("ensures keeper and installs context/CDP observers for existing and future pages once per context", async () => {
    const root = createTempRoot();
      const context = new FakeContext([new FakePage("https://my.smartthings.com/location?x=1")]);
      const runtime = await createBridgeRuntime(
        createDeps(root, {
          chromium: { launchPersistentContext: vi.fn(async () => context) }
        })
      );
      runtimes.push(runtime);
      await runtime.browserStartup;

      expect(context.pages()).toHaveLength(1);
      expect(context.pages()[0]?.url()).toBe("https://my.smartthings.com/location");
      expect(context.handlers.get("request")).toHaveLength(1);
      expect(context.handlers.get("page")).toHaveLength(2);
      expect(context.cdpSessions).toHaveLength(1);

      const futurePage = await context.newPage();
      await context.emit("page", futurePage);

      expect(context.cdpSessions).toHaveLength(2);
      expect(futurePage.handlers.get("console")).toHaveLength(1);
      expect(context.handlers.get("page")).toHaveLength(2);
  });

  test("recovers after context close without concurrent restart loops and stops at max failures", async () => {
    const root = createTempRoot();
      const first = new FakeContext();
      const second = new FakeContext();
      let launchCalls = 0;
      const launchPersistentContext = vi.fn(async () => {
        launchCalls += 1;
        if (launchCalls === 1) {
          return first;
        }
        if (launchCalls === 2) {
          return second;
        }
        throw new Error("raw context failure token=secret");
      });
      const runtime = await createBridgeRuntime(
        createDeps(root, {
          config: {
            dataDir: root,
            host: "127.0.0.1",
            port: 0,
            heartbeatIntervalMs: 10_000,
            browserMaxRestarts: 0
          },
          chromium: { launchPersistentContext }
        })
      );
      runtimes.push(runtime);
      await runtime.browserStartup;

      await Promise.all([first.emit("close"), first.emit("close")]);
      await Promise.all([second.emit("close"), second.emit("close")]);

      expect(launchPersistentContext).toHaveBeenCalledTimes(3);
      expect(runtime.status.getSnapshot()).toMatchObject({
        state: "BROWSER_FAILED",
        chromiumRunning: false
      });
  });

  test("ignores stale close events and resets per-cycle retry budget while restartCount stays cumulative", async () => {
    const root = createTempRoot();
    const first = new FakeContext();
    const second = new FakeContext();
    const third = new FakeContext();
    const launchPersistentContext = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("raw first-cycle token=secret"))
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new Error("raw second-cycle token=secret"))
      .mockResolvedValueOnce(third);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        config: {
          dataDir: root,
          host: "127.0.0.1",
          port: 0,
          heartbeatIntervalMs: 10_000,
          browserMaxRestarts: 1
        },
        chromium: { launchPersistentContext }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;

    await first.emit("close");
    expect(runtime.status.getSnapshot().restartCount).toBe(1);
    await first.emit("close");
    expect(launchPersistentContext).toHaveBeenCalledTimes(3);

    await second.emit("close");
    expect(runtime.status.getSnapshot()).toMatchObject({
      restartCount: 2,
      state: "DISCOVERING_PROTOCOL",
      chromiumRunning: true
    });
    expect(launchPersistentContext).toHaveBeenCalledTimes(5);
  });

  test("reconciles keeper state without letting future interactive pages overwrite the keeper session", async () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const keeper = new FakePage("https://account.samsung.com/accounts/v1/ST/signInGate");
    const context = new FakeContext([keeper]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        config: {
          dataDir: root,
          host: "127.0.0.1",
          port: 0,
          heartbeatIntervalMs: 1_000,
          browserMaxRestarts: 0
        },
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;

    expect(runtime.status.getSnapshot()).toMatchObject({
      authenticated: false,
      state: "LOGIN_REQUIRED",
      urlCategory: "samsung_login"
    });
    expect(keeper.goto).not.toHaveBeenCalled();

    const interactive = await context.newPage();
    interactive.currentUrl = "https://my.smartthings.com/advanced";
    await context.emit("page", interactive);
    expect(runtime.status.getSnapshot()).toMatchObject({
      state: "LOGIN_REQUIRED",
      urlCategory: "samsung_login"
    });

    keeper.currentUrl = "https://example.test/drift";
    await vi.advanceTimersByTimeAsync(1_100);
    expect(keeper.goto).toHaveBeenCalledWith("https://my.smartthings.com/location", {
      waitUntil: "domcontentloaded"
    });
    expect(runtime.status.getSnapshot()).toMatchObject({
      authenticated: true,
      state: "DISCOVERING_PROTOCOL",
      urlCategory: "smartthings_location"
    });
  });

  test("contains per-page CDP setup failures and retries later without transport-only readiness claims", async () => {
    const root = createTempRoot();
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    };
    const page = new FakePage("https://my.smartthings.com/location");
    const context = new FakeContext([page]);
    context.cdpFailure = new Error("raw cdp token=secret");
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => context) },
        log
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;

    expect(log.warn).toHaveBeenCalledWith("cdp_observer_install_failed");
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/raw cdp|secret/);
    expect(runtime.status.getSnapshot()).toMatchObject({
      parserHealthy: false,
      pushConnected: false,
      initialSnapshotComplete: false
    });

    context.cdpFailure = undefined;
    await context.emit("page", page);

    expect(context.cdpSessions).toHaveLength(1);
  });

  test("continues stop cleanup when context close fails and remains idempotent", async () => {
    const root = createTempRoot();
    const context = new FakeContext();
    context.closed.mockRejectedValueOnce(new Error("raw close token=secret"));
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;
    const baseUrl = `http://127.0.0.1:${runtime.port}`;

    await runtime.stop();
    await runtime.stop();

    expect(context.closed).toHaveBeenCalledTimes(1);
    await expect(fetch(`${baseUrl}/health/live`)).rejects.toThrow();
  });

  test("gracefully and idempotently stops context, server, alias store, and capture store", async () => {
    const root = createTempRoot();
      const context = new FakeContext();
      const runtime = await createBridgeRuntime(
        createDeps(root, {
          chromium: { launchPersistentContext: vi.fn(async () => context) }
        })
      );
      runtimes.push(runtime);
      await runtime.browserStartup;
      const baseUrl = `http://127.0.0.1:${runtime.port}`;

      await runtime.stop();
      await runtime.stop();

      expect(context.closed).toHaveBeenCalledTimes(1);
      await expect(fetch(`${baseUrl}/health/live`)).rejects.toThrow();
  });

  test("sanitizes launch errors and records only fixed category logs", async () => {
    const root = createTempRoot();
      const log = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
      };
      const runtime = await createBridgeRuntime(
        createDeps(root, {
          chromium: {
            launchPersistentContext: vi.fn(async () => {
              throw new Error("raw-device token=secret stack");
            })
          },
          log
        })
      );
      runtimes.push(runtime);
      await runtime.browserStartup;

      expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/raw-device|secret|stack/);
      expect(log.error).toHaveBeenCalledWith("browser_launch_failed");
  });
});

describe("classifySmartThingsUrl", () => {
  test.each([
    ["https://my.smartthings.com/location?deviceId=raw", "smartthings_location"],
    ["https://my.smartthings.com/advanced", "smartthings_advanced"],
    ["https://account.samsung.com/accounts/v1/ST/signInGate", "samsung_login"],
    ["https://example.test/path", "other"],
    ["not a url", "error"],
    ["", "none"]
  ] as const)("classifies %s by URL only", (url, category) => {
    expect(classifySmartThingsUrl(url)).toBe(category);
  });
});

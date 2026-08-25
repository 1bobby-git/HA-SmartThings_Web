import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  classifySmartThingsUrl,
  createBridgeRuntime,
  type BridgeRuntimeDependencies
} from "../src/runtime.js";
import type { PhysicalActionProbeSnapshot } from "../src/inspector/physical-action-correlation-probe.js";
import { PROTOCOL_CONTRACT_FINGERPRINT } from "../src/inspector/protocol-contract.js";
import { ProtocolIntegrityStore } from "../src/state/protocol-integrity-store.js";
import type { RuntimeStatusPatch } from "../src/state/runtime-state.js";
import { createHealthReport } from "../src/server/health.js";

class FakeEmitter {
  readonly handlers = new Map<string, ((payload: unknown) => void | Promise<void>)[]>();

  on(event: string, handler: (payload: unknown) => void | Promise<void>): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  async emit(event: string, payload?: unknown): Promise<void> {
    await Promise.all((this.handlers.get(event) ?? []).map((handler) => handler(payload)));
  }
}

class FakeRoleLocator {
  readonly click = vi.fn(async () => {
    if (this.role === "button") {
      this.page.currentUrl = "https://my.smartthings.com/location/loc-synthetic-001/device";
      return;
    }
    await this.page.onCommandToggle?.();
  });
  readonly waitFor = vi.fn(async () => undefined);

  constructor(
    private readonly page: FakePage,
    private readonly role: string
  ) {}

  async count(): Promise<number> {
    return this.role === "button" || this.role === "switch" ? 1 : 0;
  }

  first(): FakeRoleLocator {
    return this;
  }

  filter(): FakeRoleLocator {
    return this;
  }
}

class FakePage extends FakeEmitter {
  readonly goto = vi.fn(async (url: string) => {
    this.onGoto?.();
    this.currentUrl = url;
  });
  readonly close = vi.fn(async () => {
    this.closed = true;
  });

  constructor(
    public currentUrl: string,
    public closed = false,
    private readonly onGoto?: () => void,
    readonly onCommandToggle?: () => void | Promise<void>
  ) {
    super();
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  getByRole(role: string): FakeRoleLocator {
    return new FakeRoleLocator(this, role);
  }

  getByText(): FakeRoleLocator {
    return new FakeRoleLocator(this, "button");
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
  onCommandToggle: (() => void | Promise<void>) | undefined;

  constructor(public existingPages: FakePage[] = [new FakePage("about:blank")]) {
    super();
  }

  pages(): FakePage[] {
    return this.existingPages;
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage("about:blank", false, undefined, this.onCommandToggle);
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
      browserMaxRestarts: 2,
      browserRetryDelayMs: 0
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
  test("wires the authenticated command API through an isolated UI page and push confirmation", async () => {
    const root = createTempRoot();
    const context = new FakeContext([
      new FakePage("https://my.smartthings.com/location/loc-synthetic-001")
    ]);
    const runtime = await createBridgeRuntime(
      createDeps(root, { chromium: { launchPersistentContext: vi.fn(async () => context) } })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;
    const socket = await attachRuntimeSocket(context);
    await emitCompleteSnapshot(socket);
    await emitFirstDeviceEvent(socket);
    await socket.emit("framereceived", {
      payload: buildDeviceEventFrame({
        eventId: "command-event-000",
        deviceId: "raw-command-device-001",
        capability: "switch",
        attribute: "switch",
        value: "off",
        stateChange: true,
        eventTime: "2026-08-25T00:00:00Z"
      })
    });

    const baseUrl = `http://127.0.0.1:${runtime.port}`;
    const pairingCode = await fetch(`${baseUrl}/api/v1/pairing-code`, { method: "POST" }).then(
      (response) => response.json() as Promise<{ code: string }>
    );
    const token = await fetch(`${baseUrl}/api/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCode.code })
    }).then((response) => response.json() as Promise<{ token: string }>);
    const headers = { authorization: `Bearer ${token.token}` };
    const inventory = await fetch(`${baseUrl}/api/v1/inventory`, { headers }).then(
      (response) => response.json() as Promise<{
        devices: Array<{
          id: string;
          states: Array<{ component: string; capability: string; attribute: string }>;
        }>;
      }>
    );
    expect(runtime.status.getSnapshot()).toMatchObject({
      state: "CONNECTED",
      pushConnected: true,
      parserHealthy: true,
      initialSnapshotComplete: true,
      decodedDeviceEventCount: 2
    });
    const target = inventory.devices.find((device) =>
      device.states.some((state) => state.attribute === "switch")
    );
    expect(target).toBeDefined();
    const state = target?.states.find((candidate) => candidate.attribute === "switch");
    expect(state).toBeDefined();
    context.onCommandToggle = async () => {
      await socket.emit("framereceived", {
        payload: buildDeviceEventFrame({
          eventId: "command-event-001",
          deviceId: "raw-command-device-001",
          capability: "switch",
          attribute: "switch",
          value: "on",
          stateChange: true,
          eventTime: "2026-08-25T00:00:01Z"
        })
      });
    };

    const response = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: target?.id,
        component: state?.component,
        capability: state?.capability,
        command: "on",
        arguments: [],
        clientRequestId: "request_haos_001"
      })
    });

    const responseBody = await response.json();
    expect({ status: response.status, body: responseBody }).toMatchObject({
      status: 200,
      body: { status: "confirmed", confirmation: "device_event" }
    });
    expect(context.existingPages.filter((page) => !page.closed)).toHaveLength(1);
  });

  test("emits path-free startup stage markers in order", async () => {
    const root = createTempRoot();
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    };

    const runtime = await createBridgeRuntime(createDeps(root, { log }));
    runtimes.push(runtime);
    await runtime.browserStartup;

    expect(log.info.mock.calls.slice(0, 13)).toEqual([
      ["bridge_init:data_paths"],
      ["bridge_init:data_paths:data_dir"],
      ["bridge_init:data_paths:profile_dir"],
      ["bridge_init:data_paths:download_dir"],
      ["bridge_init:data_paths:bridge_secret"],
      ["bridge_init:data_paths:sqlite_file"],
      ["bridge_init:data_paths:settings_file"],
      ["bridge_init:data_paths:protocol_fingerprint_file"],
      ["bridge_init:secret"],
      ["bridge_init:protocol_integrity"],
      ["bridge_init:alias_store"],
      ["bridge_init:capture_store"],
      ["bridge_init:http_server"]
    ]);
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/\\|\/data|secret path|token/i);
  });

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
          browserMaxRestarts: 0,
          browserRetryDelayMs: 0
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
            browserMaxRestarts: 0,
            browserRetryDelayMs: 0
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

  test("reloads a restored authenticated keeper only after network observers are attached", async () => {
    const root = createTempRoot();
    let context!: FakeContext;
    const keeper = new FakePage(
      "https://my.smartthings.com/location/loc-synthetic-001",
      false,
      () => {
        expect(context.handlers.get("websocket")).toHaveLength(1);
        expect(context.cdpSessions).toHaveLength(1);
      }
    );
    context = new FakeContext([keeper]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;

    expect(keeper.goto).toHaveBeenCalledTimes(1);
    expect(keeper.goto).toHaveBeenCalledWith("https://my.smartthings.com/location", {
      waitUntil: "domcontentloaded"
    });
  });

  test("updates safe protocol counters when duplicate sanitized DEVICE_EVENT frames arrive", async () => {
    const root = createTempRoot();
    const context = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;
    const fixture = JSON.parse(
      readFileSync("protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json", "utf8")
    ) as { event_name: string; fixture_deliveries: unknown[] };
    const socket = new FakeEmitter() as FakeEmitter & { url: () => string };
    socket.url = () => "wss://my.smartthings.com/socket.io/";

    await context.emit("websocket", socket);
    for (const delivery of fixture.fixture_deliveries) {
      await socket.emit("framereceived", {
        payload: `42${JSON.stringify([fixture.event_name, delivery])}`
      });
    }

    expect(runtime.status.getSnapshot()).toMatchObject({
      pushConnected: true,
      parserHealthy: true,
      decodedDeviceEventCount: 3,
      uniqueLogicalEventCount: 1,
      duplicateEventCount: 2,
      dedupeJournalSize: 1,
      protocolInvalidFrameCount: 0,
      lastParserSuccessAtMs: expect.any(Number)
    });
  });

  test("marks snapshot complete only after all real ACK categories and becomes ready after push", async () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const context = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        config: {
          dataDir: root,
          host: "127.0.0.1",
          port: 0,
          heartbeatIntervalMs: 1_000,
          browserMaxRestarts: 2,
          browserRetryDelayMs: 0
        },
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;
    const socket = new FakeEmitter() as FakeEmitter & { url: () => string };
    socket.url = () => "wss://my.smartthings.com/socket.io/";
    await context.emit("websocket", socket);
    const snapshotFixture = JSON.parse(
      readFileSync("protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json", "utf8")
    ) as {
      correlations: Array<{
        ack_id: string;
        request_event: string;
        request_query: string;
        request_keys: string[];
        response_category: string;
        response_count: number;
        response_item_keys: string[];
        response_keys?: string[];
      }>;
    };

    for (const correlation of snapshotFixture.correlations) {
      const ackId = Number(correlation.ack_id.split("_")[1]);
      await socket.emit("framesent", {
        payload: `42${ackId}${JSON.stringify([
          correlation.request_event,
          correlation.request_query,
          Object.fromEntries(correlation.request_keys.map((key) => [key, null]))
        ])}`
      });
      await socket.emit("framereceived", {
        payload: `43${ackId}${JSON.stringify([null, buildRuntimeSnapshotResponse(correlation)])}`
      });
    }

    expect(runtime.status.getSnapshot()).toMatchObject({
      initialSnapshotComplete: true,
      observedDeviceCount: 212,
      pushConnected: false,
      state: "SYNCING",
      lastSnapshotAtMs: expect.any(Number)
    });
    expect(createHealthReport(runtime.status.getSnapshot()).ready).toBe(false);

    const eventFixture = JSON.parse(
      readFileSync("protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json", "utf8")
    ) as { event_name: string; fixture_deliveries: unknown[] };
    await socket.emit("framereceived", {
      payload: `42${JSON.stringify([eventFixture.event_name, eventFixture.fixture_deliveries[0]])}`
    });

    expect(runtime.status.getSnapshot()).toMatchObject({
      initialSnapshotComplete: true,
      pushConnected: true,
      parserHealthy: true,
      state: "CONNECTED"
    });
    expect(createHealthReport(runtime.status.getSnapshot()).ready).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(runtime.status.getSnapshot().state).toBe("CONNECTED");
  });

  test("persists the first complete protocol baseline and exposes the safe protocol version", async () => {
    const root = createTempRoot();
    const context = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;

    const socket = await attachRuntimeSocket(context);
    await emitCompleteSnapshot(socket);
    await emitFirstDeviceEvent(socket);

    const persisted = JSON.parse(readFileSync(join(root, "protocol-fingerprint.json"), "utf8")) as {
      protocol_contract_version: number;
      baseline: string | null;
      current: string | null;
      change_count: number;
    };
    const expectedVersion = `1:${PROTOCOL_CONTRACT_FINGERPRINT.slice(0, 16)}`;

    expect(persisted).toMatchObject({
      protocol_contract_version: 1,
      baseline: PROTOCOL_CONTRACT_FINGERPRINT,
      current: PROTOCOL_CONTRACT_FINGERPRINT,
      change_count: 0
    });
    expect(runtime.status.getSnapshot()).toMatchObject({
      initialSnapshotComplete: true,
      pushConnected: true,
      parserHealthy: true,
      state: "CONNECTED",
      protocolChangeCount: 0,
      protocolVersion: expectedVersion
    });
    expect(createHealthReport(runtime.status.getSnapshot()).ready).toBe(true);
  });

  test("serves the physical action probe from normal and protocol-load-failed runtimes", async () => {
    const normal = await startReadyRuntime();

    const initial = await fetch(`${normal.baseUrl}/probe/physical-action`);
    const armed = await postProbeArm(normal.baseUrl, { actionType: "contact_open" });

    expect(initial.status).toBe(200);
    expect(armed.status).toBe(201);
    await expect(armed.json()).resolves.toMatchObject({ state: "armed", actionType: "contact_open" });

    const isolatedRoot = createTempRoot();
    const isolatedContext = new FakeContext([
      new FakePage("https://my.smartthings.com/location/loc-synthetic-001"),
      new FakePage("https://my.smartthings.com/advanced")
    ]);
    const isolatedRuntime = await createBridgeRuntime(
      createDeps(isolatedRoot, {
        chromium: { launchPersistentContext: vi.fn(async () => isolatedContext) }
      })
    );
    runtimes.push(isolatedRuntime);
    await isolatedRuntime.browserStartup;
    const isolatedSocket = await attachRuntimeSocket(isolatedContext);
    await emitCompleteSnapshot(isolatedSocket);
    await emitFirstDeviceEvent(isolatedSocket);

    const notIsolated = await postProbeArm(`http://127.0.0.1:${isolatedRuntime.port}`, {
      actionType: "contact_open"
    });

    expect(notIsolated.status).toBe(409);
    await expectFixedProbeError(notIsolated, "browser_not_isolated");

    const corruptRoot = createTempRoot();
    writeFileSync(join(corruptRoot, "protocol-fingerprint.json"), "{not json", "utf8");
    const corruptRuntime = await createBridgeRuntime(createDeps(corruptRoot));
    runtimes.push(corruptRuntime);
    await corruptRuntime.browserStartup;
    const corruptBaseUrl = `http://127.0.0.1:${corruptRuntime.port}`;
    const corruptProbe = await fetch(`${corruptBaseUrl}/probe/physical-action`);
    const corruptArm = await postProbeArm(corruptBaseUrl, { actionType: "contact_open" });

    expect(corruptProbe.status).toBe(200);
    expect(corruptArm.status).not.toBe(503);
    await expectFixedProbeError(corruptArm, "browser_not_isolated");
  });

  test("correlates duplicate contact events from Playwright and CDP without exposing raw values", async () => {
    const { baseUrl, context, socket } = await startReadyRuntime();
    const arm = await postProbeArm(baseUrl, { actionType: "contact_open" });
    expect(arm.status).toBe(201);

    const frame = buildDeviceEventFrame({
      eventId: "evt_contact_probe_001",
      deviceId: "raw-contact-device-001",
      capability: "contactSensor",
      attribute: "contact",
      value: "open",
      stateChange: true
    });
    await socket.emit("framereceived", { payload: frame });
    await context.cdpSessions[0]?.emit("Network.webSocketFrameReceived", {
      response: { opcode: 1, payloadData: frame }
    });

    const snapshot = await getProbeSnapshot(baseUrl);

    expect(snapshot).toMatchObject({
      state: "armed",
      actionType: "contact_open",
      candidateCount: 1,
      candidates: [
        {
          component: "main",
          capability: "contactSensor",
          attribute: "contact",
          valueType: "string",
          unitPresent: false,
          stateChange: true,
          expectedValueMatched: true,
          identitySource: "event_id",
          uniqueLogicalEventCount: 1,
          deliveryCount: 2
        }
      ]
    });
    expect(snapshot.candidates[0]?.deviceAlias).toMatch(/^dev_\d{3,32}$/);
    expect(snapshot.candidates[0]?.logicalEventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /raw-contact-device-001|evt_contact_probe_001|raw-location-001|"value"\s*:|"open"/i
    );
  });

  test("serves camera image bytes discovered from CDP websocket thumbnail ACKs", async () => {
    const originalFetch = globalThis.fetch;
    const fetchWithMedia = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("https://media.st-av.net/")) {
        return new Response(Uint8Array.from([31, 32, 33]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "3" }
        });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchWithMedia);
    try {
      const { baseUrl, context } = await startReadyRuntime();
      const token = await exchangeBridgeToken(baseUrl);
      const headers = { authorization: `Bearer ${token}` };

      await context.cdpSessions[0]?.emit("Network.webSocketFrameSent", {
        requestId: "cdp-socket-camera",
        response: {
          opcode: 1,
          payloadData: '421["get","api/camera/thumbnail","raw-camera-uuid",{}]'
        }
      });
      await context.cdpSessions[0]?.emit("Network.webSocketFrameReceived", {
        requestId: "cdp-socket-camera",
        response: {
          opcode: 1,
          payloadData:
            '431[null,{"url":"https://media.st-av.net/camera/image.jpg?token=secret"}]'
        }
      });

      const response = await fetchFirstImage(baseUrl, headers);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([31, 32, 33]));
      expect(
        fetchWithMedia.mock.calls.some(([input, init]) =>
          input.toString().startsWith("https://media.st-av.net/") &&
          init?.redirect === "error"
        )
      ).toBe(true);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  test("keeps an armed probe active for a component-less contact event", async () => {
    const { baseUrl, socket } = await startReadyRuntime();
    const arm = await postProbeArm(baseUrl, { actionType: "contact_open" });
    expect(arm.status).toBe(201);

    await socket.emit("framereceived", {
      payload: buildDeviceEventFrame({
        eventId: "evt_componentless_contact_001",
        deviceId: "raw-contact-device-001",
        component: null,
        capability: "contactSensor",
        attribute: "contact",
        value: "open",
        stateChange: true,
        eventTime: Date.now()
      })
    });

    await expect(getProbeSnapshot(baseUrl)).resolves.toMatchObject({
      state: "armed",
      candidateCount: 1,
      reasons: [],
      candidates: [
        {
          component: "unspecified",
          capability: "contactSensor",
          attribute: "contact",
          expectedValueMatched: true
        }
      ]
    });
    expect((await getProbeSnapshot(baseUrl)).candidates[0]?.deviceAlias).toMatch(/^dev_\d{3,32}$/);
  });

  test("fails an armed probe on unsafe device events without logging raw event content", async () => {
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const { baseUrl, socket } = await startReadyRuntime({ log });
    const arm = await postProbeArm(baseUrl, { actionType: "contact_open" });
    expect(arm.status).toBe(201);

    await socket.emit("framereceived", {
      payload: buildDeviceEventFrame({
        eventId: "evt_unsafe_probe_secret_001",
        deviceId: "raw-unsafe-device-001",
        capability: "bad semantic token",
        attribute: "contact",
        value: "raw unsafe value token",
        stateChange: true
      })
    });

    const snapshot = await getProbeSnapshot(baseUrl);

    expect(snapshot).toMatchObject({
      state: "fail",
      reasons: ["unsafe_event"],
      candidateCount: 0
    });
    expect(JSON.stringify(log)).not.toMatch(
      /evt_unsafe_probe_secret_001|raw-unsafe-device-001|raw unsafe value token|bad semantic token|raw-location-001|secret|token|url|alias|body|header/i
    );
  });

  test("fails an armed probe before protocol mismatch status handling", async () => {
    const { baseUrl, socket } = await startReadyRuntime();
    const arm = await postProbeArm(baseUrl, { actionType: "contact_open" });
    expect(arm.status).toBe(201);

    await emitSceneShapeMismatch(socket, 70);

    await expect(getProbeSnapshot(baseUrl)).resolves.toMatchObject({
      state: "fail",
      reasons: ["protocol_changed"]
    });
  });

  test("fails an armed probe on context restart and keeps evidence until manual reset", async () => {
    const root = createTempRoot();
    const first = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const second = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;
    const socket = await attachRuntimeSocket(first);
    await emitCompleteSnapshot(socket);
    await emitFirstDeviceEvent(socket);
    const baseUrl = `http://127.0.0.1:${runtime.port}`;
    const arm = await postProbeArm(baseUrl, { actionType: "contact_open" });
    expect(arm.status).toBe(201);

    await first.emit("close");

    const snapshot = await getProbeSnapshot(baseUrl);
    expect(snapshot).toMatchObject({
      state: "fail",
      reasons: ["runtime_restarted"]
    });

    const reset = await fetch(`${baseUrl}/probe/physical-action/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toMatchObject({ state: "voided", reasons: ["manual_reset"] });
  });

  test("fails an armed probe immediately when a new page breaks browser isolation", async () => {
    const { baseUrl, context } = await startReadyRuntime();
    const arm = await postProbeArm(baseUrl, { actionType: "contact_open" });
    expect(arm.status).toBe(201);

    const page = await context.newPage();
    await page.close();

    await expect(getProbeSnapshot(baseUrl)).resolves.toMatchObject({
      state: "fail",
      reasons: ["browser_not_isolated"]
    });
  });

  test("latches protocol changes for the process lifetime across valid frames and reconnects", async () => {
    const root = createTempRoot();
    const first = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const second = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const launchPersistentContext = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        config: {
          dataDir: root,
          host: "127.0.0.1",
          port: 0,
          heartbeatIntervalMs: 10_000,
          browserMaxRestarts: 1,
          browserRetryDelayMs: 0
        },
        chromium: { launchPersistentContext }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;

    const firstSocket = await attachRuntimeSocket(first);
    await emitCompleteSnapshot(firstSocket);
    await emitFirstDeviceEvent(firstSocket);
    expect(createHealthReport(runtime.status.getSnapshot()).ready).toBe(true);

    await emitSceneShapeMismatch(firstSocket, 50);

    expect(runtime.status.getSnapshot()).toMatchObject({
      state: "PROTOCOL_CHANGED",
      parserHealthy: false,
      protocolChangeCount: 1,
      protocolVersion: `1:${PROTOCOL_CONTRACT_FINGERPRINT.slice(0, 16)}`
    });
    expect(createHealthReport(runtime.status.getSnapshot()).ready).toBe(false);

    await emitFirstDeviceEvent(firstSocket);
    expect(runtime.status.getSnapshot()).toMatchObject({
      state: "PROTOCOL_CHANGED",
      parserHealthy: false,
      protocolChangeCount: 1
    });

    await first.emit("close");
    const secondSocket = await attachRuntimeSocket(second);
    await emitCompleteSnapshot(secondSocket);
    await emitFirstDeviceEvent(secondSocket);

    expect(runtime.status.getSnapshot()).toMatchObject({
      state: "PROTOCOL_CHANGED",
      parserHealthy: false,
      protocolChangeCount: 1,
      initialSnapshotComplete: false,
      pushConnected: false
    });
    expect(createHealthReport(runtime.status.getSnapshot()).ready).toBe(false);
  });

  test("restarts with matching protocol data without incrementing the persistent change count", async () => {
    const root = createTempRoot();
    const first = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const firstRuntime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => first) }
      })
    );
    runtimes.push(firstRuntime);
    await firstRuntime.browserStartup;
    const firstSocket = await attachRuntimeSocket(first);
    await emitCompleteSnapshot(firstSocket);
    await emitFirstDeviceEvent(firstSocket);
    await firstRuntime.stop();
    runtimes.splice(runtimes.indexOf(firstRuntime), 1);

    const second = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const secondRuntime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => second) }
      })
    );
    runtimes.push(secondRuntime);
    await secondRuntime.browserStartup;
    const secondSocket = await attachRuntimeSocket(second);
    await emitCompleteSnapshot(secondSocket);
    await emitFirstDeviceEvent(secondSocket);

    const persisted = JSON.parse(readFileSync(join(root, "protocol-fingerprint.json"), "utf8")) as {
      change_count: number;
    };
    expect(persisted.change_count).toBe(0);
    expect(secondRuntime.status.getSnapshot()).toMatchObject({
      state: "CONNECTED",
      protocolChangeCount: 0,
      protocolVersion: `1:${PROTOCOL_CONTRACT_FINGERPRINT.slice(0, 16)}`
    });
    expect(createHealthReport(secondRuntime.status.getSnapshot()).ready).toBe(true);
  });

  test("keeps HTTP live and skips chromium when the protocol store is corrupt", async () => {
    const root = createTempRoot();
    writeFileSync(join(root, "protocol-fingerprint.json"), "{not json", "utf8");
    const launchPersistentContext = vi.fn(async () => new FakeContext());
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
    await runtime.browserStartup;

    const live = await fetch(`http://127.0.0.1:${runtime.port}/health/live`);
    const ready = await fetch(`http://127.0.0.1:${runtime.port}/health/ready`);

    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(runtime.status.getSnapshot()).toMatchObject({
      state: "PROTOCOL_CHANGED",
      parserHealthy: false,
      chromiumRunning: false,
      keeperPresent: false,
      protocolVersion: "1:discovering"
    });
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/not json|protocol-fingerprint|token|secret/i);
    expect(log.error).toHaveBeenCalledWith("protocol_integrity_store_failed");
  });

  test("preserves a persisted same-contract surface mismatch across healthy replay after restart", async () => {
    const root = createTempRoot();
    const seeded = new ProtocolIntegrityStore(join(root, "protocol-fingerprint.json"), {
      contractVersion: 1
    });
    seeded.recordMismatch("snapshot:scenes:response_shape");
    expect(seeded.snapshot().changeCount).toBe(1);

    const context = new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;

    const socket = await attachRuntimeSocket(context);
    await emitCompleteSnapshot(socket);
    await emitFirstDeviceEvent(socket);

    const status = runtime.status.getSnapshot();
    expect(status).toMatchObject({
      state: "PROTOCOL_CHANGED",
      chromiumRunning: true,
      parserHealthy: false,
      pushConnected: false,
      initialSnapshotComplete: false,
      protocolChangeCount: 1,
      protocolMismatchSurface: "snapshot:scenes:response_shape"
    });
    expect(createHealthReport(status)).toMatchObject({
      ready: false,
      details: {
        state: "PROTOCOL_CHANGED",
        protocolChangeCount: 1,
        protocolMismatchSurface: "snapshot:scenes:response_shape"
      }
    });
    expect(
      new ProtocolIntegrityStore(join(root, "protocol-fingerprint.json"), {
        contractVersion: 1
      }).snapshot().changeCount
    ).toBe(1);
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
            browserMaxRestarts: 0,
            browserRetryDelayMs: 0
          },
          chromium: { launchPersistentContext }
        })
      );
      runtimes.push(runtime);
      await runtime.browserStartup;

      runtime.status.update({
        initialSnapshotComplete: true,
        pushConnected: true,
        parserHealthy: true,
        decodedDeviceEventCount: 3,
        uniqueLogicalEventCount: 1,
        duplicateEventCount: 2,
        dedupeJournalSize: 1,
        observedDeviceCount: 212
      });

      await Promise.all([first.emit("close"), first.emit("close")]);
      expect(runtime.status.getSnapshot()).toMatchObject({
        initialSnapshotComplete: false,
        pushConnected: false,
        parserHealthy: false,
        decodedDeviceEventCount: 0,
        uniqueLogicalEventCount: 0,
        duplicateEventCount: 0,
        dedupeJournalSize: 0,
        observedDeviceCount: 0
      });
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
          browserMaxRestarts: 1,
          browserRetryDelayMs: 0
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
          browserMaxRestarts: 0,
          browserRetryDelayMs: 0
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
              throw Object.assign(new Error("raw-device token=secret stack"), { code: "EACCES" });
            })
          },
          log
        })
      );
      runtimes.push(runtime);
      await runtime.browserStartup;

      expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/raw-device|secret|stack/);
      expect(log.error).toHaveBeenCalledWith("browser_launch_failed:EACCES");
  });
});

describe("classifySmartThingsUrl", () => {
  test.each([
    ["https://my.smartthings.com/location?deviceId=raw", "smartthings_location"],
    ["https://my.smartthings.com/location/loc-synthetic-001", "smartthings_location"],
    ["https://my.smartthings.com/advanced", "smartthings_advanced"],
    ["https://account.samsung.com/accounts/v1/ST/signInGate", "samsung_login"],
    ["https://example.test/path", "other"],
    ["not a url", "error"],
    ["", "none"]
  ] as const)("classifies %s by URL only", (url, category) => {
    expect(classifySmartThingsUrl(url)).toBe(category);
  });
});

function buildRuntimeSnapshotResponse(correlation: {
  response_category: string;
  response_count: number;
  response_item_keys: string[];
  response_keys?: string[];
}): unknown {
  const items = Array.from({ length: correlation.response_count }, () =>
    Object.fromEntries(correlation.response_item_keys.map((key) => [key, null]))
  );
  if (correlation.response_category === "device_cards") {
    return Object.fromEntries(
      (correlation.response_keys ?? ["data"]).map((key) => [key, key === "data" ? items : null])
    );
  }
  return items;
}

async function attachRuntimeSocket(context: FakeContext): Promise<FakeEmitter & { url: () => string }> {
  const socket = new FakeEmitter() as FakeEmitter & { url: () => string };
  socket.url = () => "wss://my.smartthings.com/socket.io/";
  await context.emit("websocket", socket);
  return socket;
}

async function startReadyRuntime(options: {
  context?: FakeContext;
  log?: BridgeRuntimeDependencies["log"];
} = {}): Promise<{
  baseUrl: string;
  context: FakeContext;
  runtime: Awaited<ReturnType<typeof createBridgeRuntime>>;
  socket: FakeEmitter & { url: () => string };
}> {
  const root = createTempRoot();
  const context =
    options.context ?? new FakeContext([new FakePage("https://my.smartthings.com/location/loc-synthetic-001")]);
  const runtime = await createBridgeRuntime(
    createDeps(root, {
      chromium: { launchPersistentContext: vi.fn(async () => context) },
      ...(options.log ? { log: options.log } : {})
    })
  );
  runtimes.push(runtime);
  await runtime.browserStartup;
  const socket = await attachRuntimeSocket(context);
  await emitCompleteSnapshot(socket);
  await emitFirstDeviceEvent(socket);
  expect(createHealthReport(runtime.status.getSnapshot()).ready).toBe(true);
  return { baseUrl: `http://127.0.0.1:${runtime.port}`, context, runtime, socket };
}

async function postProbeArm(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/probe/physical-action/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function exchangeBridgeToken(baseUrl: string): Promise<string> {
  const pairingCode = await fetch(`${baseUrl}/api/v1/pairing-code`, { method: "POST" }).then(
    (response) => response.json()
  ) as { code: string };
  const token = await fetch(`${baseUrl}/api/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairingCode.code })
  }).then((response) => response.json()) as { token: string };
  return token.token;
}

async function fetchFirstImage(
  baseUrl: string,
  headers: { authorization: string }
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const deviceId of ["dev_001", "dev_002", "dev_003", "dev_004", "dev_005"]) {
      const response = await fetch(`${baseUrl}/api/v1/images/${deviceId}`, { headers });
      if (response.status === 200) return response;
      lastResponse = response;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!lastResponse) throw new Error("image response missing");
  return lastResponse;
}

async function getProbeSnapshot(baseUrl: string): Promise<PhysicalActionProbeSnapshot> {
  const response = await fetch(`${baseUrl}/probe/physical-action`);
  expect(response.status).toBe(200);
  return (await response.json()) as PhysicalActionProbeSnapshot;
}

async function expectFixedProbeError(response: Response, code: string): Promise<void> {
  expect(await response.text()).toBe(JSON.stringify({ error: code }));
}

function buildDeviceEventFrame(options: {
  eventId: string;
  deviceId: string;
  component?: string | null;
  capability: string;
  attribute: string;
  value: string;
  stateChange: boolean;
  eventTime?: string | number;
}): string {
  return `42${JSON.stringify([
    "api/subscription DEVICE_EVENT",
    {
      subscription_id: "sub_001",
      data: {
        event_type: "DEVICE_EVENT",
        event_time: options.eventTime ?? "2026-08-24T00:00:00Z",
        device_event: {
          event_id: options.eventId,
          device_id: options.deviceId,
          location_id: "raw-location-001",
          component: options.component === undefined ? "main" : options.component,
          capability: options.capability,
          attribute: options.attribute,
          value: options.value,
          unit: null,
          state_change: options.stateChange,
          owner_id: "owner_001",
          owner_type: "LOCATION"
        }
      }
    }
  ])}`;
}

async function emitCompleteSnapshot(socket: FakeEmitter): Promise<void> {
  const snapshotFixture = JSON.parse(
    readFileSync("protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json", "utf8")
  ) as {
    correlations: Array<{
      ack_id: string;
      request_event: string;
      request_query: string;
      request_keys: string[];
      response_category: string;
      response_count: number;
      response_item_keys: string[];
      response_keys?: string[];
    }>;
  };

  for (const correlation of snapshotFixture.correlations) {
    const ackId = Number(correlation.ack_id.split("_")[1]);
    await socket.emit("framesent", {
      payload: `42${ackId}${JSON.stringify([
        correlation.request_event,
        correlation.request_query,
        Object.fromEntries(correlation.request_keys.map((key) => [key, null]))
      ])}`
    });
    await socket.emit("framereceived", {
      payload: `43${ackId}${JSON.stringify([null, buildRuntimeSnapshotResponse(correlation)])}`
    });
  }
}

async function emitFirstDeviceEvent(socket: FakeEmitter): Promise<void> {
  const eventFixture = JSON.parse(
    readFileSync("protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json", "utf8")
  ) as { event_name: string; fixture_deliveries: unknown[] };
  await socket.emit("framereceived", {
    payload: `42${JSON.stringify([eventFixture.event_name, eventFixture.fixture_deliveries[0]])}`
  });
}

async function emitSceneShapeMismatch(socket: FakeEmitter, ackId: number): Promise<void> {
  await socket.emit("framesent", {
    payload: `42${ackId}${JSON.stringify(["find", "api/scene", {}])}`
  });
  await socket.emit("framereceived", {
    payload: `43${ackId}${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`
  });
}

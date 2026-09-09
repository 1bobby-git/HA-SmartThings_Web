import { afterEach, describe, expect, test, vi } from "vitest";

import { AdvancedCommandAdapter } from "../../src/advanced/command-adapter.js";
import {
  CapabilityDefinitionCache,
  parseCapabilityDefinition
} from "../../src/advanced/capability-cache.js";
import {
  AuthenticatedSmartThingsSession,
  type AdvancedParser,
  type AdvancedRequest,
  type AuthenticatedAdvancedSession
} from "../../src/advanced/authenticated-session.js";
import type { BrowserPageLike } from "../../src/browser/keeper-page.js";
import type { RoutedCommandRequest } from "../../src/command/command-router.js";

class ExecutingPage implements BrowserPageLike {
  closed = false;
  constructor(public currentUrl = "https://my.smartthings.com/location") {}
  url(): string { return this.currentUrl; }
  isClosed(): boolean { return this.closed; }
  async goto(url: string): Promise<void> { this.currentUrl = url; }
  async close(): Promise<void> { this.closed = true; }
  async evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    return await pageFunction(argument);
  }
}

class RecordingSession implements AuthenticatedAdvancedSession {
  readonly requests: AdvancedRequest[] = [];
  constructor(private readonly resultsPerRequest: number) {}
  async request<T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T> {
    this.requests.push(request);
    return parser({ results: Array.from({ length: this.resultsPerRequest }, () => ({ status: "ACCEPTED" })) });
  }
}

function setPageWindow(value: Record<PropertyKey, unknown>): void {
  vi.stubGlobal("window", value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("keeper app-client light fast path", () => {
  test("uses the already-loaded api/device service without an Advanced fetch", async () => {
    const patch = vi.fn(async () => ({ data: { results: [{ status: "ACCEPTED" }] } }));
    const pageWindow: Record<PropertyKey, unknown> = { _app: { csrfToken: "unused-fixture" } };
    pageWindow[Symbol.for("smartthings_web_bridge.cake_client")] = {
      service: (name: string) => name === "api/device" ? { patch } : undefined
    };
    setPageWindow(pageWindow);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const timing: unknown[] = [];
    const page = new ExecutingPage();
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => page,
      openAdvancedPage: vi.fn(),
      onRequestTiming: (event) => timing.push(event)
    });
    const body = {
      commands: [
        { component: "main", capability: "switch", command: "on", arguments: [] },
        { component: "main", capability: "switchLevel", command: "setLevel", arguments: [42] }
      ]
    };
    await expect(session.request({
      endpoint: "commands",
      method: "POST",
      path: "/advanced/cupcake-api/api/devices/raw-device/commands",
      body,
      preferAppClient: true
    }, (value) => value)).resolves.toEqual({
      results: [{ status: "ACCEPTED" }, { status: "ACCEPTED" }]
    });
    expect(patch).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith("raw-device", {
      query: {
        execute: true,
        commands: [
          { component: "main", capability: "switch", command: "on" },
          { component: "main", capability: "switchLevel", command: "setLevel", arguments: [42] }
        ]
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(timing).toEqual([
      expect.objectContaining({
        endpoint: "commands",
        method: "POST",
        route: "keeper",
        status: 202,
        appClient: true,
        browserMs: expect.any(Number),
        fetchMs: expect.any(Number),
        bodyMs: 0
      })
    ]);
  });

  test("falls back to the unchanged CSRF fetch only before patch is available", async () => {
    setPageWindow({ _app: { csrfToken: "fixture-csrf" } });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      type: "basic",
      json: async () => ({ results: [{ status: "ACCEPTED" }] })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const page = new ExecutingPage();
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => page,
      openAdvancedPage: vi.fn()
    });
    await expect(session.request({
      endpoint: "commands",
      method: "POST",
      path: "/advanced/cupcake-api/api/devices/raw-device/commands",
      body: { commands: [{ component: "main", capability: "switch", command: "on", arguments: [] }] },
      preferAppClient: true
    }, (value) => value)).resolves.toEqual({ results: [{ status: "ACCEPTED" }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("never replays through fetch after api/device patch has been attempted", async () => {
    const patch = vi.fn(async () => { throw new Error("fixture failure"); });
    const pageWindow: Record<PropertyKey, unknown> = { _app: { csrfToken: "fixture-csrf" } };
    pageWindow[Symbol.for("smartthings_web_bridge.cake_client")] = {
      service: () => ({ patch })
    };
    setPageWindow(pageWindow);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const openAdvancedPage = vi.fn();
    const page = new ExecutingPage();
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => page,
      openAdvancedPage
    });
    await expect(session.request({
      endpoint: "commands",
      method: "POST",
      path: "/advanced/cupcake-api/api/devices/raw-device/commands",
      body: { commands: [{ component: "main", capability: "switch", command: "on", arguments: [] }] },
      preferAppClient: true
    }, (value) => value)).rejects.toThrow("advanced_request_unavailable");
    expect(patch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openAdvancedPage).not.toHaveBeenCalled();
  });
});

describe("light adapter app-client opt in", () => {
  const actions: RoutedCommandRequest[] = [
    { deviceId: "dev_001", component: "main", capability: "switch", capabilityVersion: 1,
      command: "on", arguments: [] },
    { deviceId: "dev_001", component: "main", capability: "switchLevel", capabilityVersion: 1,
      command: "setLevel", arguments: [42] }
  ];
  const definition = (id: string) => parseCapabilityDefinition({
    id,
    version: 1,
    attributes: {},
    commands: {
      on: { arguments: [] },
      setLevel: { arguments: [{ name: "level", schema: { type: "integer", minimum: 0, maximum: 100 } }] }
    }
  });

  test("marks both batch and sequence light-plan POSTs for keeper app-client reuse", async () => {
    const cache = new CapabilityDefinitionCache(async (id) => definition(id));
    const batchSession = new RecordingSession(2);
    const batch = new AdvancedCommandAdapter({
      session: batchSession,
      capabilityCache: cache,
      resolveRawDeviceId: () => "raw-device",
      resolveRawIdentifier: (id) => id
    });
    await batch.executeBatch(actions);
    expect(batchSession.requests).toHaveLength(1);
    expect(batchSession.requests[0]?.preferAppClient).toBe(true);

    const sequenceSession = new RecordingSession(1);
    const sequence = new AdvancedCommandAdapter({
      session: sequenceSession,
      capabilityCache: cache,
      resolveRawDeviceId: () => "raw-device",
      resolveRawIdentifier: (id) => id
    });
    await sequence.executeSequence(actions);
    expect(sequenceSession.requests).toHaveLength(2);
    expect(sequenceSession.requests.every((request) => request.preferAppClient === true)).toBe(true);
  });
});

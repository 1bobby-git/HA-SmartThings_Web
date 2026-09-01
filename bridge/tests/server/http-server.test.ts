import { afterEach, describe, expect, test, vi } from "vitest";
import { createConnection } from "node:net";

import {
  PhysicalActionCorrelationProbe,
  type ProbeRuntimeEvidence
} from "../../src/inspector/physical-action-correlation-probe.js";
import { SafeCommandError } from "../../src/command/command-service.js";
import { BridgeAuth } from "../../src/server/bridge-auth.js";
import { createBridgeHttpServer } from "../../src/server/http-server.js";
import { DeviceStore } from "../../src/state/device-store.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe("createBridgeHttpServer", () => {
  test("serves safe health and status routes with live/ready HTTP semantics", async () => {
    const now = Date.now();
    const store = new RuntimeStatusStore({
      now: () => now,
      initial: {
        dbAvailable: true,
        heartbeatAtMs: now,
        state: "LOGIN_REQUIRED",
        urlCategory: "samsung_login"
      }
    });
    const server = await createBridgeHttpServer({ store, host: "127.0.0.1", port: 0 });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    const details = await fetch(`${baseUrl}/health/details`).then((response) => response.json());
    const page = await fetch(baseUrl).then((response) => response.text());

    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(live.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await live.json()).live).toBe(true);
    expect(ready.status).toBe(503);
    expect((await ready.json()).ready).toBe(false);
    expect(details.details.state).toBe("LOGIN_REQUIRED");
    expect(page).toContain("SmartThings Web Bridge");
    expect(page).toContain('href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify"');
    expect(page).not.toContain('href="/novnc/"');
    expect(JSON.stringify([details, page])).not.toMatch(/https?:\/\/my\.smartthings\.com|deviceId|locationId|token|secret/i);

    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("arms, snapshots, and resets the physical action probe with safe JSON responses", async () => {
    const { baseUrl } = await startProbeServer();

    const arm = await fetch(`${baseUrl}/probe/physical-action/arm`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        actionType: "contact_open",
        targetDeviceAlias: "dev_007",
        windowSeconds: 15
      })
    });
    const armed = await arm.json();
    const current = await fetch(`${baseUrl}/probe/physical-action`);
    const reset = await fetch(`${baseUrl}/probe/physical-action/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });

    expect(arm.status).toBe(201);
    expect(armed).toMatchObject({
      state: "armed",
      actionType: "contact_open",
      targetDeviceAlias: "dev_007",
      windowSeconds: 15
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ state: "armed", actionType: "contact_open" });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ state: "voided", reasons: ["manual_reset"] });
  });

  test("returns probe conflict on a second active arm", async () => {
    const { baseUrl } = await startProbeServer();

    await postJson(`${baseUrl}/probe/physical-action/arm`, { actionType: "contact_open" });
    const conflict = await postJson(`${baseUrl}/probe/physical-action/arm`, { actionType: "contact_close" });

    expect(conflict.status).toBe(409);
    await expectFixedError(conflict, "probe_conflict");
  });

  test("maps domain readiness failures to fixed probe errors", async () => {
    const isolated = await startProbeServer({ evidence: healthyEvidence({ browserIsolated: false }) });
    const notReady = await startProbeServer({ evidence: healthyEvidence({ observedDeviceCount: 0 }) });

    const browser = await postJson(`${isolated.baseUrl}/probe/physical-action/arm`, { actionType: "contact_open" });
    const ready = await postJson(`${notReady.baseUrl}/probe/physical-action/arm`, { actionType: "contact_open" });

    expect(browser.status).toBe(409);
    await expectFixedError(browser, "browser_not_isolated");
    expect(ready.status).toBe(503);
    await expectFixedError(ready, "not_ready");
  });

  test.each([
    ["malformed JSON", "{", "invalid_json"],
    ["empty body", "", "invalid_body"],
    ["array body", "[]", "invalid_body"],
    ["primitive body", "\"contact_open\"", "invalid_body"],
    ["unknown key", "{\"actionType\":\"contact_open\",\"secret\":\"token-123\"}", "unknown_key"],
    ["missing action", "{\"windowSeconds\":15}", "invalid_body"],
    ["wrong action type", "{\"actionType\":42}", "invalid_body"],
    ["unsupported action", "{\"actionType\":\"scene_run\"}", "unsupported_action"],
    ["target alias number", "{\"actionType\":\"contact_open\",\"targetDeviceAlias\":7}", "invalid_body"],
    ["target alias object", "{\"actionType\":\"contact_open\",\"targetDeviceAlias\":{}}", "invalid_body"],
    ["unsafe alias", "{\"actionType\":\"contact_open\",\"targetDeviceAlias\":\"dev_007_secret_token\"}", "unsafe_target_alias"],
    ["window below range", "{\"actionType\":\"contact_open\",\"windowSeconds\":14}", "window_out_of_range"],
    ["window above range", "{\"actionType\":\"contact_open\",\"windowSeconds\":121}", "window_out_of_range"],
    ["window string", "{\"actionType\":\"contact_open\",\"windowSeconds\":\"15\"}", "window_out_of_range"],
    ["window noninteger", "{\"actionType\":\"contact_open\",\"windowSeconds\":15.5}", "window_out_of_range"]
  ] as const)("rejects invalid arm request: %s", async (_name, body, error) => {
    const { baseUrl } = await startProbeServer();

    const response = await fetch(`${baseUrl}/probe/physical-action/arm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });

    expect(response.status).toBe(400);
    await expectFixedError(response, error);
  });

  test("requires JSON content type for probe POSTs while accepting UTF-8 charset", async () => {
    const { baseUrl } = await startProbeServer();

    const absent = await fetch(`${baseUrl}/probe/physical-action/arm`, {
      method: "POST",
      body: JSON.stringify({ actionType: "contact_open" })
    });
    const wrong = await fetch(`${baseUrl}/probe/physical-action/arm`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ actionType: "contact_open" })
    });
    const accepted = await fetch(`${baseUrl}/probe/physical-action/arm`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ actionType: "contact_open" })
    });

    expect(absent.status).toBe(415);
    await expectFixedError(absent, "content_type_unsupported");
    expect(wrong.status).toBe(415);
    await expectFixedError(wrong, "content_type_unsupported");
    expect(accepted.status).toBe(201);
  });

  test("rejects probe bodies over 4096 bytes from declared and streamed lengths", async () => {
    const { baseUrl, server } = await startProbeServer();
    const oversized = JSON.stringify({
      actionType: "contact_open",
      padding: "x".repeat(4096)
    });

    const declared = await fetch(`${baseUrl}/probe/physical-action/arm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(oversized.length)
      },
      body: oversized
    });
    const streamed = await fetch(`${baseUrl}/probe/physical-action/arm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(" ".repeat(4097)));
          controller.close();
        }
      }),
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const preRejected = await rawOversizedPostWithoutBody(server.port);

    expect(declared.status).toBe(413);
    await expectFixedError(declared, "body_too_large");
    expect(streamed.status).toBe(413);
    await expectFixedError(streamed, "body_too_large");
    expect(preRejected).toContain("HTTP/1.1 413 Payload Too Large");
    expect(preRejected).toContain("{\"error\":\"body_too_large\"}");
  });

  test("rejects invalid UTF-8 JSON bytes without leaking raw content", async () => {
    const { server } = await startProbeServer();

    const response = await rawInvalidUtf8JsonPost(server.port);

    expect(response).toContain("HTTP/1.1 400 Bad Request");
    expect(response).toContain("{\"error\":\"invalid_json\"}");
    expect(response).not.toMatch(/secret|token|dev_007|event_id:|fingerprint:|https?:\/\//i);
  });

  test("preserves method and route boundaries for probe paths", async () => {
    const { baseUrl } = await startProbeServer();

    const wrongMethod = await fetch(`${baseUrl}/probe/physical-action`, { method: "POST" });
    const unknown = await fetch(`${baseUrl}/probe/physical-action/unknown`);

    expect(wrongMethod.status).toBe(405);
    await expectFixedError(wrongMethod, "method_not_allowed");
    expect(unknown.status).toBe(404);
    await expectFixedError(unknown, "not_found");
  });

  test("returns probe unavailable when either probe dependency is absent", async () => {
    const onlyEvidence = await startProbeServer({ includeProbe: false });
    const onlyProbe = await startProbeServer({ includeEvidence: false });
    const neither = await startProbeServer({ includeProbe: false, includeEvidence: false });

    for (const baseUrl of [onlyEvidence.baseUrl, onlyProbe.baseUrl, neither.baseUrl]) {
      const response = await fetch(`${baseUrl}/probe/physical-action`);
      expect(response.status).toBe(503);
      await expectFixedError(response, "probe_unavailable");
    }
  });

  test("maps unexpected evidence failure to fixed internal error", async () => {
    const { baseUrl } = await startProbeServer({
      getProbeEvidence: () => {
        throw new Error("secret thrown message event_id:abc fingerprint:xyz https://internal");
      }
    });

    const response = await fetch(`${baseUrl}/probe/physical-action`);

    expect(response.status).toBe(500);
    await expectFixedError(response, "internal_error");
  });

  test.each<readonly [string, string, string] | readonly [string, string, string, string]>([
    ["reset properties", "{\"event_id\":\"abc\"}", "unknown_key"],
    ["reset empty body", "", "invalid_body"],
    ["reset array", "[]", "invalid_body"],
    ["reset string", "\"reset\"", "invalid_body"],
    ["reset number", "42", "invalid_body"],
    ["reset wrong content type", "{}", "content_type_unsupported", "text/plain"]
  ])("rejects invalid reset request: %s", async (_name, body, error, contentType = "application/json") => {
    const { baseUrl } = await startProbeServer();

    const response = await fetch(`${baseUrl}/probe/physical-action/reset`, {
      method: "POST",
      headers: { "content-type": contentType },
      body
    });

    expect(response.status).toBe(error === "content_type_unsupported" ? 415 : 400);
    await expectFixedError(response, error);
  });

  test("probe errors do not echo secrets, raw values, URLs, headers, or identities", async () => {
    const { baseUrl } = await startProbeServer();

    const response = await fetch(`${baseUrl}/probe/physical-action/arm?token=secret`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-secret-header": "event_id:header-fingerprint"
      },
      body: JSON.stringify({
        actionType: "contact_open",
        targetDeviceAlias: "dev_007_secret_suffix",
        event_id: "abc",
        url: "https://internal.example"
      })
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toBe("{\"error\":\"unknown_key\"}");
    expect(body).not.toMatch(/secret|dev_007_secret_suffix|https?:\/\/|headers?|event_id:|fingerprint:/i);
  });

  test("all probe responses are JSON, no-store, and nosniff", async () => {
    const { baseUrl } = await startProbeServer();
    const responses = [
      await fetch(`${baseUrl}/probe/physical-action`),
      await postJson(`${baseUrl}/probe/physical-action/arm`, { actionType: "contact_open" }),
      await postJson(`${baseUrl}/probe/physical-action/reset`, {}),
      await fetch(`${baseUrl}/probe/physical-action/arm`, { method: "GET" })
    ];

    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("GET probe snapshot does not wait for or consume a request body", async () => {
    const { server } = await startProbeServer();

    const response = await rawHttpRequestWithoutBody(server.port);

    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toContain("content-type: application/json; charset=utf-8");
    expect(response).toContain("\"state\":\"idle\"");
  });

  test("serves authenticated command requests and returns only the safe confirmation envelope", async () => {
    const token = "a".repeat(32);
    const execute = vi.fn(async () => ({
      schemaVersion: 1 as const,
      clientRequestId: "request_007",
      status: "confirmed" as const,
      sequence: 7,
              transport: "smartthings_web_ui" as const,
              confirmation: "device_event" as const,
              lifecycle: "CONFIRMED_BY_EVENT" as const
    }));
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices: new DeviceStore(),
      commands: { execute }
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceId: "dev_001",
        component: "main",
        capability: "identifier_switch",
        command: "on",
        arguments: [],
        clientRequestId: "request_007"
      })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      clientRequestId: "request_007",
      status: "confirmed",
      sequence: 7,
      transport: "smartthings_web_ui",
      confirmation: "device_event",
      lifecycle: "CONFIRMED_BY_EVENT"
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("serves authenticated inventory reload and realtime reconnect maintenance requests", async () => {
    const token = "m".repeat(32);
    const reloadInventory = vi.fn(async () => undefined);
    const reconnectRealtime = vi.fn(async () => undefined);
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices: new DeviceStore(),
      maintenance: { reloadInventory, reconnectRealtime }
    });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const reload = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/maintenance/reload-inventory`,
      { method: "POST", headers }
    );
    const reconnect = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/maintenance/reconnect-realtime`,
      { method: "POST", headers }
    );

    expect(reload.status).toBe(200);
    await expect(reload.json()).resolves.toEqual({ accepted: true });
    expect(reconnect.status).toBe(200);
    await expect(reconnect.json()).resolves.toEqual({ accepted: true });
    expect(reloadInventory).toHaveBeenCalledOnce();
    expect(reconnectRealtime).toHaveBeenCalledOnce();
  });

  test("streams the current inventory marker and subsequent device events, then unsubscribes on close", async () => {
    const token = "e".repeat(32);
    const unsubscribe = vi.fn();
    const store = createStore();
    let listener: ((value: unknown) => void) | undefined;
    const devices = {
      snapshot: vi.fn(() => ({ sequence: 41 })),
      currentSequence: vi.fn(() => 41),
      subscribe: vi.fn((next: (value: unknown) => void) => {
        listener = next;
        return unsubscribe;
      })
    } as unknown as DeviceStore;
    const server = await createBridgeHttpServer({
      store,
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices
    });
    servers.push(server);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    try {
      expect(reader).toBeDefined();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");

      const first = await readEventStreamMessage(reader!);
      expect(first).toBe('data: {"schemaVersion":1,"sequence":41,"type":"inventory"}\n\n');
      expect(devices.currentSequence).toHaveBeenCalledTimes(1);
      expect(devices.snapshot).not.toHaveBeenCalled();
      expect(devices.subscribe).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().activeConnections).toBe(1);

      listener?.({
        schemaVersion: 1,
        type: "state",
        sequence: 42,
        deviceId: "dev_001",
        state: {
          component: "main",
          capability: "relativeHumidityMeasurement",
          attribute: "humidity",
          value: 62.8,
          unit: "%",
          updatedAt: "2026-08-26T06:00:00.000Z"
        }
      });
      const second = await readEventStreamMessage(reader!);
      expect(JSON.parse(second.slice(6).trim())).toMatchObject({
        type: "state",
        sequence: 42,
        deviceId: "dev_001",
        state: { attribute: "humidity", value: 62.8 }
      });
    } finally {
      if (reader) await reader.cancel().catch(() => undefined);
      controller.abort();
    }
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.getSnapshot().activeConnections).toBe(0));
  });

  test("requires Bridge authentication and maps command failures to fixed safe HTTP errors", async () => {
    const token = "b".repeat(32);
    const execute = vi.fn(async () => {
      throw new SafeCommandError("command_confirmation_timeout");
    });
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices: new DeviceStore(),
      commands: { execute }
    });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/api/v1/commands`;

    const unauthorized = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const timedOut = await fetch(baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}"
    });

    expect(unauthorized.status).toBe(401);
    await expectFixedError(unauthorized, "unauthorized");
    expect(timedOut.status).toBe(504);
    const timedOutBody = await timedOut.text();
    expect(timedOutBody).toBe(JSON.stringify({ error: "command_confirmation_timeout" }));
    expect(timedOutBody).not.toMatch(/token|deviceId|component|capability/i);
  });

  test("serves authenticated bounded command catalog for one alias device", async () => {
    const token = "e".repeat(32);
    const devices = new DeviceStore();
    devices.observeAdvancedInventorySnapshot({
      locations: [{ locationId: "loc_001", name: "Home" }],
      devices: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          label: "Lamp",
          healthState: "ONLINE",
          components: [{ id: "main", label: "Main", capabilities: [{ id: "switch", version: 1 }] }]
        }
      ]
    });
    devices.observeAdvancedCommandCatalog(
      "dev_001",
      [
        {
          component: "main",
          capability: "switch",
          capabilityVersion: 1,
          command: "on",
          arguments: [],
          transport: "advanced",
          confirmation: "state",
          label: "Power",
          labelSource: "capability"
        }
      ],
      [
        {
          component: "main",
          capability: "switch",
          command: "setToken",
          reason: "sensitive_argument"
        }
      ]
    );
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices
    });
    servers.push(server);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/commands/catalog?deviceId=dev_001`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      schemaVersion: 1,
      deviceId: "dev_001",
      commands: [
        {
          component: "main",
          capability: "switch",
          capabilityVersion: 1,
          command: "on",
          arguments: [],
          transport: "advanced",
          confirmation: "state",
          label: "Power",
          labelSource: "capability"
        }
      ],
      omissions: { sensitive_argument: 1 }
    });
    body.commands[0].arguments.push({ name: "mutated" });
    expect(devices.snapshot().devices[0]?.advancedCommands?.[0]?.arguments).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/raw|uuid|token|secret|identifier_/i);
  });

  test("validates command catalog auth query and method without leaking request values", async () => {
    const token = "f".repeat(32);
    const devices = new DeviceStore();
    devices.observeAdvancedInventorySnapshot({
      locations: [{ locationId: "loc_001", name: "Home" }],
      devices: [{ deviceId: "dev_001", locationId: "loc_001", label: "Lamp" }]
    });
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices
    });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/api/v1/commands/catalog`;
    const authed = { authorization: `Bearer ${token}` };

    const cases = [
      [await fetch(`${baseUrl}?deviceId=dev_001`), 401, "unauthorized"],
      [await fetch(`${baseUrl}`, { headers: authed }), 400, "missing_device_id"],
      [await fetch(`${baseUrl}?deviceId=dev_001&deviceId=dev_002`, { headers: authed }), 400, "duplicate_query_param"],
      [await fetch(`${baseUrl}?deviceId=dev_001&rawDeviceId=uuid-secret`, { headers: authed }), 400, "unknown_query_param"],
      [await fetch(`${baseUrl}?deviceId=uuid-secret`, { headers: authed }), 400, "invalid_device_id"],
      [await fetch(`${baseUrl}?deviceId=dev_999`, { headers: authed }), 404, "device_not_found"],
      [await fetch(`${baseUrl}?deviceId=dev_001`, { method: "POST", headers: authed }), 405, "method_not_allowed"]
    ] as const;

    for (const [response, status, error] of cases) {
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).toBe(JSON.stringify({ error }));
      expect(text).not.toMatch(/uuid-secret|Bearer|token|identifier_/i);
    }
  });

  test.each([
    "component_command_partial_failure",
    "component_command_rollback_failed"
  ] as const)("maps %s to a fixed safe 502 response", async (code) => {
    const token = "d".repeat(32);
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices: new DeviceStore(),
      commands: {
        execute: vi.fn(async () => {
          throw new SafeCommandError(code);
        })
      }
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}"
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe(JSON.stringify({ error: code }));
  });

  test("serves only authenticated cached camera bytes without exposing their source URL", async () => {
    const token = "c".repeat(32);
    const get = vi.fn((deviceId: string) =>
      deviceId === "dev_001"
        ? {
            body: Buffer.from([0xff, 0xd8, 0xff]),
            contentType: "image/jpeg" as const,
            capturedAt: "2026-08-25T02:00:00.000Z"
          }
        : undefined
    );
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices: new DeviceStore(),
      images: { get }
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/api/v1/images/dev_001`;

    const unauthorized = await fetch(base);
    const response = await fetch(base, { headers: { authorization: `Bearer ${token}` } });
    const missing = await fetch(base.replace("dev_001", "dev_002"), {
      headers: { authorization: `Bearer ${token}` }
    });

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(missing.status).toBe(404);
    expect(get).toHaveBeenCalledWith("dev_001");
    expect(await missing.text()).toBe(JSON.stringify({ error: "camera_image_not_found" }));
  });

  test("merges camera image cache notifications into the authenticated event stream", async () => {
    const token = "d".repeat(32);
    let imageListener: ((event: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const server = await createBridgeHttpServer({
      store: createStore(),
      host: "127.0.0.1",
      port: 0,
      auth: new BridgeAuth(token),
      devices: new DeviceStore(),
      images: {
        get: vi.fn(),
        subscribe: vi.fn((listener: (event: unknown) => void) => {
          imageListener = listener;
          return unsubscribe;
        })
      }
    });
    servers.push(server);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    imageListener?.({
      schemaVersion: 1,
      type: "image",
      sequence: 7,
      deviceId: "dev_001",
      image: { contentType: "image/jpeg", capturedAt: "2026-08-25T02:00:00.000Z" }
    });

    const chunks: string[] = [];
    while (!chunks.join("").includes('"type":"image"')) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      chunks.push(new TextDecoder().decode(chunk.value));
    }
    controller.abort();
    await reader!.cancel().catch(() => undefined);

    const text = chunks.join("");
    expect(text).toContain('"type":"image"');
    expect(text).toContain('"deviceId":"dev_001"');
    expect(text).not.toMatch(/token|media\.st-av\.net|cookie/i);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });
});

function createStore(): RuntimeStatusStore {
  const now = Date.now();
  return new RuntimeStatusStore({
    now: () => now,
    initial: {
      dbAvailable: true,
      heartbeatAtMs: now,
      state: "CONNECTED",
      urlCategory: "smartthings_advanced",
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true
    }
  });
}

async function startProbeServer(options: {
  includeProbe?: boolean;
  includeEvidence?: boolean;
  evidence?: ProbeRuntimeEvidence;
  getProbeEvidence?: () => ProbeRuntimeEvidence;
} = {}): Promise<{ baseUrl: string; server: { port: number; close: () => Promise<void> } }> {
  const includeProbe = options.includeProbe ?? true;
  const includeEvidence = options.includeEvidence ?? true;
  const server = await createBridgeHttpServer({
    store: createStore(),
    host: "127.0.0.1",
    port: 0,
    ...(includeProbe ? { physicalActionProbe: new PhysicalActionCorrelationProbe() } : {}),
    ...(includeEvidence
      ? { getProbeEvidence: options.getProbeEvidence ?? (() => options.evidence ?? healthyEvidence()) }
      : {})
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, server };
}

function healthyEvidence(overrides: Partial<ProbeRuntimeEvidence> = {}): ProbeRuntimeEvidence {
  return {
    live: true,
    ready: true,
    state: "CONNECTED",
    browserIsolated: true,
    observedDeviceCount: 213,
    decodedDeviceEventCount: 100,
    uniqueLogicalEventCount: 50,
    duplicateEventCount: 50,
    protocolInvalidFrameCount: 2,
    protocolChangeCount: 0,
    restartCount: 0,
    ...overrides
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function expectFixedError(response: Response, code: string): Promise<void> {
  expect(await response.text()).toBe(JSON.stringify({ error: code }));
}

async function readEventStreamMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const decoder = new TextDecoder();
  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("event stream ended before a complete message");
    message += decoder.decode(chunk.value, { stream: true });
  }
  return message.slice(0, message.indexOf("\n\n") + 2);
}

async function rawHttpRequestWithoutBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("GET response waited for request body"));
    }, 1_000);

    socket.on("connect", () => {
      socket.write(
        [
          "GET /probe/physical-action HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Content-Length: 32",
          "Connection: close",
          "",
          ""
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      clearTimeout(timeout);
      socket.end();
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

async function rawOversizedPostWithoutBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("oversized content-length was not pre-rejected"));
    }, 1_000);

    socket.on("connect", () => {
      socket.write(
        [
          "POST /probe/physical-action/arm HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Content-Length: 4097",
          "Connection: close",
          "",
          ""
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      clearTimeout(timeout);
      socket.end();
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

async function rawInvalidUtf8JsonPost(port: number): Promise<string> {
  const body = Buffer.from([
    ...Buffer.from("{\"actionType\":\"contact_open\",\"targetDeviceAlias\":\"dev_007\",\"secret\":\""),
    0xc3,
    0x28,
    ...Buffer.from("token-event_id:fingerprint:https://internal\"}")
  ]);
  return rawHttpRequest(
    port,
    [
      "POST /probe/physical-action/arm HTTP/1.1",
      "Host: 127.0.0.1",
      "Content-Type: application/json",
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      ""
    ].join("\r\n"),
    body
  );
}

async function rawHttpRequest(port: number, headers: string, body: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw request did not receive a response"));
    }, 1_000);

    socket.on("connect", () => {
      socket.write(headers);
      socket.write(body);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      clearTimeout(timeout);
      socket.end();
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

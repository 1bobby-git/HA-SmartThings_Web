import { describe, expect, test, vi } from "vitest";

import {
  SafeCommandService,
  type SafeCommandExecutor
} from "../../src/command/command-service.js";
import type { SanitizedCaptureRecord } from "../../src/state/capture-store.js";
import { DeviceStore } from "../../src/state/device-store.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";

describe("SafeCommandService", () => {
  test("confirms switch commands only after a newer matching push event", async () => {
    const store = readyDeviceStore();
    const executor: SafeCommandExecutor = {
      executeSwitch: vi.fn(async () => {
        store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z")));
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    const result = await service.execute(command("on", "request_001"));

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "confirmed",
      confirmation: "device_event",
      transport: "smartthings_web_ui"
    });
    expect(result.sequence).toBeGreaterThan(2);
    expect(executor.executeSwitch).toHaveBeenCalledWith({ deviceName: "Safe plug" });
  });

  test("deduplicates identical client request ids and rejects conflicting reuse", async () => {
    const store = readyDeviceStore();
    const executor: SafeCommandExecutor = {
      executeSwitch: vi.fn(async () => {
        store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z")));
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    const first = service.execute(command("on", "request_002"));
    const duplicate = service.execute(command("on", "request_002"));

    await expect(first).resolves.toEqual(await duplicate);
    expect(executor.executeSwitch).toHaveBeenCalledTimes(1);
    await expect(service.execute(command("off", "request_002"))).rejects.toMatchObject({
      code: "client_request_conflict"
    });
  });

  test("rejects disconnected, unknown, offline, and unsupported targets before UI interaction", async () => {
    const store = readyDeviceStore();
    const executor: SafeCommandExecutor = { executeSwitch: vi.fn(async () => undefined) };
    const disconnected = connectedStatus();
    disconnected.update({ state: "RECONNECTING", pushConnected: false });
    const service = new SafeCommandService({
      devices: store,
      status: disconnected,
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(command("on", "request_003"))).rejects.toMatchObject({
      code: "bridge_not_connected"
    });

    const connected = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });
    await expect(
      connected.execute({ ...command("on", "request_004"), deviceId: "dev_999" })
    ).rejects.toMatchObject({ code: "device_not_found" });
    await expect(
      connected.execute({ ...command("on", "request_005"), command: "unlock" })
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(executor.executeSwitch).not.toHaveBeenCalled();
  });

  test("times out without push confirmation and requests a full resync", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async () => undefined);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeSwitch: vi.fn(async () => undefined) },
      timeoutMs: 10,
      resync
    });

    await expect(service.execute(command("on", "request_006"))).rejects.toMatchObject({
      code: "command_confirmation_timeout"
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });
});

function command(value: "on" | "off", clientRequestId: string) {
  return {
    deviceId: "dev_001",
    component: "main",
    capability: "identifier_switch",
    command: value,
    arguments: [],
    clientRequestId
  };
}

function connectedStatus(): RuntimeStatusStore {
  const now = Date.now();
  return new RuntimeStatusStore({
    now: () => now,
    initial: {
      state: "CONNECTED",
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      parserHealthy: true,
      initialSnapshotComplete: true,
      dbAvailable: true,
      heartbeatAtMs: now
    }
  });
}

function readyDeviceStore(): DeviceStore {
  const store = new DeviceStore();
  store.observe(sent('421["find","api/device",{}]'));
  store.observe(
    received(
      '431[null,[{"basic":{"deviceId":"dev_001","locationId":"loc_001","deviceName":"Safe plug","deviceTypeData":{"type":"NONE"}}}]]'
    )
  );
  store.observe(sent('422["find","api/device/status",{}]'));
  store.observe(
    received(
      '432[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"off","unit":null,"timestamp":"2026-08-25T00:00:00Z"}]]'
    )
  );
  return store;
}

function deviceEventFrame(value: "on" | "off", eventTime: string): string {
  return `42${JSON.stringify([
    "api/subscription DEVICE_EVENT",
    {
      data: {
        event_type: "DEVICE_EVENT",
        event_time: eventTime,
        device_event: {
          device_id: "dev_001",
          location_id: "loc_001",
          component: "main",
          capability: "identifier_switch",
          attribute: "switch",
          value,
          unit: null
        }
      }
    }
  ])}`;
}

function sent(text: string): SanitizedCaptureRecord {
  return capture("sent", text);
}

function received(text: string): SanitizedCaptureRecord {
  return capture("received", text);
}

function capture(direction: "sent" | "received", text: string): SanitizedCaptureRecord {
  return {
    __sanitized: true,
    source: "playwright-websocket-frame",
    receivedAt: new Date().toISOString(),
    payload: { direction, frame: { payload: text, truncated: false } },
    payloadHash: "synthetic"
  };
}

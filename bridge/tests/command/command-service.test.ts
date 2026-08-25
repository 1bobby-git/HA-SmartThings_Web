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
      executeDeviceAction: vi.fn(async () => {
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
    expect(executor.executeDeviceAction).toHaveBeenCalledWith({
      action: "on",
      arguments: [],
      attribute: "switch",
      capability: "identifier_switch",
      command: "on",
      component: "main",
      deviceName: "Safe plug",
      locationId: "loc_001",
      locationNames: {}
    });
  });

  test("deduplicates identical client request ids and rejects conflicting reuse", async () => {
    const store = readyDeviceStore();
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => {
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
    expect(executor.executeDeviceAction).toHaveBeenCalledTimes(1);
    await expect(service.execute(command("off", "request_002"))).rejects.toMatchObject({
      code: "client_request_conflict"
    });
  });

  test("rejects disconnected, unknown, offline, and unsupported targets before UI interaction", async () => {
    const store = readyDeviceStore();
    const executor: SafeCommandExecutor = { executeDeviceAction: vi.fn(async () => undefined) };
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
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("times out without push confirmation and requests a full resync", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async () => undefined);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 10,
      resync
    });

    await expect(service.execute(command("on", "request_006"))).rejects.toMatchObject({
      code: "command_confirmation_timeout"
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("starts the confirmation timeout after browser interaction completes", async () => {
    vi.useFakeTimers();
    let finishInteraction: () => void = () => undefined;
    const interaction = new Promise<void>((resolve) => {
      finishInteraction = resolve;
    });
    const service = new SafeCommandService({
      devices: readyDeviceStore(),
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(() => interaction) },
      timeoutMs: 10,
      resync: vi.fn(async () => undefined)
    });

    try {
      const result = service.execute(command("on", "request_007"));
      let settled = false;
      void result.finally(() => {
        settled = true;
      }).catch(() => undefined);

      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      finishInteraction();
      await vi.advanceTimersByTimeAsync(11);
      await expect(result).rejects.toMatchObject({
        code: "command_confirmation_timeout"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("confirms number, media, and fan commands with exact newer state values", async () => {
    const store = readyDeviceStore();
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        if (input.command === "setNumber") {
          store.observe(received(deviceEventFrame(42, "2026-08-25T00:00:01Z", "detectionFrequency")));
        }
        if (input.command === "setVolume") {
          store.observe(received(deviceEventFrame(12, "2026-08-25T00:00:02Z", "volume")));
        }
        if (input.command === "mute") {
          store.observe(received(deviceEventFrame("muted", "2026-08-25T00:00:03Z", "mute")));
        }
        if (input.command === "setFanMode") {
          store.observe(received(deviceEventFrame("auto", "2026-08-25T00:00:04Z", "fanMode")));
        }
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("setNumber", "request_008", {
      attribute: "detectionFrequency",
      arguments: [42]
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setVolume", "request_009", {
      attribute: "volume",
      arguments: [12]
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("mute", "request_010", {
      attribute: "mute",
      arguments: []
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setFanMode", "request_011", {
      attribute: "fanMode",
      arguments: ["auto"]
    }))).resolves.toMatchObject({ status: "confirmed" });
  });

  test("rejects stale or wrong-device confirmations for generic device commands", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async () => undefined);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => {
          store.observe(received(deviceEventFrame(42, "2026-08-24T23:59:59Z", "detectionFrequency")));
          store.observe(received(deviceEventFrame(42, "2026-08-25T00:00:01Z", "detectionFrequency", "dev_999")));
        })
      },
      timeoutMs: 10,
      resync
    });

    await expect(service.execute(deviceCommand("setNumber", "request_012", {
      attribute: "detectionFrequency",
      arguments: [42]
    }))).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("confirms refresh without caller-supplied component metadata from any newer device state", async () => {
    const store = readyDeviceStore();
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => {
          store.observe(received(deviceEventFrame(31, "2026-08-25T00:00:01Z", "detectionFrequency")));
        })
      },
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute({
      targetType: "device",
      targetId: "dev_001",
      command: "refresh",
      arguments: [],
      clientRequestId: "request_018"
    })).resolves.toMatchObject({ status: "confirmed" });
  });

  test("executes scenes only after a newer device event in the same location", async () => {
    const store = readyDeviceStore();
    observeSceneSnapshot(store);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z")));
        })
      },
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_013"
    })).resolves.toMatchObject({ confirmation: "device_event" });
  });

  test("confirms location alarm commands from newer security arm-state inventory", async () => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeLocationAction: vi.fn(async () => {
          store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:01Z")));
        })
      },
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute({
      targetType: "location",
      targetId: "loc_001",
      command: "armAway",
      arguments: [],
      clientRequestId: "request_014"
    })).resolves.toMatchObject({ confirmation: "security_arm_state_event" });
  });

  test("validates generic command envelopes fail closed", async () => {
    const service = new SafeCommandService({
      devices: readyDeviceStore(),
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute({ ...command("on", "request_015"), secret: "x" })).rejects.toMatchObject({ code: "unknown_key" });
    await expect(service.execute(deviceCommand("setNumber", "request_016", { attribute: "detectionFrequency", arguments: ["42"] }))).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(service.execute({ targetType: "scene", targetId: "dev_001", command: "on", arguments: [], clientRequestId: "request_017" })).rejects.toMatchObject({ code: "unsupported_command" });
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

function deviceCommand(
  commandName: string,
  clientRequestId: string,
  overrides: { attribute: string; arguments: unknown[] }
) {
  return {
    targetType: "device",
    targetId: "dev_001",
    component: "main",
    capability: "identifier_switch",
    command: commandName,
    arguments: overrides.arguments,
    attribute: overrides.attribute,
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
  store.observe(sent('423["find","api/device/status",{}]'));
  store.observe(
    received(
      '433[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"detectionFrequency","value":30,"unit":null,"timestamp":"2026-08-25T00:00:00Z"},{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"volume","value":10,"unit":null,"timestamp":"2026-08-25T00:00:00Z"},{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"mute","value":"unmuted","unit":null,"timestamp":"2026-08-25T00:00:00Z"},{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"fanMode","value":"normal","unit":null,"timestamp":"2026-08-25T00:00:00Z"}]]'
    )
  );
  return store;
}

function deviceEventFrame(
  value: unknown,
  eventTime: string,
  attribute = "switch",
  deviceId = "dev_001"
): string {
  return `42${JSON.stringify([
    "api/subscription DEVICE_EVENT",
    {
      data: {
        event_type: "DEVICE_EVENT",
        event_time: eventTime,
        device_event: {
          device_id: deviceId,
          location_id: "loc_001",
          component: "main",
          capability: "identifier_switch",
          attribute,
          value,
          unit: null
        }
      }
    }
  ])}`;
}

function observeSceneSnapshot(store: DeviceStore): void {
  store.observe(sent('422["find","api/scene",{}]'));
  store.observe(
    received(
      '432[null,[{"sceneId":"identifier_scene001","locationId":"loc_001","name":"Movie","updatedAt":"2026-08-25T00:00:00Z"}]]'
    )
  );
}

function observeLocationSnapshot(store: DeviceStore, armState: string, updatedAt: string): void {
  store.observe(sent('4225["find","api/location",{}]'));
  store.observe(
    received(
      `4325[null,[{"locationId":"loc_001","name":"Home","armState":${JSON.stringify(armState)},"updatedAt":${JSON.stringify(updatedAt)}}]]`
    )
  );
}

function securityEventFrame(armState: string, eventTime: string): string {
  return `42${JSON.stringify([
    "api/subscription SECURITY_ARM_STATE_EVENT",
    {
      data: {
        location_id: "loc_001",
        arm_state: armState,
        event_time: eventTime
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
    payloadHash: `${direction}:${text}`
  };
}

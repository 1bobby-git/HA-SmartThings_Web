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

  test("does not confirm a transient state that reverses before browser interaction completes", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async () => undefined);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => {
        store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z")));
        store.observe(received(deviceEventFrame("off", "2026-08-25T00:00:02Z")));
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 10,
      resync
    });

    await expect(service.execute(command("on", "request_030"))).rejects.toMatchObject({
      code: "command_confirmation_timeout"
    });
    expect(resync).toHaveBeenCalledTimes(1);
    expect(
      store.snapshot().devices[0]?.states.find((state) => state.attribute === "switch")?.value
    ).toBe("off");
  });

  test("requires the requested push state to remain stable after browser interaction", async () => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    const resync = vi.fn(async () => undefined);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => {
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z")));
        })
      },
      timeoutMs: 1_000,
      confirmationStabilityMs: 500,
      resync
    });

    try {
      const result = service.execute(command("on", "request_031"));
      const rejected = expect(result).rejects.toMatchObject({
        code: "command_confirmation_timeout"
      });
      await vi.advanceTimersByTimeAsync(100);
      store.observe(received(deviceEventFrame("off", "2026-08-25T00:00:02Z")));
      await vi.advanceTimersByTimeAsync(901);

      await rejected;
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not let timeout resync bypass the configured stability window", async () => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    const resync = vi.fn(async () => {
      store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z")));
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 1_000,
      confirmationStabilityMs: 500,
      resync
    });

    try {
      const result = service.execute(command("on", "request_032"));
      const rejected = expect(result).rejects.toMatchObject({
        code: "command_confirmation_timeout"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      store.observe(received(deviceEventFrame("off", "2026-08-25T00:00:02Z")));
      await vi.advanceTimersByTimeAsync(500);

      await rejected;
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("binds switch commands to the matching observed toggle control", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_toggle001",
        label: "Secondary outlet",
        commands: ["on", "off"]
      })
    ]);
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

    await expect(service.execute(command("on", "request_028"))).resolves.toMatchObject({
      status: "confirmed"
    });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(expect.objectContaining({
      controlId: "identifier_toggle001",
      controlLabel: "Secondary outlet"
    }));
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

  test("accepts the requested switch state from the timeout full snapshot resync", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async () => {
      store.observe(sent('429["find","api/device/status",{}]'));
      store.observe(
        received(
          '439[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"on","unit":null,"timestamp":"2026-08-25T00:00:02Z"}]]'
        )
      );
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 10,
      resync
    });

    await expect(service.execute(command("on", "request_029"))).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "inventory_snapshot"
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
    observeDeviceDetails(store, [
      detailSwatch("SLIDER", "slider", {
        swatchId: "identifier_frequency",
        label: "Detection frequency",
        attributeName: "detectionFrequency",
        min: 0,
        max: 3600
      }),
      detailSwatch("SLIDER", "slider", {
        swatchId: "identifier_percent",
        label: "Percent",
        attributeName: "percent",
        min: 0,
        max: 100
      }),
      detailSwatch("SLIDER", "slider", {
        swatchId: "identifier_volume",
        label: "Volume",
        attributeName: "volume",
        min: 0,
        max: 100
      }),
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_mute",
        label: "Mute",
        attributeName: "mute",
        commands: ["mute", "unmute"]
      }),
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_fan_mode",
        label: "Fan mode",
        attributeName: "fanMode",
        options: ["normal", "auto"]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        if (input.command === "setNumber") {
          const attribute = input.attribute === "percent" ? "percent" : "detectionFrequency";
          const value = input.attribute === "percent" ? 55 : 42;
          store.observe(received(deviceEventFrame(value, "2026-08-25T00:00:01Z", attribute)));
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
      arguments: [42],
      controlId: "identifier_frequency"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setNumber", "request_008b", {
      attribute: "percent",
      arguments: [55],
      controlId: "identifier_percent"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setVolume", "request_009", {
      attribute: "volume",
      arguments: [12],
      controlId: "identifier_volume"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("mute", "request_010", {
      attribute: "mute",
      arguments: [],
      controlId: "identifier_mute"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setFanMode", "request_011", {
      attribute: "fanMode",
      arguments: ["auto"],
      controlId: "identifier_fan_mode"
    }))).resolves.toMatchObject({ status: "confirmed" });
  });

  test("requires and executes the exact observed playback control", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_play",
        label: "Play",
        capabilityId: "identifier_mediaPlayback",
        attributeName: "playbackStatus",
        commands: ["play"]
      }),
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_track",
        label: "Track control",
        capabilityId: "identifier_mediaTrackControl",
        attributeName: "supportedTrackControlCommands",
        possibleStates: [
          { status: "next", label: "Next track", command: "nextTrack" }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        if (input.command === "play") {
          store.observe(received(deviceEventFrame(
            "playing",
            "2026-08-25T00:00:01Z",
            "playbackStatus",
            "dev_001",
            "identifier_mediaPlayback"
          )));
        }
        if (input.command === "nextTrack") {
          store.observe(received(deviceEventFrame(
            { title: "Next" },
            "2026-08-25T00:00:02Z",
            "audioTrackData",
            "dev_001",
            "identifier_mediaTrackControl"
          )));
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

    await expect(service.execute(deviceCommand("play", "request_play_001", {
      attribute: "playbackStatus",
      arguments: [],
      controlId: "identifier_play",
      controlLabel: "Play",
      capability: "identifier_mediaPlayback"
    }))).resolves.toMatchObject({ status: "confirmed" });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(expect.objectContaining({
      command: "play",
      controlId: "identifier_play",
      controlLabel: "Play"
    }));

    await expect(service.execute(deviceCommand("nextTrack", "request_track_001", {
      attribute: "supportedTrackControlCommands",
      arguments: [],
      controlId: "identifier_track",
      controlLabel: "Track control",
      capability: "identifier_mediaTrackControl"
    }))).resolves.toMatchObject({ status: "confirmed" });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(expect.objectContaining({
      command: "nextTrack",
      controlId: "identifier_track",
      optionLabel: "Next track",
      optionCommand: "nextTrack"
    }));

    await expect(service.execute(deviceCommand("play", "request_play_002", {
      attribute: "playbackStatus",
      arguments: [],
      capability: "identifier_mediaPlayback"
    }))).rejects.toMatchObject({ code: "invalid_control_id" });
  });

  test("requires observed enumerated controls and exact option pushes for setOption", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enum001",
        label: "Mode",
        attributeName: "mode",
        command: "setMode",
        options: ["eco", "auto"]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => {
        store.observe(received(deviceEventFrame("eco", "2026-08-25T00:00:01Z", "mode")));
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("setOption", "request_021", {
      attribute: "mode",
      arguments: ["eco"],
      controlId: "identifier_enum001",
      controlLabel: "Mode"
    }))).resolves.toMatchObject({ status: "confirmed" });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(expect.objectContaining({
      command: "setOption",
      controlId: "identifier_enum001",
      controlLabel: "Mode",
      attribute: "mode"
    }));

    await expect(service.execute(deviceCommand("setOption", "request_022", {
      attribute: "mode",
      arguments: ["away"],
      controlId: "identifier_enum001"
    }))).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(service.execute(deviceCommand("setOption", "request_023", {
      attribute: "mode",
      arguments: ["eco"]
    }))).rejects.toMatchObject({ code: "invalid_control_id" });
  });

  test("uses possibleStates status for setOption confirmation and passes observed label and command to the executor", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enum002",
        label: "Mode",
        attributeName: "mode",
        possibleStates: [
          { status: "cool", label: "Cooling", command: "setCool" },
          { status: "windFree", label: "Wind free", command: "setMode" }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        expect(input.optionLabel).toBe("Wind free");
        expect(input.optionCommand).toBe("setMode");
        store.observe(received(deviceEventFrame("windFree", "2026-08-25T00:00:01Z", "mode")));
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("setOption", "request_028", {
      attribute: "mode",
      arguments: ["windFree"],
      controlId: "identifier_enum002"
    }))).resolves.toMatchObject({ status: "confirmed" });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(expect.objectContaining({
      command: "setOption",
      arguments: ["windFree"],
      optionLabel: "Wind free",
      optionCommand: "setMode"
    }));

    await expect(service.execute({
      ...deviceCommand("setOption", "request_029", {
        attribute: "mode",
        arguments: ["windFree"],
        controlId: "identifier_enum002"
      }),
      optionLabel: "Injected"
    })).rejects.toMatchObject({ code: "unknown_key" });
  });

  test("passes observed possibleStates mapping for a control-bound fan mode", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enumfan",
        label: "Fan mode",
        attributeName: "fanMode",
        possibleStates: [
          { status: "auto", label: "Auto", command: "setAuto" },
          { status: "sleep", label: "Sleep", command: "setSleep" }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        expect(input.optionLabel).toBe("Sleep");
        expect(input.optionCommand).toBe("setSleep");
        store.observe(received(deviceEventFrame("sleep", "2026-08-25T00:00:01Z", "fanMode")));
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("setFanMode", "request_030", {
      attribute: "fanMode",
      arguments: ["sleep"],
      controlId: "identifier_enumfan"
    }))).resolves.toMatchObject({ status: "confirmed" });
  });

  test("executes only observed cover controls and confirms matching newer state", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_open001",
        label: "Open shade",
        attributeName: "windowShade",
        commands: ["openShade"]
      }),
      detailSwatch("SLIDER", "slider", {
        swatchId: "identifier_position001",
        label: "Shade level",
        attributeName: "shadeLevel",
        command: "setPosition",
        min: 0,
        max: 100,
        step: 1
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        if (input.command === "openShade") {
          store.observe(received(deviceEventFrame("open", "2026-08-25T00:00:01Z", "windowShade")));
        }
        if (input.command === "setPosition") {
          store.observe(received(deviceEventFrame(45, "2026-08-25T00:00:02Z", "shadeLevel")));
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

    await expect(service.execute(deviceCommand("openShade", "request_024", {
      attribute: "windowShade",
      arguments: [],
      controlId: "identifier_open001"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setPosition", "request_025", {
      attribute: "shadeLevel",
      arguments: [45],
      controlId: "identifier_position001"
    }))).resolves.toMatchObject({ status: "confirmed" });

    await expect(service.execute(deviceCommand("setPosition", "request_026", {
      attribute: "shadeLevel",
      arguments: [150],
      controlId: "identifier_position001"
    }))).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  test("rejects dangerous cover-shaped commands even when a control is observed", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_lock001",
        label: "Open door lock",
        capabilityId: "lock",
        attributeName: "lock",
        commands: ["open"]
      })
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("open", "request_027", {
      attribute: "lock",
      arguments: [],
      controlId: "identifier_lock001",
      capability: "lock"
    }))).rejects.toMatchObject({ code: "unsupported_command" });
  });

  test.each([
    ["doorLock", "Door lock"],
    ["lockState", "Lock state"],
    ["garageDoor", "Garage door"],
    ["valveState", "Valve state"],
    ["safeToggle", "문 열기"],
    ["safeToggle", "밸브 제어"]
  ])("rejects dangerous compound or localized controls: %s / %s", async (attribute, label) => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_danger001",
        label,
        capabilityId: "identifier_capability_custom",
        attributeName: attribute,
        commands: ["press"]
      })
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("press", "request_027b", {
      attribute,
      arguments: [],
      controlId: "identifier_danger001",
      capability: "identifier_capability_custom"
    }))).rejects.toMatchObject({ code: "unsupported_command" });
  });

  test("rejects stale or wrong-device confirmations for generic device commands", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("SLIDER", "slider", {
        swatchId: "identifier_frequency_stale",
        label: "Detection frequency",
        attributeName: "detectionFrequency",
        min: 0,
        max: 3600
      })
    ]);
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
      arguments: [42],
      controlId: "identifier_frequency_stale"
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
    await expect(service.execute(deviceCommand("setNumber", "request_019", { attribute: "switch", arguments: [42] }))).rejects.toMatchObject({ code: "unsupported_command" });
    await expect(service.execute(deviceCommand("setFanMode", "request_020", { attribute: "temperature", arguments: ["auto"] }))).rejects.toMatchObject({ code: "unsupported_command" });
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
  overrides: { attribute: string; arguments: unknown[]; controlId?: string; controlLabel?: string; capability?: string }
) {
  return {
    targetType: "device",
    targetId: "dev_001",
    component: "main",
    capability: overrides.capability ?? "identifier_switch",
    command: commandName,
    arguments: overrides.arguments,
    attribute: overrides.attribute,
    ...(overrides.controlId ? { controlId: overrides.controlId } : {}),
    ...(overrides.controlLabel ? { controlLabel: overrides.controlLabel } : {}),
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

function observeDeviceDetails(store: DeviceStore, rows: Record<string, unknown>[]): void {
  store.observe(sent('424["get","api/device","identifier_rawdevice",{}]'));
  store.observe(received(`434${JSON.stringify([null, { data: rows }])}`));
}

function detailSwatch(
  type: string,
  key: string,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  return {
    type,
    [key]: {
      deviceId: "dev_001",
      locationId: "loc_001",
      componentId: "main",
      capabilityId: "identifier_switch",
      attributeName: "switch",
      label: "Control",
      ...overrides
    }
  };
}

function deviceEventFrame(
  value: unknown,
  eventTime: string,
  attribute = "switch",
  deviceId = "dev_001",
  capability = "identifier_switch"
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
          capability,
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

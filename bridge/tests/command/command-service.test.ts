import { describe, expect, test, vi } from "vitest";

import {
  SafeCommandService,
  type ComponentTransactionExecutionInput,
  type CommandResyncEvidence,
  type DeviceActionExecutionInput,
  type SafeCommandExecutor
} from "../../src/command/command-service.js";
import type { SanitizedCaptureRecord } from "../../src/state/capture-store.js";
import { DeviceStore, type BridgeStateSource } from "../../src/state/device-store.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";

describe("SafeCommandService", () => {
  test("uses a component transaction for a multi-switch aggregate", async () => {
    const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
    fixture.resync.mockImplementationOnce(async () => {
      fixture.setSwitchStates("off");
      return deviceStatusEvidence();
    });

    const result = await fixture.service.execute(aggregateCommand("off", "request_multi_switch_off"));

    expect(fixture.executeDeviceAction).not.toHaveBeenCalled();
    expect(fixture.executeComponentTransaction).toHaveBeenCalledOnce();
    expect(fixture.executeComponentTransaction.mock.calls[0]?.[0].actions.map(
      (action) => action.component
    )).toEqual([
      "identifier_main",
      "identifier_switch2",
      "identifier_switch3",
      "identifier_switch4"
    ]);
    expect(fixture.executeComponentTransaction.mock.calls[0]?.[0].rollbackActions.every(
      (action) => action.command === "on"
    )).toBe(true);
    expect(result).toMatchObject({
      status: "confirmed",
      confirmation: "inventory_snapshot",
      transport: "advanced",
      lifecycle: "CONFIRMED_BY_STATUS"
    });
  });

  test("keeps consecutive composite commands on their matched child devices", async () => {
    const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
    const mapped = configureChildMappedSwitch(fixture.store);
    let resyncState: "on" | "off" = "off";
    fixture.executeDeviceAction.mockResolvedValue({
      state: "ACCEPTED",
      transport: "location_native",
      acceptedAtMs: Date.now()
    });
    fixture.resync.mockImplementation(async (request) => {
      if (request?.deviceId === "dev_001") mapped.setParentStates(resyncState);
      else if (request?.deviceId) mapped.setChildState(request.deviceId, resyncState);
      return deviceStatusEvidence();
    });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_child_mapped_off"))
    ).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "inventory_snapshot",
      transport: "location_native"
    });

    expect(fixture.executeDeviceAction.mock.calls.map(([action]) => action.deviceId)).toEqual([
      "dev_145",
      "dev_116",
      "dev_117"
    ]);
    expect(fixture.executeDeviceAction.mock.calls.every(([action]) => action.component === "identifier_main")).toBe(
      true
    );
    expect(fixture.executeDeviceAction.mock.calls.every(([action]) => action.command === "off")).toBe(true);
    expect(
      fixture.executeDeviceAction.mock.calls.every(
        ([action]) => action.requireLocationNative === true
      )
    ).toBe(true);
    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();
    expect(
      fixture.resync.mock.calls.map(([request]) => request?.deviceId).sort()
    ).toEqual(["dev_001", "dev_116", "dev_117", "dev_145"]);

    resyncState = "on";
    fixture.executeDeviceAction.mockClear();
    fixture.executeComponentTransaction.mockClear();
    fixture.resync.mockClear();
    await expect(
      fixture.service.execute(aggregateCommand("on", "request_child_route_again"))
    ).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "inventory_snapshot",
      transport: "location_native"
    });
    expect(fixture.executeDeviceAction.mock.calls.map(([action]) => action.deviceId)).toEqual([
      "dev_145",
      "dev_116",
      "dev_117"
    ]);
    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();
  });

  test("rolls back completed child Web commands after partial failure", async () => {
    const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
    configureChildMappedSwitch(fixture.store);
    fixture.executeDeviceAction.mockImplementation(async (action) => {
      if (action.deviceId === "dev_116" && action.command === "off") {
        throw new Error("child web failure");
      }
      return {
        state: "ACCEPTED" as const,
        transport: "location_native" as const,
        acceptedAtMs: Date.now()
      };
    });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_child_web_rollback"))
    ).rejects.toMatchObject({ code: "component_command_partial_failure" });
    expect(
      fixture.executeDeviceAction.mock.calls.map(([action]) => [
        action.deviceId,
        action.command
      ])
    ).toEqual([
      ["dev_145", "off"],
      ["dev_116", "off"],
      ["dev_145", "on"]
    ]);
    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();
    expect(fixture.resync).not.toHaveBeenCalled();
  });

  test.each([
    ["ambiguous mapping", { ambiguous: true }],
    ["multiple scored mappings", { scoredAmbiguous: true }],
    ["offline child", { offlineChildId: "dev_116" }],
    ["dangerous child", { dangerousChildId: "dev_116" }],
    ["missing child capability version", { missingVersionChildId: "dev_116" }],
    ["invalid parent timestamp", { invalidParentTimestamp: true }],
    ["invalid child timestamp", { invalidChildTimestampId: "dev_116" }]
  ])("fails closed without parent fallback for %s", async (_name, options) => {
    const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
    configureChildMappedSwitch(fixture.store, options);

    await expect(
      fixture.service.execute(aggregateCommand("off", `request_${_name.replaceAll(" ", "_")}`))
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(fixture.executeDeviceAction).not.toHaveBeenCalled();
    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();
    expect(fixture.resync).not.toHaveBeenCalled();
  });

  test("waits for a final Advanced status refresh before rollback", async () => {
    const fixture = multiSwitchFixture(["main", "switch2"]);
    fixture.resync
      .mockImplementationOnce(async () => ({
        source: "advanced_device_status",
        authoritativeSnapshot: false,
        startedAtMs: Date.now()
      }))
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates("off");
        return deviceStatusEvidence();
      });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_delayed_status"))
    ).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "inventory_snapshot",
      transport: "advanced"
    });
    expect(fixture.resync).toHaveBeenCalledTimes(2);
    expect(fixture.executeComponentTransaction).toHaveBeenCalledOnce();
  });

  test("requires device-status source evidence for component confirmation", async () => {
    const fixture = multiSwitchFixture(["main", "switch2"]);
    fixture.resync
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates("off");
        return inventoryEvidence();
      })
      .mockImplementationOnce(async () => deviceStatusEvidence());

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_status_source"))
    ).resolves.toMatchObject({ status: "confirmed", transport: "advanced" });
    expect(fixture.resync).toHaveBeenCalledTimes(2);
  });

  test("does not confirm a matching event vector when Advanced status reads fail", async () => {
    const fixture = multiSwitchFixture(["main", "switch2"]);
    fixture.executeComponentTransaction.mockImplementationOnce(async (input) => {
      fixture.setSwitchStates("off", "LOCATION_EVENT");
      return advancedReceipts(input.actions.length);
    });
    fixture.resync
      .mockRejectedValueOnce(new Error("private status failure"))
      .mockRejectedValueOnce(new Error("private status failure"))
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates("on");
        return deviceStatusEvidence();
      });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_event_without_status"))
    ).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(fixture.executeComponentTransaction).toHaveBeenCalledTimes(2);
  });

  test("bounds a hanging early Advanced status refresh", async () => {
    vi.useFakeTimers();
    try {
      const fixture = multiSwitchFixture(["main", "switch2"]);
      fixture.resync.mockImplementationOnce(
        async () => await new Promise<CommandResyncEvidence>(() => undefined)
      );

      const result = fixture.service.execute(
        aggregateCommand("off", "request_hanging_component_status")
      );
      const rejection = expect(result).rejects.toMatchObject({
        code: "command_confirmation_timeout"
      });
      await vi.advanceTimersByTimeAsync(21);

      await rejection;
      expect(fixture.executeComponentTransaction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rolls back when Advanced status does not confirm every component", async () => {
    const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
    fixture.resync
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates({ main: "off", switch2: "off", switch3: "off", switch4: "on" });
        return deviceStatusEvidence();
      })
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates("on");
        return deviceStatusEvidence();
      });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_multi_rollback"))
    ).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(fixture.executeComponentTransaction).toHaveBeenCalledTimes(2);
    expect(fixture.executeComponentTransaction.mock.calls[1]?.[0].actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "identifier_main", command: "on" }),
        expect.objectContaining({ component: "identifier_switch4", command: "on" })
      ])
    );
    expect(fixture.executeComponentTransaction.mock.calls[1]?.[0].rollbackActions.every(
      (action) => action.command === "on"
    )).toBe(true);
  });

  test("reports an explicit failure when the original component vector is not restored", async () => {
    const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
    fixture.resync
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates({ main: "off", switch2: "off", switch3: "off", switch4: "on" });
        return deviceStatusEvidence();
      })
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates({ main: "on", switch2: "on", switch3: "off", switch4: "on" });
        return deviceStatusEvidence();
      });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_rollback_failed"))
    ).rejects.toMatchObject({ code: "component_command_rollback_failed" });
  });

  test("rolls back when the first Advanced status refresh fails", async () => {
    const fixture = multiSwitchFixture(["main", "switch2"]);
    fixture.resync
      .mockRejectedValueOnce(new Error("private Advanced status detail"))
      .mockImplementationOnce(async () => {
        fixture.setSwitchStates("on");
        return deviceStatusEvidence();
      });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_status_failure"))
    ).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(fixture.executeComponentTransaction).toHaveBeenCalledTimes(2);
  });

  test("preserves a fixed component partial-failure code from the executor", async () => {
    const fixture = multiSwitchFixture(["main", "switch2"]);
    fixture.executeComponentTransaction.mockRejectedValueOnce(
      new Error("component_command_partial_failure")
    );

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_component_partial"))
    ).rejects.toMatchObject({ code: "component_command_partial_failure" });
    expect(fixture.resync).not.toHaveBeenCalled();
  });

  test("keeps single-component devices on the verified Web path", async () => {
    const fixture = multiSwitchFixture(["main"]);

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_single_switch"))
    ).resolves.toMatchObject({ status: "confirmed", confirmation: "device_event" });
    expect(fixture.executeDeviceAction).toHaveBeenCalledOnce();
    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();
  });

  test("keeps the verified Web path when any component capability version is missing", async () => {
    const fixture = multiSwitchFixture(["main", "switch2"], { includeVersions: false });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_missing_version"))
    ).resolves.toMatchObject({ status: "confirmed", confirmation: "device_event" });
    expect(fixture.executeDeviceAction).toHaveBeenCalledOnce();
    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();
  });

  test("rejects dangerous multi-component device types", async () => {
    const fixture = multiSwitchFixture(["main", "switch2"], { deviceType: "door lock" });

    await expect(
      fixture.service.execute(aggregateCommand("off", "request_dangerous_multi"))
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(fixture.executeDeviceAction).not.toHaveBeenCalled();
    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();
  });

  test("returns the transport receipt for an explicitly unconfirmed stateful command", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async () => undefined);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => ({
          state: "ACCEPTED" as const,
          transport: "advanced" as const,
          acceptedAtMs: Date.now()
        }))
      },
      timeoutMs: 1_000,
      resync
    });

    await expect(
      service.execute({
        ...command("on", "request_no_confirm"),
        confirm: false,
        timeout: 25
      })
    ).resolves.toMatchObject({
      status: "accepted_unconfirmed",
      confirmation: "accepted_receipt",
      transport: "advanced"
    });
    expect(resync).not.toHaveBeenCalled();
  });

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
      controlId: "identifier_toggle_power",
      controlLabel: "Power",
      deviceId: "dev_001",
      deviceName: "Safe plug",
      locationId: "loc_001",
      locationNames: {},
      nativeCommand: "on"
    });
  });

  test("rejects a matching state event when both command IDs exist and differ", async () => {
    const store = readyDeviceStore();
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => {
          store.observe(
            received(
              deviceEventFrame(
                "on",
                "2026-08-25T00:00:01Z",
                "switch",
                "dev_001",
                "identifier_switch",
                "other-command"
              )
            )
          );
          return {
            state: "ACCEPTED" as const,
            transport: "advanced" as const,
            acceptedAtMs: Date.now(),
            commandId: "expected-command"
          };
        })
      },
      timeoutMs: 10,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(command("on", "request_command_id"))).rejects.toMatchObject({
      code: "command_confirmation_timeout"
    });
  });

  test("rejects a matching event that occurred before the Advanced command was sent", async () => {
    const store = readyDeviceStore();
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => {
          store.observe(
            received(
              deviceEventFrame("on", "2026-08-25T00:00:01Z")
            )
          );
          return {
            state: "ACCEPTED" as const,
            transport: "advanced" as const,
            sentAtMs: Date.parse("2026-08-25T00:00:02Z"),
            acceptedAtMs: Date.parse("2026-08-25T00:00:03Z")
          };
        })
      },
      timeoutMs: 10,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(command("on", "request_pre_send_event"))).rejects.toMatchObject({
      code: "command_confirmation_timeout"
    });
  });

  test("confirms numeric state with bounded device rounding tolerance", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("SLIDER", "slider", {
        swatchId: "identifier_level_tolerance",
        attributeName: "level",
        capabilityId: "identifier_switchLevel",
        min: 0,
        max: 100,
      }),
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => {
          store.observe(
            received(
              deviceEventFrame(
                70.00005,
                "2026-08-25T00:00:01Z",
                "level",
                "dev_001",
                "identifier_switchLevel"
              )
            )
          );
        }),
      },
      timeoutMs: 20,
      resync: vi.fn(async () => undefined),
    });

    await expect(
      service.execute(
        deviceCommand("setNumber", "request_numeric_tolerance", {
          attribute: "level",
          arguments: [70],
          capability: "identifier_switchLevel",
          controlId: "identifier_level_tolerance",
        })
      )
    ).resolves.toMatchObject({ status: "confirmed" });
  });

  test("dispatches a descriptor-backed accepted-receipt TTS command through Advanced only", async () => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_speechSynthesis", "speak", {
        confirmation: "accepted_receipt",
        arguments: [
          {
            name: "phrase",
            required: true,
            sensitive: false,
            schema: { type: "string" }
          }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => ({
        state: "ACCEPTED" as const,
        transport: "advanced" as const,
        acceptedAtMs: Date.now()
      }))
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_speechSynthesis",
        command: "speak",
        arguments: ["hello from catalog"],
        requireAdvanced: true,
        clientRequestId: "request_tts_catalog"
      })
    ).resolves.toMatchObject({
      status: "accepted_unconfirmed",
      confirmation: "accepted_receipt",
      lifecycle: "ACCEPTED_UNCONFIRMED",
      transport: "advanced"
    });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(
      expect.objectContaining({
        requireAdvanced: true,
        capabilityVersion: 1,
        command: "speak",
        arguments: ["hello from catalog"]
      })
    );
  });

  test("rejects token-safe arbitrary commands without an exact persisted descriptor", async () => {
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const service = new SafeCommandService({
      devices: readyDeviceStore(),
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_switch",
        attribute: "detectionFrequency",
        command: "setDetectionFrequency",
        arguments: [42],
        clientRequestId: "request_dynamic_schema_closed"
      })
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test.each([
    ["missing required phrase", [], "invalid_arguments"],
    ["wrong phrase type", [42], "invalid_arguments"],
    ["control characters", ["bad\nphrase"], "invalid_arguments"],
    ["oversize phrase", ["x".repeat(2049)], "invalid_arguments"]
  ] as const)("rejects descriptor TTS arguments with %s", async (_name, args, code) => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_speechSynthesis", "speak", {
        confirmation: "accepted_receipt",
        arguments: [
          {
            name: "phrase",
            required: true,
            sensitive: false,
            schema: { type: "string" }
          }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_speechSynthesis",
        command: "speak",
        arguments: args,
        clientRequestId: `request_tts_${_name.replaceAll(" ", "_")}`
      })
    ).rejects.toMatchObject({ code });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("rejects a missing positional required descriptor argument after an optional argument", async () => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_speechSynthesis", "speak", {
        confirmation: "accepted_receipt",
        arguments: [
          {
            name: "mode",
            required: false,
            sensitive: false,
            schema: { type: "string" }
          },
          {
            name: "phrase",
            required: true,
            sensitive: false,
            schema: { type: "string" }
          }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_speechSynthesis",
        command: "speak",
        arguments: ["auto"],
        clientRequestId: "request_positional_required"
      })
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test.each([
    ["boolean", { type: "boolean" }, [true]],
    ["array", { type: "array" }, [["eco", "sleep"]]],
    ["object", { type: "object" }, [{ mode: "eco" }]]
  ] as const)("accepts descriptor %s arguments", async (_name, schema, args) => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_customCapability", "setCustomValue", {
        confirmation: "accepted_receipt",
        arguments: [
          {
            name: "value",
            required: true,
            sensitive: false,
            schema
          }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => ({
        state: "ACCEPTED" as const,
        transport: "advanced" as const,
        acceptedAtMs: Date.now()
      }))
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_customCapability",
        command: "setCustomValue",
        arguments: args,
        clientRequestId: `request_descriptor_accepts_${_name}`
      })
    ).resolves.toMatchObject({ status: "accepted_unconfirmed", transport: "advanced" });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(
      expect.objectContaining({ requireAdvanced: true, arguments: args })
    );
  });

  test.each([
    ["boolean rejects string", { type: "boolean" }, ["true"]],
    ["array rejects object", { type: "array" }, [{ value: "eco" }]],
    ["object rejects array", { type: "object" }, [["eco"]]],
    ["extra argument", { type: "boolean" }, [true, false]]
  ] as const)("rejects descriptor %s", async (_name, schema, args) => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_customCapability", "setCustomValue", {
        confirmation: "accepted_receipt",
        arguments: [
          {
            name: "value",
            required: true,
            sensitive: false,
            schema
          }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_customCapability",
        command: "setCustomValue",
        arguments: args,
        clientRequestId: `request_descriptor_rejects_${_name.replaceAll(" ", "_")}`
      })
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("rejects cyclic descriptor arguments before dispatch", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_customCapability", "setCustomValue", {
        confirmation: "accepted_receipt",
        arguments: [
          {
            name: "value",
            required: true,
            sensitive: false,
            schema: { type: "object" }
          }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_customCapability",
        command: "setCustomValue",
        arguments: [cyclic],
        clientRequestId: "request_descriptor_cyclic"
      })
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("rejects descriptor argument payloads over the JSON byte bound before dispatch", async () => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_customCapability", "setCustomValue", {
        confirmation: "accepted_receipt",
        arguments: [
          {
            name: "value",
            required: true,
            sensitive: false,
            schema: { type: "array" }
          }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_customCapability",
        command: "setCustomValue",
        arguments: [[("x").repeat(16_385)]],
        clientRequestId: "request_descriptor_oversize_payload"
      })
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test.each([
    ["enum mismatch", "setMode", ["away"], { type: "string", enum: ["eco", "auto"] }],
    ["number below minimum", "setLevel", [-1], { type: "number", minimum: 0, maximum: 100 }],
    ["integer above maximum", "setLevel", [101], { type: "integer", minimum: 0, maximum: 100 }]
  ])("rejects descriptor arguments with %s", async (_name, commandName, args, schema) => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_switchLevel", commandName, {
        arguments: [
          {
            name: "value",
            required: true,
            sensitive: false,
            schema: schema as Parameters<DeviceStore["observeAdvancedCommandCatalog"]>[1][number]["arguments"][number]["schema"]
          }
        ]
      })
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_switchLevel",
        attribute: "level",
        command: commandName,
        arguments: args,
        clientRequestId: `request_descriptor_${_name.replaceAll(" ", "_")}`
      })
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  test("rejects ambiguous descriptor matches before dispatch", async () => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_speechSynthesis", "speak", {
        label: "Speak phrase",
        confirmation: "accepted_receipt",
        arguments: [
          { name: "phrase", required: true, sensitive: false, schema: { type: "string" } }
        ]
      }),
      advancedCommand("identifier_speechSynthesis", "speak", {
        label: "Speak mode",
        confirmation: "accepted_receipt",
        arguments: [
          { name: "mode", required: true, sensitive: false, schema: { type: "string" } }
        ]
      })
    ]);
    const executor: SafeCommandExecutor = { executeDeviceAction: vi.fn(async () => undefined) };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_speechSynthesis",
        command: "speak",
        arguments: ["hello"],
        clientRequestId: "request_ambiguous_advanced"
      })
    ).rejects.toMatchObject({ code: "command_control_ambiguous" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("rejects a state descriptor when no existing state can verify the desired value", async () => {
    const store = readyDeviceStore();
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_audioNotification", "playTrackAndRestore")
    ]);
    const executor: SafeCommandExecutor = { executeDeviceAction: vi.fn(async () => undefined) };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        targetType: "device",
        targetId: "dev_001",
        component: "main",
        capability: "identifier_audioNotification",
        command: "playTrackAndRestore",
        arguments: [],
        clientRequestId: "request_state_without_state"
      })
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("confirms descriptor-backed Advanced toggle commands with existing state", async () => {
    const store = readyDeviceStore(false);
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_switch", "on"),
      advancedCommand("identifier_switch", "off")
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        store.observe(received(deviceEventFrame(
          input.command,
          input.command === "on" ? "2026-08-25T00:00:01Z" : "2026-08-25T00:00:02Z"
        )));
        return {
          state: "ACCEPTED" as const,
          transport: "advanced" as const,
          acceptedAtMs: Date.now()
        };
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(command("on", "request_advanced_toggle_on"))).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "device_event",
      transport: "advanced"
    });
    expect(executor.executeDeviceAction).toHaveBeenCalledWith(
      expect.objectContaining({ requireAdvanced: true, command: "on" })
    );

    await expect(service.execute(command("off", "request_advanced_toggle_off"))).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "device_event",
      transport: "advanced"
    });
  });

  test("requireAdvanced rejects on/off toggles without an exact Advanced descriptor", async () => {
    const store = readyDeviceStore(true);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => ({
        state: "ACCEPTED" as const,
        transport: "advanced" as const,
        acceptedAtMs: Date.now()
      }))
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        ...command("on", "request_require_advanced_toggle_no_descriptor"),
        requireAdvanced: true
      })
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("requireAdvanced on/off uses the exact descriptor before observed toggles", async () => {
    const store = readyDeviceStore(true);
    observeAdvancedCatalog(store, [
      advancedCommand("identifier_switch", "on", { capabilityVersion: 7 }),
      advancedCommand("identifier_switch", "off")
    ]);
    const executeDeviceAction = vi.fn(async (input: DeviceActionExecutionInput) => {
      store.observe(received(deviceEventFrame(
        input.command,
        "2026-08-25T00:00:01Z"
      )));
      return {
        state: "ACCEPTED" as const,
        transport: "advanced" as const,
        acceptedAtMs: Date.now()
      };
    });
    const executor: SafeCommandExecutor = { executeDeviceAction };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute({
        ...command("on", "request_require_advanced_toggle_descriptor"),
        requireAdvanced: true
      })
    ).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "device_event",
      transport: "advanced"
    });
    const action = executeDeviceAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({
      capability: "identifier_switch",
      capabilityVersion: 7,
      command: "on",
      requireAdvanced: true
    });
    expect(action).not.toHaveProperty("controlId");
    expect(action).not.toHaveProperty("controlLabel");
    expect(action).not.toHaveProperty("nativeCommand");
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
      expect(resync).toHaveBeenCalledOnce();
      expect(resync).toHaveBeenCalledWith({ deviceId: "dev_001" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not let timeout resync bypass the configured stability window", async () => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z")));
      return undefined;
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

  test("binds switch commands to the matching observed toggle and preserves its exact web command", async () => {
    const store = readyDeviceStore(false);
    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_toggle001",
        label: "Secondary outlet",
        commands: ["switchOn", "switchOff"]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        store.observe(received(deviceEventFrame(
          input.command,
          input.command === "on" ? "2026-08-25T00:00:01Z" : "2026-08-25T00:00:02Z"
        )));
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
      controlLabel: "Secondary outlet",
      nativeCommand: "switchOn"
    }));

    await expect(service.execute(command("off", "request_028_off"))).resolves.toMatchObject({
      status: "confirmed"
    });
    expect(executor.executeDeviceAction).toHaveBeenLastCalledWith(expect.objectContaining({
      controlId: "identifier_toggle001",
      controlLabel: "Secondary outlet",
      nativeCommand: "switchOff"
    }));
  });

  test("rejects on and off when no observed safe toggle control exists", async () => {
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const service = new SafeCommandService({
      devices: readyDeviceStore(false),
      status: connectedStatus(),
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(command("on", "request_unobserved_on"))).rejects.toMatchObject({
      code: "invalid_control_id"
    });
    await expect(service.execute(command("off", "request_unobserved_off"))).rejects.toMatchObject({
      code: "invalid_control_id"
    });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("uses Cake's canonical native token for a metadata-free observed toggle", async () => {
    const store = readyDeviceStore(false);
    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_toggle_ui_only",
        label: "Power"
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        expect(input.nativeCommand).toBe("on");
        expect(input.controlId).toBe("identifier_toggle_ui_only");
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

    await expect(service.execute(command("on", "request_ui_only_on"))).resolves.toMatchObject({
      status: "confirmed"
    });
  });

  test("permits only an observed action direction except for a current-state no-op", async () => {
    const store = readyDeviceStore(false);
    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "action:main:identifier_switch:switch",
        label: "Power",
        commands: ["on"]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        store.observe(
          received(
            deviceEventFrame(
              input.command,
              "2026-08-25T00:00:01Z"
            )
          )
        );
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(
      service.execute(command("off", "request_action_noop_off"))
    ).resolves.toMatchObject({ status: "already_confirmed" });
    expect(executor.executeDeviceAction).not.toHaveBeenCalled();

    await expect(
      service.execute(command("on", "request_action_observed_on"))
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(executor.executeDeviceAction).toHaveBeenCalledTimes(1);

    await expect(
      service.execute(command("off", "request_action_unseen_off"))
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(executor.executeDeviceAction).toHaveBeenCalledTimes(1);
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

  test("rejects commands when the SmartThings push stream is stale before UI interaction", async () => {
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async () => undefined)
    };
    const status = connectedStatus();
    status.update({ lastPushAtMs: Date.now() - 120_001 });
    const service = new SafeCommandService({
      devices: readyDeviceStore(),
      status,
      executor,
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(command("on", "request_stale_push"))).rejects.toMatchObject({
      code: "bridge_not_connected"
    });
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

  test("runs one on-demand snapshot refresh before the final timeout and keeps listening for push", async () => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    const resync = vi.fn(async () => undefined);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 30_000,
      resyncAfterMs: 1_000,
      resync
    });

    try {
      const result = service.execute(command("on", "request_advanced_refresh"));
      await vi.advanceTimersByTimeAsync(1_001);
      expect(resync).toHaveBeenCalledTimes(1);

      store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:03Z")));
      await expect(result).resolves.toMatchObject({
        status: "confirmed",
        confirmation: "device_event"
      });
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("accepts matching state from the one-shot Advanced snapshot refresh", async () => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observeAdvancedDeviceSnapshot({
        items: [
          {
            deviceId: "dev_001",
            locationId: "loc_001",
            status: {
              components: {
                main: {
                  identifier_switch: {
                    switch: {
                      value: "on",
                      timestamp: "2026-08-25T00:00:04Z"
                    }
                  }
                }
              }
            }
          }
        ]
      });
      return undefined;
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 30_000,
      resyncAfterMs: 1_000,
      resync
    });

    try {
      const result = service.execute(command("on", "request_advanced_confirm"));
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(result).resolves.toMatchObject({
        status: "confirmed",
        confirmation: "inventory_snapshot"
      });
      expect(resync).toHaveBeenCalledOnce();
      expect(resync).toHaveBeenCalledWith({ deviceId: "dev_001" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("enforces the final confirmation timeout even when the early snapshot refresh hangs", async () => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    const never = new Promise<CommandResyncEvidence | undefined>(() => undefined);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 30_000,
      resyncAfterMs: 1_000,
      resync: vi.fn(() => never)
    });

    try {
      let failure: unknown;
      void service.execute(command("on", "request_hanging_refresh")).catch((error) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(failure).toMatchObject({ code: "command_confirmation_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("accepts the requested switch state from the timeout full snapshot resync", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(sent('429["find","api/device/status",{}]'));
      store.observe(
        received(
          '439[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"on","unit":null,"timestamp":"2026-08-25T00:00:02Z"}]]'
        )
      );
      return undefined;
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
    }))).resolves.toMatchObject({
      status: "accepted_unconfirmed",
      confirmation: "accepted_receipt",
      lifecycle: "ACCEPTED_UNCONFIRMED"
    });
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

  test("executes observed media source repeat and shuffle controls with exact confirmation", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_source",
        label: "Source",
        capabilityId: "identifier_mediaInputSource",
        attributeName: "inputSource",
        command: "setInputSource",
        options: ["Bluetooth", "Wi-Fi"],
        optionLabels: { Bluetooth: "Bluetooth", "Wi-Fi": "Wi-Fi" }
      }),
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_repeat",
        label: "Repeat",
        capabilityId: "identifier_mediaPlaybackRepeat",
        attributeName: "repeatMode",
        command: "setRepeat",
        options: ["off", "all"],
        optionLabels: { off: "Off", all: "All" }
      }),
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_shuffle",
        label: "Shuffle",
        capabilityId: "identifier_mediaPlaybackShuffle",
        attributeName: "shuffle",
        commands: ["setShuffle"]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        if (input.command === "setInputSource") {
          expect(input.nativeCommand).toBe("setInputSource");
          expect(input.optionLabel).toBe("Bluetooth");
          store.observe(received(deviceEventFrame(
            "Bluetooth",
            "2026-08-25T00:00:01Z",
            "inputSource",
            "dev_001",
            "identifier_mediaInputSource"
          )));
        }
        if (input.command === "setRepeat") {
          expect(input.nativeCommand).toBe("setRepeat");
          expect(input.optionLabel).toBe("All");
          store.observe(received(deviceEventFrame(
            "all",
            "2026-08-25T00:00:02Z",
            "repeatMode",
            "dev_001",
            "identifier_mediaPlaybackRepeat"
          )));
        }
        if (input.command === "setShuffle") {
          expect(input.nativeCommand).toBe("setShuffle");
          store.observe(received(deviceEventFrame(
            true,
            "2026-08-25T00:00:03Z",
            "shuffle",
            "dev_001",
            "identifier_mediaPlaybackShuffle"
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

    await expect(service.execute(deviceCommand("setInputSource", "request_source_001", {
      attribute: "inputSource",
      arguments: ["Bluetooth"],
      capability: "identifier_mediaInputSource",
      controlId: "identifier_source"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setRepeat", "request_repeat_001", {
      attribute: "repeatMode",
      arguments: ["all"],
      capability: "identifier_mediaPlaybackRepeat",
      controlId: "identifier_repeat"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("setShuffle", "request_shuffle_001", {
      attribute: "shuffle",
      arguments: [true],
      capability: "identifier_mediaPlaybackShuffle",
      controlId: "identifier_shuffle"
    }))).resolves.toMatchObject({ status: "confirmed" });
  });

  test("confirms string shuffle states with the current SmartThings vocabulary", async () => {
    const store = readyDeviceStore();
    store.observe(received(deviceEventFrame(
      "off",
      "2026-08-25T00:00:00.500Z",
      "shuffle",
      "dev_001",
      "identifier_mediaPlaybackShuffle"
    )));
    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_shuffle",
        label: "Shuffle",
        capabilityId: "identifier_mediaPlaybackShuffle",
        attributeName: "shuffle",
        commands: ["setShuffle"]
      })
    ]);
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        expect(input.command).toBe("setShuffle");
        expect(input.nativeCommand).toBe("setShuffle");
        store.observe(received(deviceEventFrame(
          "on",
          "2026-08-25T00:00:01Z",
          "shuffle",
          "dev_001",
          "identifier_mediaPlaybackShuffle"
        )));
      })
    };
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor,
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("setShuffle", "request_shuffle_string", {
      attribute: "shuffle",
      arguments: [true],
      capability: "identifier_mediaPlaybackShuffle",
      controlId: "identifier_shuffle"
    }))).resolves.toMatchObject({ status: "confirmed" });
  });

  test("rejects unobserved or invalid media source repeat and shuffle commands", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_source",
        label: "Source",
        capabilityId: "identifier_mediaInputSource",
        attributeName: "inputSource",
        options: ["Bluetooth"],
        command: "setInputSource"
      }),
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_shuffle",
        label: "Shuffle",
        capabilityId: "identifier_mediaPlaybackShuffle",
        attributeName: "shuffle",
        commands: ["setShuffle"]
      })
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 1_000,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute(deviceCommand("setInputSource", "request_source_bad", {
      attribute: "inputSource",
      arguments: ["HDMI"],
      capability: "identifier_mediaInputSource",
      controlId: "identifier_source"
    }))).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(service.execute(deviceCommand("setRepeat", "request_repeat_missing", {
      attribute: "repeatMode",
      arguments: ["all"],
      capability: "identifier_mediaPlaybackRepeat"
    }))).rejects.toMatchObject({ code: "invalid_control_id" });
    await expect(service.execute(deviceCommand("setShuffle", "request_shuffle_bad", {
      attribute: "shuffle",
      arguments: ["true"],
      capability: "identifier_mediaPlaybackShuffle",
      controlId: "identifier_shuffle"
    }))).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  test("never substitutes inverse observed commands on the native path", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_unmute_exact",
        label: "Mute",
        attributeName: "mute",
        commands: ["mute", "unmute"]
      }),
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_stop_exact",
        label: "Stop",
        capabilityId: "identifier_mediaPlayback",
        attributeName: "playbackStatus",
        commands: ["pause", "stop"]
      })
    ]);
    store.observe(received(deviceEventFrame("muted", "2026-08-25T00:00:00.500Z", "mute")));
    const executor: SafeCommandExecutor = {
      executeDeviceAction: vi.fn(async (input) => {
        if (input.command === "unmute") {
          expect(input.nativeCommand).toBe("unmute");
          store.observe(received(deviceEventFrame("unmuted", "2026-08-25T00:00:01Z", "mute")));
        }
        if (input.command === "stop") {
          expect(input.nativeCommand).toBe("stop");
          store.observe(received(deviceEventFrame(
            "stopped",
            "2026-08-25T00:00:02Z",
            "playbackStatus",
            "dev_001",
            "identifier_mediaPlayback"
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

    await expect(service.execute(deviceCommand("unmute", "request_unmute_exact", {
      attribute: "mute",
      arguments: [],
      controlId: "identifier_unmute_exact"
    }))).resolves.toMatchObject({ status: "confirmed" });
    await expect(service.execute(deviceCommand("stop", "request_stop_exact", {
      attribute: "playbackStatus",
      arguments: [],
      capability: "identifier_mediaPlayback",
      controlId: "identifier_stop_exact"
    }))).resolves.toMatchObject({ status: "confirmed" });
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
      attribute: "mode",
      nativeCommand: "setMode"
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
    ["safeToggle", "밸브 제어"],
    ["safeToggle", "현관문"],
    ["safeToggle", "대문"]
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

  test("accepts refresh without caller-supplied component metadata or a persistent state", async () => {
    const store = readyDeviceStore();
    observeRefreshControl(store);
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
    })).resolves.toMatchObject({
      status: "accepted_unconfirmed",
      confirmation: "accepted_receipt"
    });
  });

  test("does not run an Advanced resync merely to confirm stateless refresh", async () => {
    const store = readyDeviceStore();
    observeRefreshControl(store);
    const resync = vi.fn(async () => inventoryEvidence());
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 50,
      resyncAfterMs: 0,
      resync
    });

    await expect(service.execute(refreshCommand("request_refresh_snapshot"))).resolves.toMatchObject({
      status: "accepted_unconfirmed",
      confirmation: "accepted_receipt"
    });
    expect(resync).not.toHaveBeenCalled();
  });

  test("does not consult stale snapshot evidence for stateless refresh", async () => {
    const store = readyDeviceStore();
    observeRefreshControl(store);
    const resync = vi.fn(async () => ({
      source: "advanced_inventory" as const,
      authoritativeSnapshot: true,
      startedAtMs: 1_000
    }));
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => undefined)
      },
      timeoutMs: 10,
      resyncAfterMs: 0,
      resync
    });

    await expect(
      service.execute(refreshCommand("request_refresh_stale_snapshot"))
    ).resolves.toMatchObject({ status: "accepted_unconfirmed" });
    expect(resync).not.toHaveBeenCalled();
  });

  test("returns accepted-unconfirmed for a stateless press without waiting for a state", async () => {
    const store = readyDeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_button001",
        label: "Ping",
        attributeName: "button",
        commands: ["press"]
      })
    ]);
    const resync = vi.fn(async () => inventoryEvidence());
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => ({
          state: "ACCEPTED" as const,
          transport: "advanced" as const,
          acceptedAtMs: Date.now()
        }))
      },
      timeoutMs: 10,
      resyncAfterMs: 0,
      resync
    });

    await expect(service.execute(deviceCommand("press", "request_press_no_snapshot", {
      attribute: "button",
      arguments: [],
      controlId: "identifier_button001"
    }))).resolves.toMatchObject({
      status: "accepted_unconfirmed",
      confirmation: "accepted_receipt",
      lifecycle: "ACCEPTED_UNCONFIRMED",
      transport: "advanced"
    });
    expect(resync).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "on",
      setup: (store: DeviceStore) => store,
      request: () => command("on", "request_no_stateless_on")
    },
    {
      name: "off",
      setup: (store: DeviceStore) => {
        store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:00.500Z")));
        return store;
      },
      request: () => command("off", "request_no_stateless_off")
    },
    {
      name: "setNumber slider",
      setup: (store: DeviceStore) => {
        observeDeviceDetails(store, [
          detailSwatch("SLIDER", "slider", {
            swatchId: "identifier_frequency_snapshot",
            label: "Detection frequency",
            attributeName: "detectionFrequency",
            min: 0,
            max: 3600
          })
        ]);
        return store;
      },
      request: () => deviceCommand("setNumber", "request_no_stateless_number", {
        attribute: "detectionFrequency",
        arguments: [42],
        controlId: "identifier_frequency_snapshot"
      })
    },
    {
      name: "setVolume slider",
      setup: (store: DeviceStore) => {
        observeDeviceDetails(store, [
          detailSwatch("SLIDER", "slider", {
            swatchId: "identifier_volume_snapshot",
            label: "Volume",
            attributeName: "volume",
            min: 0,
            max: 100
          })
        ]);
        return store;
      },
      request: () => deviceCommand("setVolume", "request_no_stateless_volume", {
        attribute: "volume",
        arguments: [12],
        controlId: "identifier_volume_snapshot"
      })
    },
    {
      name: "media",
      setup: (store: DeviceStore) => {
        observeDeviceDetails(store, [
          detailSwatch("BUTTON", "button", {
            swatchId: "identifier_play_snapshot",
            label: "Play",
            capabilityId: "identifier_mediaPlayback",
            attributeName: "playbackStatus",
            commands: ["play"]
          })
        ]);
        return store;
      },
      request: () => deviceCommand("play", "request_no_stateless_media", {
        attribute: "playbackStatus",
        arguments: [],
        capability: "identifier_mediaPlayback",
        controlId: "identifier_play_snapshot"
      })
    },
    {
      name: "cover button",
      setup: (store: DeviceStore) => {
        observeDeviceDetails(store, [
          detailSwatch("BUTTON", "button", {
            swatchId: "identifier_open_snapshot",
            label: "Open shade",
            attributeName: "windowShade",
            commands: ["openShade"]
          })
        ]);
        return store;
      },
      request: () => deviceCommand("openShade", "request_no_stateless_cover", {
        attribute: "windowShade",
        arguments: [],
        controlId: "identifier_open_snapshot"
      })
    },
    {
      name: "setPosition cover slider",
      setup: (store: DeviceStore) => {
        observeDeviceDetails(store, [
          detailSwatch("SLIDER", "slider", {
            swatchId: "identifier_position_snapshot",
            label: "Shade level",
            attributeName: "shadeLevel",
            command: "setPosition",
            min: 0,
            max: 100
          })
        ]);
        return store;
      },
      request: () => deviceCommand("setPosition", "request_no_stateless_position", {
        attribute: "shadeLevel",
        arguments: [45],
        controlId: "identifier_position_snapshot"
      })
    },
    {
      name: "setOption",
      setup: (store: DeviceStore) => {
        observeDeviceDetails(store, [
          detailSwatch("ENUMERATED", "enumerated", {
            swatchId: "identifier_mode_snapshot",
            label: "Mode",
            attributeName: "mode",
            command: "setMode",
            options: ["eco", "auto"]
          })
        ]);
        return store;
      },
      request: () => deviceCommand("setOption", "request_no_stateless_option", {
        attribute: "mode",
        arguments: ["eco"],
        controlId: "identifier_mode_snapshot"
      })
    }
  ])("does not let %s use the stateless refresh snapshot policy", async ({ setup, request }) => {
    const store = setup(readyDeviceStore());
    const resync = vi.fn(async () => inventoryEvidence());
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 10,
      resyncAfterMs: 0,
      resync
    });

    await expect(service.execute(request())).rejects.toMatchObject({
      code: "command_confirmation_timeout"
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["unavailable", async () => deviceStatusEvidence()],
    ["failed", async () => {
      throw new Error("advanced_snapshot_unavailable");
    }]
  ])("does not depend on %s refresh resync for a stateless receipt", async (_name, resyncImpl) => {
    const store = readyDeviceStore();
    observeRefreshControl(store);
    const resync = vi.fn(resyncImpl);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeDeviceAction: vi.fn(async () => undefined) },
      timeoutMs: 10,
      resyncAfterMs: 0,
      resync
    });

    await expect(
      service.execute(refreshCommand("request_refresh_resync_fail"))
    ).resolves.toMatchObject({ status: "accepted_unconfirmed" });
    expect(resync).not.toHaveBeenCalled();
  });

  test("does not resync or confirm refresh when browser execution fails", async () => {
    const store = readyDeviceStore();
    observeRefreshControl(store);
    const resync = vi.fn(async () => inventoryEvidence());
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeDeviceAction: vi.fn(async () => {
          throw new Error("native ack failed");
        })
      },
      timeoutMs: 50,
      resyncAfterMs: 0,
      resync
    });

    await expect(service.execute(refreshCommand("request_refresh_exec_fail"))).rejects.toMatchObject({
      code: "command_execution_failed"
    });
    expect(resync).not.toHaveBeenCalled();
  });

  test("executes scenes only after a newer matching action state", async () => {
    const store = readyDeviceStore();
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
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

  test("confirms an already-satisfied scene only after execution and authoritative resync", async () => {
    const store = readyDeviceStore();
    store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:00.500Z")));
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
    let sceneCompletedAtMs = 0;
    const executeScene = vi.fn(async () => {
      sceneCompletedAtMs = Date.now();
    });
    const resync = vi.fn(async () => inventoryEvidence(sceneCompletedAtMs));
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeScene },
      timeoutMs: 50,
      resyncAfterMs: 0,
      resync
    });

    await expect(service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_scene_presatisfied_snapshot"
    })).resolves.toMatchObject({
      status: "confirmed",
      confirmation: "inventory_snapshot"
    });
    expect(executeScene).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("rejects already-satisfied scene snapshot evidence that started before execution completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = readyDeviceStore();
    store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:00.500Z")));
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(sent('425["find","api/device/status",{}]'));
      store.observe(
        received(
          '435[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"on","unit":null,"timestamp":"2026-08-25T00:00:02Z"}]]'
        )
      );
      return inventoryEvidence(1_000);
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          vi.setSystemTime(2_000);
        })
      },
      timeoutMs: 10,
      resyncAfterMs: 0,
      resync
    });

    try {
      const result = service.execute({
        targetType: "scene",
        targetId: "identifier_scene001",
        command: "execute",
        arguments: [],
        clientRequestId: "request_scene_stale_snapshot"
      });
      const rejected = expect(result).rejects.toMatchObject({
        code: "command_confirmation_timeout"
      });
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps matching scene event evidence that arrives during insufficient post-action resync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = readyDeviceStore();
    store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:00.500Z")));
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:02Z")));
      return inventoryEvidence(1_000);
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          vi.setSystemTime(2_000);
        })
      },
      timeoutMs: 30,
      resync
    });

    try {
      const result = service.execute({
        targetType: "scene",
        targetId: "identifier_scene001",
        command: "execute",
        arguments: [],
        clientRequestId: "request_scene_resync_event_preserved"
      });
      await vi.advanceTimersByTimeAsync(31);
      await expect(result).resolves.toMatchObject({
        status: "confirmed",
        confirmation: "device_event"
      });
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("times out an already-satisfied scene when post-action resync hangs", async () => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:00.500Z")));
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
    const never = new Promise<CommandResyncEvidence | undefined>(() => undefined);
    const resync = vi.fn(() => never);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeScene: vi.fn(async () => undefined) },
      timeoutMs: 30,
      resync
    });

    try {
      let failure: unknown;
      void service.execute({
        targetType: "scene",
        targetId: "identifier_scene001",
        command: "execute",
        arguments: [],
        clientRequestId: "request_scene_hanging_resync"
      }).catch((error) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(31);
      await Promise.resolve();
      expect(failure).toMatchObject({ code: "command_confirmation_timeout" });
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps waiting when an already-satisfied scene resync no longer matches every expected state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = readyDeviceStore();
    store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:00.500Z")));
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(received(deviceEventFrame("off", "2026-08-25T00:00:02Z")));
      setTimeout(() => {
        store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:03Z")));
      }, 5);
      return inventoryEvidence(2_000);
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          vi.setSystemTime(2_000);
        })
      },
      timeoutMs: 30,
      resync
    });

    try {
      const result = service.execute({
        targetType: "scene",
        targetId: "identifier_scene001",
        command: "execute",
        arguments: [],
        clientRequestId: "request_scene_resync_mismatch_then_event"
      });
      await vi.advanceTimersByTimeAsync(6);
      await expect(result).resolves.toMatchObject({
        status: "confirmed",
        confirmation: "device_event"
      });
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not resync or confirm an already-satisfied scene when execution fails", async () => {
    const store = readyDeviceStore();
    store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:00.500Z")));
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
    const resync = vi.fn(async () => inventoryEvidence());
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          throw new Error("scene click failed");
        })
      },
      timeoutMs: 50,
      resyncAfterMs: 0,
      resync
    });

    await expect(service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_scene_exec_fail"
    })).rejects.toMatchObject({ code: "command_execution_failed" });
    expect(resync).not.toHaveBeenCalled();
  });

  test("does not confirm multi-action scenes until every expected state is observed or snapshotted", async () => {
    const store = readyDeviceStore();
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(sent('425["find","api/device/status",{}]'));
      store.observe(
        received(
          '435[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"on","unit":null,"timestamp":"2026-08-25T00:00:03Z"},{"deviceId":"dev_002","locationId":"loc_001","componentId":"main","capabilityId":"identifier_audioVolume","attributeName":"volume","value":64,"unit":null,"timestamp":"2026-08-25T00:00:03Z"}]]'
        )
      );
      return undefined;
    });
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001", "dev_002"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            },
            {
              component: "main",
              capability: "identifier_audioVolume",
              command: "setVolume",
              arguments: [{ integer: 64, type: "integer" }]
            }
          ]
        }
      }
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z", "switch", "dev_001")));
          store.observe(received(deviceEventFrame(64, "2026-08-25T00:00:02Z", "volume", "dev_002", "identifier_audioVolume")));
        })
      },
      timeoutMs: 20,
      resync
    });

    await expect(service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_023"
    })).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(resync).toHaveBeenCalledOnce();
  });

  test("accumulates every expected scene state and clears a contradicted observed state", async () => {
    const store = readyDeviceStore();
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001", "dev_002"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            },
            {
              component: "main",
              capability: "identifier_audioVolume",
              command: "setVolume",
              arguments: [{ integer: 64, type: "integer" }]
            }
          ]
        }
      }
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z", "switch", "dev_001")));
          store.observe(received(deviceEventFrame("off", "2026-08-25T00:00:02Z", "switch", "dev_001")));
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:03Z", "switch", "dev_002")));
          store.observe(received(deviceEventFrame(64, "2026-08-25T00:00:04Z", "volume", "dev_001", "identifier_audioVolume")));
          store.observe(received(deviceEventFrame(64, "2026-08-25T00:00:05Z", "volume", "dev_002", "identifier_audioVolume")));
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:06Z", "switch", "dev_001")));
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
      clientRequestId: "request_024"
    })).resolves.toMatchObject({ confirmation: "device_event" });
  });

  test("rebuilds scene evidence from inventory before accepting later expected events", async () => {
    const store = readyDeviceStore();
    let sequenceAfterB = 0;
    observeSceneSnapshot(store, [
      {
        command: {
          deviceId: "dev_001",
          component: "main",
          capability: "identifier_switch",
          command: "on",
          arguments: []
        }
      },
      {
        command: {
          deviceId: "dev_001",
          component: "main",
          capability: "identifier_audioVolume",
          command: "setVolume",
          arguments: [{ integer: 64, type: "integer" }]
        }
      }
    ]);
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(sent('425["find","api/device/status",{}]'));
      store.observe(
        received(
          '435[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"off","unit":null,"timestamp":"2026-08-25T00:00:02Z"}]]'
        )
      );
      store.observe(received(deviceEventFrame(64, "2026-08-25T00:00:03Z", "volume", "dev_001", "identifier_audioVolume")));
      sequenceAfterB = store.currentSequence();
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:04Z", "switch", "dev_001")));
      return undefined;
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:01Z", "switch", "dev_001")));
        })
      },
      timeoutMs: 20,
      resync
    });

    const result = await service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_026"
    });

    expect(resync).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ confirmation: "device_event" });
    expect(result.sequence).toBeGreaterThan(sequenceAfterB);
  });

  test("confirms multi-action scenes from a full resync snapshot only when every expected state matches", async () => {
    const store = readyDeviceStore();
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001", "dev_002"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            },
            {
              component: "main",
              capability: "identifier_audioVolume",
              command: "setVolume",
              arguments: [{ integer: 64, type: "integer" }]
            }
          ]
        }
      }
    ]);
    const resync = vi.fn(async (): Promise<CommandResyncEvidence | undefined> => {
      store.observe(sent('425["find","api/device/status",{}]'));
      store.observe(
        received(
          '435[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"on","unit":null,"timestamp":"2026-08-25T00:00:01Z"},{"deviceId":"dev_001","locationId":"loc_001","componentId":"main","capabilityId":"identifier_audioVolume","attributeName":"volume","value":64,"unit":null,"timestamp":"2026-08-25T00:00:01Z"},{"deviceId":"dev_002","locationId":"loc_001","componentId":"main","capabilityId":"identifier_switch","attributeName":"switch","value":"on","unit":null,"timestamp":"2026-08-25T00:00:01Z"},{"deviceId":"dev_002","locationId":"loc_001","componentId":"main","capabilityId":"identifier_audioVolume","attributeName":"volume","value":64,"unit":null,"timestamp":"2026-08-25T00:00:01Z"}]]'
        )
      );
      return undefined;
    });
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeScene: vi.fn(async () => undefined) },
      timeoutMs: 20,
      resync
    });

    await expect(service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_025"
    })).resolves.toMatchObject({ confirmation: "inventory_snapshot" });
  });

  test("does not confirm scenes from unrelated same-location device traffic", async () => {
    const store = readyDeviceStore();
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "on",
              arguments: []
            }
          ]
        }
      }
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          store.observe(received(deviceEventFrame("open", "2026-08-25T00:00:01Z", "contact")));
        })
      },
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_019"
    })).rejects.toMatchObject({ code: "command_confirmation_timeout" });
  });

  test("confirms scene typed action arguments from primitive push values", async () => {
    const store = readyDeviceStore();
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "identifier_switch",
              command: "setVolume",
              arguments: [{ integer: 64, type: "integer" }]
            },
            {
              component: "main",
              capability: "identifier_thermostatMode",
              command: "setThermostatMode",
              arguments: [{ string: "eco", type: "string" }]
            }
          ]
        }
      }
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          store.observe(received(deviceEventFrame(64, "2026-08-25T00:00:01Z", "volume")));
          store.observe(received(deviceEventFrame("eco", "2026-08-25T00:00:02Z", "thermostatMode", "dev_001", "identifier_thermostatMode")));
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
      clientRequestId: "request_021"
    })).resolves.toMatchObject({ confirmation: "device_event" });
  });

  test("confirms raw normalized scene action tokens against normalized push states", async () => {
    const aliases: Record<string, string> = {
      main: "identifier_main",
      switch: "identifier_switch",
      audioVolume: "identifier_audioVolume"
    };
    const store = readyDeviceStore(true, (value) => aliases[value] ?? value);
    observeSceneSnapshot(store, [
      {
        command: {
          devices: ["dev_001"],
          commands: [
            {
              component: "main",
              capability: "switch",
              command: "on",
              arguments: []
            },
            {
              component: "main",
              capability: "audioVolume",
              command: "setVolume",
              arguments: [{ integer: 64, type: "integer" }]
            }
          ]
        }
      }
    ]);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: {
        executeScene: vi.fn(async () => {
          store.observe(received(deviceEventFrame(64, "2026-08-25T00:00:01Z", "volume", "dev_001", "audioVolume")));
          store.observe(received(deviceEventFrame("on", "2026-08-25T00:00:02Z", "switch", "dev_001", "switch")));
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
      clientRequestId: "request_022"
    })).resolves.toMatchObject({ confirmation: "device_event" });
  });

  test("fails closed when scene actions do not expose an expected state", async () => {
    const store = readyDeviceStore();
    observeSceneSnapshot(store);
    const service = new SafeCommandService({
      devices: store,
      status: connectedStatus(),
      executor: { executeScene: vi.fn(async () => undefined) },
      timeoutMs: 20,
      resync: vi.fn(async () => undefined)
    });

    await expect(service.execute({
      targetType: "scene",
      targetId: "identifier_scene001",
      command: "execute",
      arguments: [],
      clientRequestId: "request_020"
    })).rejects.toMatchObject({ code: "command_confirmation_timeout" });
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

function aggregateCommand(value: "on" | "off", clientRequestId: string) {
  return { ...command(value, clientRequestId), component: "identifier_main" };
}

function advancedReceipts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    state: "ACCEPTED" as const,
    transport: "advanced" as const,
    acceptedAtMs: index + 1
  }));
}

function deviceStatusEvidence(startedAtMs = Date.now()): CommandResyncEvidence {
  return {
    source: "advanced_device_status",
    authoritativeSnapshot: false,
    startedAtMs
  };
}

function inventoryEvidence(startedAtMs = Date.now()): CommandResyncEvidence {
  return {
    source: "advanced_inventory",
    authoritativeSnapshot: true,
    startedAtMs
  };
}

function refreshCommand(clientRequestId: string) {
  return {
    targetType: "device",
    targetId: "dev_001",
    command: "refresh",
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

function observeAdvancedCatalog(
  store: DeviceStore,
  commands: Parameters<DeviceStore["observeAdvancedCommandCatalog"]>[1]
): void {
  store.observeAdvancedCommandCatalog("dev_001", commands, []);
}

function advancedCommand(
  capability: string,
  commandName: string,
  overrides: Partial<Parameters<DeviceStore["observeAdvancedCommandCatalog"]>[1][number]> = {}
): Parameters<DeviceStore["observeAdvancedCommandCatalog"]>[1][number] {
  return {
    component: "main",
    capability,
    capabilityVersion: 1,
    command: commandName,
    arguments: [],
    transport: "advanced",
    confirmation: "state",
    label: commandName,
    labelSource: "capability",
    ...overrides
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
      heartbeatAtMs: now,
      initialSnapshotCompletedAtMs: now,
      lastSnapshotAtMs: now,
      lastParserSuccessAtMs: now,
      lastPushAtMs: now
    }
  });
}

function multiSwitchFixture(
  components: string[],
  options: { includeVersions?: boolean; deviceType?: string } = {}
) {
  const store = readyDeviceStore();
  store.observe(sent('4291["find","api/device/status",{}]'));
  store.observe(
    received(
      '4391[null,[{"deviceId":"dev_001","locationId":"loc_001","componentId":"identifier_main","capabilityId":"identifier_switch","attributeName":"switch","value":"off","unit":null,"timestamp":"2026-08-25T00:00:00Z"}]]'
    )
  );
  observeDeviceDetails(store, [
    detailSwatch("TOGGLE", "toggle", {
      swatchId: "identifier_toggle_aggregate",
      label: "Aggregate power",
      componentId: "identifier_main",
      commands: ["on", "off"]
    })
  ]);
  let observedAtMs = Date.parse("2026-09-01T00:00:00.000Z");
  const setSwitchStates = (
    values: "on" | "off" | Readonly<Record<string, "on" | "off">>,
    source: BridgeStateSource = "COMMAND_STATUS_RECHECK"
  ) => {
    observedAtMs += 1_000;
    store.observeAdvancedDeviceSnapshot(
      {
        items: [
          {
            deviceId: "dev_001",
            locationId: "loc_001",
            deviceTypeName: options.deviceType ?? "switch",
            components: components.map((component) => ({
              id: `identifier_${component}`,
              label: component === "main" ? "Main" : component,
              capabilities: [
                {
                  id: "identifier_switch",
                  ...(options.includeVersions === false ? {} : { version: 1 }),
                  status: {
                    switch: {
                      value: typeof values === "string" ? values : values[component],
                      timestamp: new Date(observedAtMs).toISOString()
                    }
                  }
                }
              ]
            }))
          }
        ]
      },
      { source }
    );
  };
  setSwitchStates("on", "ADVANCED_SNAPSHOT");
  const executeDeviceAction = vi.fn(async (
    _input: DeviceActionExecutionInput
  ): Promise<Awaited<ReturnType<NonNullable<SafeCommandExecutor["executeDeviceAction"]>>>> => {
    store.observe(
      received(
        deviceEventFrame(
          "off",
          "2026-09-01T01:00:00.000Z",
          "switch",
          "dev_001",
          "identifier_switch",
          undefined,
          "identifier_main"
        )
      )
    );
    return undefined;
  });
  const executeComponentTransaction = vi.fn(async (input: ComponentTransactionExecutionInput) =>
    advancedReceipts(input.actions.length)
  );
  const resync = vi.fn(async (_request?: { deviceId?: string }): Promise<CommandResyncEvidence> => ({
    source: "advanced_device_status",
    authoritativeSnapshot: false,
    startedAtMs: Date.now()
  }));
  const service = new SafeCommandService({
    devices: store,
    status: connectedStatus(),
    executor: { executeDeviceAction, executeComponentTransaction },
    timeoutMs: 20,
    resyncAfterMs: 0,
    resync
  });
  return {
    service,
    store,
    setSwitchStates,
    resync,
    executeDeviceAction,
    executeComponentTransaction
  };
}

function configureChildMappedSwitch(
  store: DeviceStore,
  options: {
    ambiguous?: boolean;
    dangerousChildId?: string;
    invalidChildTimestampId?: string;
    invalidParentTimestamp?: boolean;
    missingVersionChildId?: string;
    offlineChildId?: string;
    scoredAmbiguous?: boolean;
  } = {}
) {
  const mappings = [
    { role: "switch2", childId: "dev_145", offsetMs: 2_000 },
    { role: "switch3", childId: "dev_116", offsetMs: 4_000 },
    { role: "switch4", childId: "dev_117", offsetMs: 6_000 }
  ] as const;
  let generation = 0;
  const parentRow = (value: "on" | "off", base: number) => ({
    deviceId: "dev_001",
    locationId: "loc_001",
    deviceTypeName: "switch",
    childDevices: mappings.map(({ childId }) => ({ deviceId: childId })),
    components: [
      {
        id: "identifier_main",
        label: "Main",
        capabilities: [
          {
            id: "identifier_switch",
            version: 1,
            status: {
              switch: { value, timestamp: new Date(base + 6_500).toISOString() }
            }
          }
        ]
      },
      ...mappings.map(({ role, offsetMs }) => ({
        id: `identifier_${role}`,
        label: role,
        capabilities: [
          {
            id: "identifier_switch",
            version: 1,
            status: {
              switch: {
                value,
                timestamp:
                  options.invalidParentTimestamp && role === "switch2"
                    ? "not-a-timestamp"
                    : new Date(
                        base + (options.ambiguous ? 3_000 : offsetMs)
                      ).toISOString()
              }
            }
          }
        ]
      }))
    ]
  });
  const childRow = (
    mapping: (typeof mappings)[number],
    value: "on" | "off",
    base: number
  ) => ({
    deviceId: mapping.childId,
    locationId: "loc_001",
    deviceTypeName:
      options.dangerousChildId === mapping.childId ? "door lock" : "switch",
    parentDeviceId: "dev_001",
    ...(options.offlineChildId === mapping.childId
      ? {
          healthState: {
            state: "OFFLINE",
            lastUpdatedDate: new Date(base + 10_000).toISOString()
          }
        }
      : {}),
    components: [
      {
        id: "identifier_main",
        label: "Main",
        capabilities: [
          {
            id: "identifier_switch",
            ...(options.missingVersionChildId === mapping.childId ? {} : { version: 1 }),
            status: {
              switch: {
                value,
                timestamp:
                  options.invalidChildTimestampId === mapping.childId
                    ? "not-a-timestamp"
                    : new Date(
                        base +
                          (options.ambiguous
                            ? 3_100
                            : options.scoredAmbiguous && mapping.childId === "dev_116"
                              ? 2_800
                              : mapping.offsetMs + 100)
                      ).toISOString()
              }
            }
          }
        ]
      }
    ]
  });
  const nextBase = () => {
    generation += 1;
    return Date.parse("2026-09-01T02:00:00.000Z") + generation * 60_000;
  };
  const observe = (items: unknown[], source: BridgeStateSource) =>
    store.observeAdvancedDeviceSnapshot({ items }, { source });
  const setStates = (
    value: "on" | "off",
    source: BridgeStateSource = "COMMAND_STATUS_RECHECK"
  ) => {
    const base = nextBase();
    observe([parentRow(value, base), ...mappings.map((item) => childRow(item, value, base))], source);
  };
  const setParentStates = (
    value: "on" | "off",
    source: BridgeStateSource = "COMMAND_STATUS_RECHECK"
  ) => observe([parentRow(value, nextBase())], source);
  const setChildState = (
    childId: string,
    value: "on" | "off",
    source: BridgeStateSource = "COMMAND_STATUS_RECHECK"
  ) => {
    const mapping = mappings.find((item) => item.childId === childId);
    if (!mapping) throw new Error("unknown_child_fixture");
    observe([childRow(mapping, value, nextBase())], source);
  };
  setStates("on", "ADVANCED_SNAPSHOT");
  for (const [index, { childId }] of mappings.entries()) {
    const ack = 4700 + index;
    store.observe(sent(`42${ack}["find","api/device/status",{}]`));
    store.observe(
      received(
        `43${ack}[null,[${JSON.stringify({
          deviceId: childId,
          locationId: "loc_001",
          actions: [
            {
              deviceId: childId,
              locationId: "loc_001",
              componentId: "identifier_main",
              capabilityId: "identifier_switch",
              attributeName: "switch",
              value: "off",
              command: "on"
            },
            {
              deviceId: childId,
              locationId: "loc_001",
              componentId: "identifier_main",
              capabilityId: "identifier_switch",
              attributeName: "switch",
              value: "on",
              command: "off"
            }
          ]
        })}]]`
      )
    );
  }
  return { setStates, setParentStates, setChildState };
}

function readyDeviceStore(
  withToggle = true,
  normalizeStateToken?: (value: string) => string
): DeviceStore {
  const store = new DeviceStore({ ...(normalizeStateToken ? { normalizeStateToken } : {}) });
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
  if (withToggle) {
    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_toggle_power",
        label: "Power",
        commands: ["on", "off"]
      })
    ]);
  }
  return store;
}

function observeRefreshControl(store: DeviceStore): void {
  observeDeviceDetails(store, [
    detailSwatch("BUTTON", "button", {
      swatchId: "identifier_refresh",
      label: "Refresh",
      attributeName: "refresh",
      command: "refresh",
      commands: ["refresh"]
    })
  ]);
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
  capability = "identifier_switch",
  commandId?: string,
  component = "main"
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
          component,
          capability,
          attribute,
          value,
          unit: null,
          ...(commandId ? { command_id: commandId } : {})
        }
      }
    }
  ])}`;
}

function observeSceneSnapshot(store: DeviceStore, actions?: unknown[]): void {
  store.observe(sent('422["find","api/scene",{}]'));
  store.observe(
    received(
      `432[null,[${JSON.stringify({
        sceneId: "identifier_scene001",
        locationId: "loc_001",
        name: "Movie",
        updatedAt: "2026-08-25T00:00:00Z",
        ...(actions ? { actions } : {})
      })}]]`
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

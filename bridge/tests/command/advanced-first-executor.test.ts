import { describe, expect, test, vi } from "vitest";

import {
  AdvancedFirstCommandExecutor,
  type LegacyWebCommandExecutor
} from "../../src/command/advanced-first-executor.js";
import {
  CommandTransportError,
  type CommandTransport
} from "../../src/command/command-router.js";

const action = {
  action: "on",
  arguments: [],
  attribute: "switch",
  capability: "identifier_switch",
  command: "on" as const,
  component: "identifier_main",
  deviceId: "dev_001",
  deviceName: "Safe plug",
  locationId: "loc_001",
  locationNames: { loc_001: "Home" }
};

function advanced(execute: CommandTransport["execute"]): CommandTransport {
  return { name: "advanced", execute: vi.fn(execute) };
}

function legacy(): LegacyWebCommandExecutor {
  return {
    executeDeviceAction: vi.fn(async () => "location_native" as const),
    executeScene: vi.fn(async () => undefined),
    executeLocationAction: vi.fn(async () => undefined)
  };
}

describe("AdvancedFirstCommandExecutor", () => {
  test("does not touch the legacy browser command path after Advanced accepts", async () => {
    const fallback = legacy();
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => ({
        state: "ACCEPTED",
        transport: "advanced",
        acceptedAtMs: 10,
        commandId: "command-1"
      })),
      fallback,
      { canUseAdvanced: () => true }
    );

    await expect(executor.executeDeviceAction(action)).resolves.toMatchObject({
      transport: "advanced",
      commandId: "command-1"
    });
    expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("uses the existing native-before-DOM executor only after Advanced is unsupported", async () => {
    const fallback = legacy();
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new CommandTransportError("unsupported", "advanced");
      }),
      fallback,
      { now: () => 20, canUseAdvanced: () => true }
    );

    await expect(executor.executeDeviceAction(action)).resolves.toEqual({
      state: "ACCEPTED",
      transport: "location_native",
      sentAtMs: 20,
      acceptedAtMs: 20
    });
    expect(fallback.executeDeviceAction).toHaveBeenCalledOnce();
  });

  test("uses explicit Location native and DOM adapters in the required order", async () => {
    const order: string[] = [];
    const combined = vi.fn(async () => {
      throw new Error("combined path must not run");
    });
    const fallback = {
      executeDeviceAction: combined,
      executeLocationNative: vi.fn(async () => {
        order.push("location-native");
        throw new Error("command_native_unavailable");
      }),
      executeDomFallback: vi.fn(async () => {
        order.push("dom");
      })
    } as LegacyWebCommandExecutor & {
      executeLocationNative: (input: typeof action) => Promise<void>;
      executeDomFallback: (input: typeof action) => Promise<void>;
    };
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        order.push("advanced");
        throw new CommandTransportError("unsupported", "advanced");
      }),
      fallback,
      { now: () => 30, canUseAdvanced: () => true }
    );

    await expect(executor.executeDeviceAction(action)).resolves.toMatchObject({
      transport: "dom"
    });
    expect(order).toEqual(["advanced", "location-native", "dom"]);
    expect(combined).not.toHaveBeenCalled();
  });

  test("keeps DOM fallback disabled when Bridge configuration turns it off", async () => {
    const fallback = {
      executeDeviceAction: vi.fn(async () => "dom" as const),
      executeLocationNative: vi.fn(async () => {
        throw new Error("command_native_unavailable");
      }),
      executeDomFallback: vi.fn(async () => undefined)
    } as LegacyWebCommandExecutor;
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new CommandTransportError("unsupported", "advanced");
      }),
      fallback,
      { domFallbackEnabled: false, canUseAdvanced: () => true }
    );

    await expect(executor.executeDeviceAction(action)).rejects.toThrowError(
      "command_control_not_found"
    );
    expect(fallback.executeDomFallback).not.toHaveBeenCalled();
    expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("does not invoke fallback after a non-unsupported Advanced error", async () => {
    const fallback = legacy();
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new CommandTransportError("transient", "advanced");
      }),
      fallback,
      { canUseAdvanced: () => true }
    );

    await expect(executor.executeDeviceAction(action)).rejects.toThrowError(
      "command_execution_failed"
    );
    expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("uses the verified Web path until this exact Advanced command is proven", async () => {
    const fallback = legacy();
    const advancedTransport = advanced(async () => ({
      state: "ACCEPTED",
      transport: "advanced",
      acceptedAtMs: 10
    }));
    const executor = new AdvancedFirstCommandExecutor(advancedTransport, fallback);

    await expect(executor.executeDeviceAction(action)).resolves.toMatchObject({
      transport: "location_native"
    });
    expect(advancedTransport.execute).not.toHaveBeenCalled();
    expect(fallback.executeDeviceAction).toHaveBeenCalledOnce();
  });

  test("uses Advanced only when the exact command evidence policy approves it", async () => {
    const fallback = legacy();
    const advancedTransport = advanced(async () => ({
      state: "ACCEPTED",
      transport: "advanced",
      acceptedAtMs: 10,
      commandId: "command-1"
    }));
    const executor = new AdvancedFirstCommandExecutor(advancedTransport, fallback, {
      canUseAdvanced: (input) =>
        input.deviceId === "dev_001" &&
        input.component === "identifier_main" &&
        input.capability === "identifier_switch" &&
        input.command === "on"
    });

    await expect(executor.executeDeviceAction(action)).resolves.toMatchObject({
      transport: "advanced",
      commandId: "command-1"
    });
    expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("records safe route diagnostics without identifiers", async () => {
    const diagnostics: object[] = [];
    const fallback = legacy();
    fallback.executeDeviceAction = vi.fn(async () => {
      throw new Error("command_execution_failed");
    });
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new Error("must not run");
      }),
      fallback,
      { onDiagnostic: (event) => diagnostics.push(event) }
    );

    await expect(executor.executeDeviceAction(action)).rejects.toThrow(
      "command_execution_failed"
    );
    expect(diagnostics).toEqual([
      {
        transport: "location_native",
        stage: "dispatch",
        outcome: "attempt"
      },
      {
        transport: "location_native",
        stage: "dispatch",
        outcome: "failed",
        code: "command_execution_failed"
      }
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("dev_001");
  });

  test("keeps DOM disabled on the default verified Web path", async () => {
    const fallback = {
      executeDeviceAction: vi.fn(async () => {
        throw new Error("combined path must not run");
      }),
      executeLocationNative: vi.fn(async () => {
        throw new Error("command_native_unavailable");
      }),
      executeDomFallback: vi.fn(async () => undefined)
    } as LegacyWebCommandExecutor;
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new Error("Advanced must not run");
      }),
      fallback,
      { domFallbackEnabled: false }
    );

    await expect(executor.executeDeviceAction(action)).rejects.toThrow(
      "command_control_not_found"
    );
    expect(fallback.executeLocationNative).toHaveBeenCalledOnce();
    expect(fallback.executeDomFallback).not.toHaveBeenCalled();
    expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("uses verified DOM last when Location native is unavailable", async () => {
    const order: string[] = [];
    const fallback = {
      executeDeviceAction: vi.fn(async () => {
        throw new Error("combined path must not run");
      }),
      executeLocationNative: vi.fn(async () => {
        order.push("location-native");
        throw new Error("command_native_unavailable");
      }),
      executeDomFallback: vi.fn(async () => {
        order.push("dom");
      })
    } as LegacyWebCommandExecutor;
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new Error("Advanced must not run");
      }),
      fallback
    );

    await expect(executor.executeDeviceAction(action)).resolves.toMatchObject({
      transport: "dom"
    });
    expect(order).toEqual(["location-native", "dom"]);
    expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("keeps scenes and location actions on the existing verified executor", async () => {
    const fallback = legacy();
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new Error("not used");
      }),
      fallback
    );

    await executor.executeScene?.({ action: "execute", locationId: "loc_001", sceneName: "Night" });
    await executor.executeLocationAction?.({ action: "armAway", locationId: "loc_001" });

    expect(fallback.executeScene).toHaveBeenCalledOnce();
    expect(fallback.executeLocationAction).toHaveBeenCalledOnce();
  });
});

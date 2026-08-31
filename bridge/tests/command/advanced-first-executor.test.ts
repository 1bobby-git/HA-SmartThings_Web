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
      fallback
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
      { now: () => 20 }
    );

    await expect(executor.executeDeviceAction(action)).resolves.toEqual({
      state: "ACCEPTED",
      transport: "location_native",
      acceptedAtMs: 20
    });
    expect(fallback.executeDeviceAction).toHaveBeenCalledOnce();
  });

  test("does not invoke fallback after a non-unsupported Advanced error", async () => {
    const fallback = legacy();
    const executor = new AdvancedFirstCommandExecutor(
      advanced(async () => {
        throw new CommandTransportError("transient", "advanced");
      }),
      fallback
    );

    await expect(executor.executeDeviceAction(action)).rejects.toThrowError(
      "command_execution_failed"
    );
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

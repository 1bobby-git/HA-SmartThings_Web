import { describe, expect, test, vi } from "vitest";

import { ComponentCommandExecutor } from "../../src/command/component-command-executor.js";
import type { ComponentTransactionExecutionInput } from "../../src/command/command-service.js";
import type {
  CommandTransport,
  CommandTransportReceipt,
  RoutedCommandRequest
} from "../../src/command/command-router.js";

function transaction(command: "on" | "off"): ComponentTransactionExecutionInput {
  const components = ["main", "switch2", "switch3", "switch4"];
  const rollbackCommand = command === "on" ? "off" : "on";
  return {
    actions: components.map((component) => ({
      deviceId: "dev_001",
      component,
      capability: "switch",
      capabilityVersion: 1,
      command,
      arguments: []
    })),
    rollbackActions: components.map((component) => ({
      deviceId: "dev_001",
      component,
      capability: "switch",
      capabilityVersion: 1,
      command: rollbackCommand,
      arguments: []
    }))
  };
}

function fakeAdvanced(options: { failAt?: number; rollbackFails?: boolean } = {}): CommandTransport {
  let forwardCalls = 0;
  const execute = vi.fn(async (request: RoutedCommandRequest): Promise<CommandTransportReceipt> => {
    if (request.command === "off") {
      forwardCalls += 1;
      if (forwardCalls === options.failAt) throw new Error("raw dev_001 dispatch failure");
    } else if (options.rollbackFails) {
      throw new Error("raw dev_001 rollback failure");
    }
    return {
      state: "ACCEPTED",
      transport: "advanced",
      acceptedAtMs: forwardCalls
    };
  });
  return { name: "advanced", execute };
}

describe("ComponentCommandExecutor", () => {
  test("executes component actions in stable order", async () => {
    const transport = fakeAdvanced();
    const executor = new ComponentCommandExecutor(transport);

    const receipts = await executor.execute(transaction("off"));

    expect(transport.execute).toHaveBeenCalledTimes(4);
    expect(vi.mocked(transport.execute).mock.calls.map(([request]) => request.component)).toEqual([
      "main",
      "switch2",
      "switch3",
      "switch4"
    ]);
    expect(receipts.every((receipt) => receipt.transport === "advanced")).toBe(true);
  });

  test("rolls back completed components after a partial dispatch failure", async () => {
    const transport = fakeAdvanced({ failAt: 3 });
    const executor = new ComponentCommandExecutor(transport);

    await expect(executor.execute(transaction("off"))).rejects.toThrow(
      "component_command_partial_failure"
    );
    expect(vi.mocked(transport.execute).mock.calls.map(([request]) => request.command)).toEqual([
      "off",
      "off",
      "off",
      "on",
      "on"
    ]);
    expect(vi.mocked(transport.execute).mock.calls.map(([request]) => request.component)).toEqual([
      "main",
      "switch2",
      "switch3",
      "switch2",
      "main"
    ]);
  });

  test("reports rollback failure without raw identifiers", async () => {
    const transport = fakeAdvanced({ failAt: 3, rollbackFails: true });

    await expect(new ComponentCommandExecutor(transport).execute(transaction("off"))).rejects.toMatchObject({
      message: "component_command_rollback_failed"
    });
  });
});

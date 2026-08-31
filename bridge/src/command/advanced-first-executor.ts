import type {
  DeviceActionExecutionInput,
  SafeCommandExecutor
} from "./command-service.js";
import {
  CommandTransportError,
  OrderedCommandRouter,
  type CommandTransport,
  type CommandTransportReceipt
} from "./command-router.js";

export interface LegacyWebCommandExecutor {
  executeDeviceAction(
    input: DeviceActionExecutionInput
  ): Promise<"location_native" | "dom" | void>;
  executeScene?: SafeCommandExecutor["executeScene"];
  executeLocationAction?: SafeCommandExecutor["executeLocationAction"];
}

export class AdvancedFirstCommandExecutor implements SafeCommandExecutor {
  readonly #now: () => number;

  constructor(
    private readonly advanced: CommandTransport,
    private readonly legacy: LegacyWebCommandExecutor,
    options: { now?: () => number } = {}
  ) {
    this.#now = options.now ?? Date.now;
  }

  async executeDeviceAction(
    input: DeviceActionExecutionInput
  ): Promise<CommandTransportReceipt> {
    const legacyTransport: CommandTransport = {
      name: "location_native",
      execute: async () => {
        const transport = (await this.legacy.executeDeviceAction(input)) ?? "location_native";
        return {
          state: "ACCEPTED",
          transport,
          acceptedAtMs: this.#now()
        };
      }
    };
    try {
      return await new OrderedCommandRouter({
        advanced: this.advanced,
        locationNative: legacyTransport
      }).execute({
        deviceId: input.deviceId,
        component: input.component,
        capability: input.capability,
        command: input.nativeCommand ?? input.optionCommand ?? input.command,
        arguments: input.arguments
      });
    } catch (error) {
      if (error instanceof CommandTransportError) {
        if (error.code === "authentication") throw new Error("command_login_required");
        if (error.code === "unsupported") throw new Error("command_control_not_found");
        throw new Error("command_execution_failed");
      }
      throw error;
    }
  }

  async executeScene(
    input: Parameters<NonNullable<SafeCommandExecutor["executeScene"]>>[0]
  ): Promise<void> {
    if (!this.legacy.executeScene) throw new Error("command_control_not_found");
    await this.legacy.executeScene(input);
  }

  async executeLocationAction(
    input: Parameters<NonNullable<SafeCommandExecutor["executeLocationAction"]>>[0]
  ): Promise<void> {
    if (!this.legacy.executeLocationAction) throw new Error("command_control_not_found");
    await this.legacy.executeLocationAction(input);
  }
}

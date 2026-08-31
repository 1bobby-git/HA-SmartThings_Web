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
import {
  DomFallbackAdapter,
  LocationNativeCommandAdapter
} from "./fallback-adapters.js";

export interface LegacyWebCommandExecutor {
  executeDeviceAction(
    input: DeviceActionExecutionInput
  ): Promise<"location_native" | "dom" | void>;
  executeLocationNative?(input: DeviceActionExecutionInput): Promise<void>;
  executeDomFallback?(input: DeviceActionExecutionInput): Promise<void>;
  executeScene?: SafeCommandExecutor["executeScene"];
  executeLocationAction?: SafeCommandExecutor["executeLocationAction"];
}

export class AdvancedFirstCommandExecutor implements SafeCommandExecutor {
  readonly #now: () => number;
  readonly #domFallbackEnabled: boolean;

  constructor(
    private readonly advanced: CommandTransport,
    private readonly legacy: LegacyWebCommandExecutor,
    options: { now?: () => number; domFallbackEnabled?: boolean } = {}
  ) {
    this.#now = options.now ?? Date.now;
    this.#domFallbackEnabled = options.domFallbackEnabled ?? true;
  }

  async executeDeviceAction(
    input: DeviceActionExecutionInput
  ): Promise<CommandTransportReceipt> {
    const routed = {
      deviceId: input.deviceId,
      component: input.component,
      capability: input.capability,
      ...(input.capabilityVersion === undefined
        ? {}
        : { capabilityVersion: input.capabilityVersion }),
      command: input.nativeCommand ?? input.optionCommand ?? input.command,
      arguments: input.arguments
    };
    const explicitFallbacks =
      this.legacy.executeLocationNative && this.legacy.executeDomFallback
        ? {
            locationNative: new LocationNativeCommandAdapter(
              async () => await this.legacy.executeLocationNative?.(input),
              this.#now
            ),
            dom: new DomFallbackAdapter(
              async () => await this.legacy.executeDomFallback?.(input),
              this.#now
            )
          }
        : undefined;
    const legacyTransport: CommandTransport = explicitFallbacks?.locationNative ?? {
      name: "location_native",
      execute: async () => {
        const sentAtMs = this.#now();
        const transport = (await this.legacy.executeDeviceAction(input)) ?? "location_native";
        return {
          state: "ACCEPTED",
          transport,
          sentAtMs,
          acceptedAtMs: this.#now()
        };
      }
    };
    try {
      return await new OrderedCommandRouter({
        advanced: this.advanced,
        locationNative: legacyTransport,
        ...(explicitFallbacks?.dom
          ? { dom: explicitFallbacks.dom, domFallbackEnabled: this.#domFallbackEnabled }
          : {})
      }).execute(routed);
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

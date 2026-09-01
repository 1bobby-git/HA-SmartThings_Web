import type {
  ComponentTransactionExecutionInput,
  DeviceActionExecutionInput,
  SafeCommandExecutor
} from "./command-service.js";
import {
  ComponentCommandExecutor,
  type ComponentCommandDiagnostic
} from "./component-command-executor.js";
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

export interface CommandRouteDiagnostic {
  transport: "advanced" | "location_native" | "dom";
  stage: "dispatch" | "receipt";
  outcome: "attempt" | "accepted" | "failed";
  code?: string;
}

export interface AdvancedFirstCommandExecutorOptions {
  now?: () => number;
  domFallbackEnabled?: boolean;
  canUseAdvanced?: (input: DeviceActionExecutionInput) => boolean;
  onDiagnostic?: (event: CommandRouteDiagnostic) => void;
  onComponentDiagnostic?: (event: ComponentCommandDiagnostic) => void;
}

export class AdvancedFirstCommandExecutor implements SafeCommandExecutor {
  readonly #componentExecutor: ComponentCommandExecutor;
  readonly #now: () => number;
  readonly #domFallbackEnabled: boolean;
  readonly #canUseAdvanced: (input: DeviceActionExecutionInput) => boolean;
  readonly #onDiagnostic: ((event: CommandRouteDiagnostic) => void) | undefined;

  constructor(
    private readonly advanced: CommandTransport,
    private readonly legacy: LegacyWebCommandExecutor,
    options: AdvancedFirstCommandExecutorOptions = {}
  ) {
    this.#componentExecutor = new ComponentCommandExecutor(
      advanced,
      options.onComponentDiagnostic
    );
    this.#now = options.now ?? Date.now;
    this.#domFallbackEnabled = options.domFallbackEnabled ?? true;
    this.#canUseAdvanced = options.canUseAdvanced ?? (() => false);
    this.#onDiagnostic = options.onDiagnostic;
  }

  async executeComponentTransaction(
    input: ComponentTransactionExecutionInput
  ): Promise<CommandTransportReceipt[]> {
    return await this.#componentExecutor.execute(input);
  }

  async executeDeviceAction(
    input: DeviceActionExecutionInput
  ): Promise<CommandTransportReceipt> {
    if (input.requireLocationNative === true || !this.#canUseAdvanced(input)) {
      return await this.#executeVerifiedWeb(input);
    }
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

  async #executeVerifiedWeb(
    input: DeviceActionExecutionInput
  ): Promise<CommandTransportReceipt> {
    const executeLocationNative = this.legacy.executeLocationNative?.bind(this.legacy);
    const executeDomFallback = this.legacy.executeDomFallback?.bind(this.legacy);
    const requireLocationNative = input.requireLocationNative === true;
    if (executeLocationNative && (executeDomFallback || requireLocationNative)) {
      const sentAtMs = this.#now();
      this.#diagnostic({
        transport: "location_native",
        stage: "dispatch",
        outcome: "attempt"
      });
      try {
        await executeLocationNative(input);
        this.#diagnostic({
          transport: "location_native",
          stage: "receipt",
          outcome: "accepted"
        });
        return {
          state: "ACCEPTED",
          transport: "location_native",
          sentAtMs,
          acceptedAtMs: this.#now()
        };
      } catch (error) {
        this.#diagnostic({
          transport: "location_native",
          stage: "dispatch",
          outcome: "failed",
          code: safeCommandCode(error)
        });
        if (!(error instanceof Error) || error.message !== "command_native_unavailable") {
          throw error;
        }
      }
      if (requireLocationNative || !this.#domFallbackEnabled || !executeDomFallback) {
        throw new Error("command_control_not_found");
      }
      this.#diagnostic({
        transport: "dom",
        stage: "dispatch",
        outcome: "attempt"
      });
      try {
        await executeDomFallback(input);
        this.#diagnostic({
          transport: "dom",
          stage: "receipt",
          outcome: "accepted"
        });
        return {
          state: "ACCEPTED",
          transport: "dom",
          sentAtMs,
          acceptedAtMs: this.#now()
        };
      } catch (error) {
        this.#diagnostic({
          transport: "dom",
          stage: "dispatch",
          outcome: "failed",
          code: safeCommandCode(error)
        });
        throw error;
      }
    }
    if (requireLocationNative) {
      throw new Error("command_control_not_found");
    }
    this.#diagnostic({
      transport: "location_native",
      stage: "dispatch",
      outcome: "attempt"
    });
    const sentAtMs = this.#now();
    try {
      const transport = (await this.legacy.executeDeviceAction(input)) ?? "location_native";
      this.#diagnostic({
        transport,
        stage: "receipt",
        outcome: "accepted"
      });
      return {
        state: "ACCEPTED",
        transport,
        sentAtMs,
        acceptedAtMs: this.#now()
      };
    } catch (error) {
      this.#diagnostic({
        transport: "location_native",
        stage: "dispatch",
        outcome: "failed",
        code: safeCommandCode(error)
      });
      throw error;
    }
  }

  #diagnostic(event: CommandRouteDiagnostic): void {
    try {
      this.#onDiagnostic?.(event);
    } catch {
      // Diagnostics must never change command execution.
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

function safeCommandCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^command_[a-z0-9_]+$/u.test(error.message)
  ) {
    return error.message;
  }
  return "command_execution_failed";
}

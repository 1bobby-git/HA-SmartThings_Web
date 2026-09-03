import type {
  ComponentActionExecutionInput,
  ComponentTransactionExecutionInput
} from "./command-service.js";
import type {
  CommandTransport,
  CommandTransportErrorCode,
  CommandTransportReceipt,
  RoutedCommandRequest
} from "./command-router.js";
import { CommandTransportError } from "./command-router.js";

export interface ComponentCommandDiagnostic {
  phase: "dispatch" | "rollback";
  ordinal: number;
  outcome: "attempt" | "accepted" | "failed";
  code?: CommandTransportErrorCode | "unknown";
}

export class ComponentCommandExecutor {
  constructor(
    private readonly advanced: CommandTransport,
    private readonly onDiagnostic?: (event: ComponentCommandDiagnostic) => void
  ) {
    if (advanced.name !== "advanced") throw new Error("command_transport_order_invalid");
  }

  async execute(
    input: ComponentTransactionExecutionInput
  ): Promise<CommandTransportReceipt[]> {
    if (!alignedRollback(input)) {
      throw new Error("component_command_rollback_failed");
    }
    const receipts: CommandTransportReceipt[] = [];
    const completed: number[] = [];
    for (const [index, action] of input.actions.entries()) {
      this.#diagnostic({ phase: "dispatch", ordinal: index + 1, outcome: "attempt" });
      try {
        receipts.push(await this.advanced.execute(routed(action)));
        completed.push(index);
        this.#diagnostic({ phase: "dispatch", ordinal: index + 1, outcome: "accepted" });
      } catch (error) {
        this.#diagnostic({
          phase: "dispatch",
          ordinal: index + 1,
          outcome: "failed",
          code: diagnosticCode(error)
        });
        let rollbackFailed = false;
        for (const completedIndex of completed.reverse()) {
          const rollback = input.rollbackActions[completedIndex];
          if (!rollback) {
            rollbackFailed = true;
            continue;
          }
          this.#diagnostic({
            phase: "rollback",
            ordinal: completedIndex + 1,
            outcome: "attempt"
          });
          try {
            await this.advanced.execute(routed(rollback));
            this.#diagnostic({
              phase: "rollback",
              ordinal: completedIndex + 1,
              outcome: "accepted"
            });
          } catch (rollbackError) {
            rollbackFailed = true;
            this.#diagnostic({
              phase: "rollback",
              ordinal: completedIndex + 1,
              outcome: "failed",
              code: diagnosticCode(rollbackError)
            });
          }
        }
        throw new Error(
          rollbackFailed
            ? "component_command_rollback_failed"
            : "component_command_partial_failure"
        );
      }
    }
    return receipts;
  }

  #diagnostic(event: ComponentCommandDiagnostic): void {
    try {
      this.onDiagnostic?.(event);
    } catch {
      // Diagnostics must never change component execution or rollback.
    }
  }
}

function routed(action: ComponentActionExecutionInput): RoutedCommandRequest {
  return {
    deviceId: action.deviceId,
    component: action.component,
    capability: action.capability,
    capabilityVersion: action.capabilityVersion,
    command: action.command,
    arguments: action.arguments
  };
}

function alignedRollback(input: ComponentTransactionExecutionInput): boolean {
  return input.actions.length === input.rollbackActions.length && input.actions.every(
    (action, index) => {
      const rollback = input.rollbackActions[index];
      return rollback !== undefined &&
        rollback.deviceId === action.deviceId &&
        rollback.component === action.component &&
        rollback.capability === action.capability &&
        rollback.capabilityVersion === action.capabilityVersion;
    }
  );
}

function diagnosticCode(error: unknown): CommandTransportErrorCode | "unknown" {
  return error instanceof CommandTransportError ? error.code : "unknown";
}

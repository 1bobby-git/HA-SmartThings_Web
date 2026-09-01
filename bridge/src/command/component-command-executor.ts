import type {
  ComponentActionExecutionInput,
  ComponentTransactionExecutionInput
} from "./command-service.js";
import type {
  CommandTransport,
  CommandTransportReceipt,
  RoutedCommandRequest
} from "./command-router.js";

export class ComponentCommandExecutor {
  constructor(private readonly advanced: CommandTransport) {
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
    try {
      for (const [index, action] of input.actions.entries()) {
        receipts.push(await this.advanced.execute(routed(action)));
        completed.push(index);
      }
      return receipts;
    } catch {
      let rollbackFailed = false;
      for (const index of completed.reverse()) {
        const rollback = input.rollbackActions[index];
        if (!rollback) {
          rollbackFailed = true;
          continue;
        }
        try {
          await this.advanced.execute(routed(rollback));
        } catch {
          rollbackFailed = true;
        }
      }
      throw new Error(
        rollbackFailed
          ? "component_command_rollback_failed"
          : "component_command_partial_failure"
      );
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

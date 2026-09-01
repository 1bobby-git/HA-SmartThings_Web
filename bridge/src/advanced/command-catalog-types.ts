import type { AdvancedCapabilityArgumentDefinition } from "./types.js";

export interface AdvancedCommandDescriptor {
  component: string;
  componentRole?: string;
  capability: string;
  capabilityVersion: number;
  command: string;
  arguments: AdvancedCapabilityArgumentDefinition[];
  transport: "advanced";
  confirmation: "accepted_receipt" | "state";
  label: string;
  labelSource: "visible_web" | "capability" | "role" | "fallback";
}

export interface AdvancedCommandOmission {
  component: string;
  capability: string;
  command?: string;
  reason:
    | "definition_unavailable"
    | "dangerous_command"
    | "sensitive_argument"
    | "schema_invalid";
}

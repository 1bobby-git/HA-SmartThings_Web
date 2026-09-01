import {
  CapabilityDefinitionCache,
  CapabilityValidationError,
  type CapabilityDefinitionLoader
} from "./capability-cache.js";
import type { AdvancedCommandDescriptor, AdvancedCommandOmission } from "./command-catalog-types.js";
import type {
  AdvancedCapabilityCommandDefinition,
  AdvancedCapabilityDefinition,
  AdvancedCapabilitySchema
} from "./types.js";
import { safeAdvancedCommandReason } from "./safe-command-policy.js";

export interface CapabilityBinding {
  deviceId: string;
  component: string;
  componentRole?: string;
  capability: string;
  rawCapability: string;
  version: number;
}

export interface AdvancedCommandCatalogResult {
  commandsByDevice: Map<string, AdvancedCommandDescriptor[]>;
  omissionsByDevice: Map<string, AdvancedCommandOmission[]>;
  omissions: AdvancedCommandOmission[];
}

export interface AdvancedCommandCatalogOptions {
  concurrency?: number;
}

interface DefinitionResult {
  key: string;
  commands?: AdvancedCapabilityCommandDefinition[];
  invalidCommands?: string[];
  reason?: AdvancedCommandOmission["reason"];
}

const DEFAULT_CONCURRENCY = 4;
const STATELESS_COMMAND_PATTERN =
  /^(?:speak|refresh|press|push|momentary|ping|beep|identify|refresh[A-Z].*)$/u;
const PUBLIC_SCHEMA_KEYS = new Set(["type", "enum", "minimum", "maximum"]);
const MAX_PUBLIC_ENUM_VALUES = 128;
const MAX_PUBLIC_ENUM_STRING_LENGTH = 1024;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;

export class AdvancedCommandCatalog {
  readonly #cache: CapabilityDefinitionCache;
  readonly #concurrency: number;

  constructor(loader: CapabilityDefinitionLoader, options: AdvancedCommandCatalogOptions = {}) {
    this.#cache = new CapabilityDefinitionCache(loader);
    this.#concurrency = normalizeConcurrency(options.concurrency);
  }

  async build(bindings: readonly CapabilityBinding[]): Promise<AdvancedCommandCatalogResult> {
    const definitions = await this.#loadDefinitions(bindings);
    const commandsByDevice = new Map<string, AdvancedCommandDescriptor[]>();
    const omissionsByDevice = new Map<string, AdvancedCommandOmission[]>();
    const omissions: AdvancedCommandOmission[] = [];
    const pushOmission = (binding: CapabilityBinding, value: AdvancedCommandOmission): void => {
      omissions.push(value);
      const deviceOmissions = omissionsByDevice.get(binding.deviceId) ?? [];
      deviceOmissions.push(value);
      omissionsByDevice.set(binding.deviceId, deviceOmissions);
    };

    for (const binding of sortedBindings(bindings)) {
      const result = definitions.get(bindingKey(binding));
      if (!result || result.reason) {
        pushOmission(binding, omission(binding, result?.reason ?? "definition_unavailable"));
        continue;
      }
      for (const command of result.invalidCommands ?? []) {
        pushOmission(binding, omission(binding, "schema_invalid", command));
      }
      for (const command of result.commands ?? []) {
        const descriptor = descriptorFor(binding, command);
        const blocked = safeAdvancedCommandReason(descriptor);
        if (blocked) {
          pushOmission(binding, omission(binding, blocked, command.name));
          continue;
        }
        const deviceCommands = commandsByDevice.get(binding.deviceId) ?? [];
        deviceCommands.push(descriptor);
        commandsByDevice.set(binding.deviceId, deviceCommands);
      }
    }

    return {
      commandsByDevice: sortCommandMap(commandsByDevice),
      omissionsByDevice: sortOmissionMap(omissionsByDevice),
      omissions: omissions.sort(compareOmissions)
    };
  }

  async #loadDefinitions(
    bindings: readonly CapabilityBinding[]
  ): Promise<Map<string, DefinitionResult>> {
    const keys = [
      ...new Map(
        bindings.map((binding) => [
          bindingKey(binding),
          { rawCapability: binding.rawCapability, version: binding.version }
        ])
      ).entries()
    ].sort(([left], [right]) => left.localeCompare(right));
    const results = new Map<string, DefinitionResult>();
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = keys[next];
        next += 1;
        if (!entry) return;
        const [key, value] = entry;
        try {
          const definition = await this.#cache.get(value.rawCapability, value.version);
          const commands = commandDefinitions(definition);
          results.set(key, {
            key,
            commands: commands.valid,
            invalidCommands: commands.invalid
          });
        } catch (error) {
          results.set(key, {
            key,
            reason: error instanceof CapabilityValidationError
              ? "schema_invalid"
              : "definition_unavailable"
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, Math.max(keys.length, 1)) }, () => worker())
    );
    return results;
  }
}

function commandDefinitions(definition: AdvancedCapabilityDefinition): {
  valid: AdvancedCapabilityCommandDefinition[];
  invalid: string[];
} {
  if (!isRecord(definition.commands)) {
    throw new CapabilityValidationError("capability_definition_invalid");
  }
  const valid: AdvancedCapabilityCommandDefinition[] = [];
  const invalid: string[] = [];
  for (const [name, rawCommand] of Object.entries(definition.commands).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const command = isRecord(rawCommand) ? rawCommand : undefined;
    const rawArguments = command?.arguments;
    if (!safeToken(name) || !command || !Array.isArray(rawArguments)) {
      invalid.push(name);
      continue;
    }
    const parsedArguments = parseArguments(rawArguments);
    if (!parsedArguments) {
      invalid.push(name);
      continue;
    }
    valid.push({ name, arguments: parsedArguments });
  }
  return { valid, invalid };
}

function parseArguments(values: unknown[]): AdvancedCapabilityCommandDefinition["arguments"] | undefined {
  const parsed: AdvancedCapabilityCommandDefinition["arguments"] = [];
  for (const value of values) {
    if (!isRecord(value)) return undefined;
    const name = typeof value.name === "string" ? value.name : undefined;
    const schema = isRecord(value.schema) ? parseSchema(value.schema) : undefined;
    if (!name || !safeToken(name) || !schema) return undefined;
    parsed.push({
      name,
      required: value.required !== false,
      sensitive: value.sensitive === true,
      schema,
      ...(typeof value.unit === "string" && value.unit.length <= 64
        ? { unit: value.unit }
        : {})
    });
  }
  return parsed;
}

function parseSchema(value: Record<string, unknown>): AdvancedCapabilitySchema | undefined {
  if (!Object.keys(value).every((key) => PUBLIC_SCHEMA_KEYS.has(key))) return undefined;
  const type = value.type;
  if (
    type !== undefined &&
    !["array", "boolean", "integer", "number", "object", "string"].includes(String(type))
  ) {
    return undefined;
  }
  const enumValues = value.enum === undefined ? undefined : parseSafeEnumValues(value.enum);
  if (value.enum !== undefined && enumValues === undefined) return undefined;
  const minimum = value.minimum;
  const maximum = value.maximum;
  if (
    (minimum !== undefined && (typeof minimum !== "number" || !Number.isFinite(minimum))) ||
    (maximum !== undefined && (typeof maximum !== "number" || !Number.isFinite(maximum)))
  ) {
    return undefined;
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) return undefined;
  const schema: AdvancedCapabilitySchema = {};
  if (type !== undefined) schema.type = type as NonNullable<AdvancedCapabilitySchema["type"]>;
  if (enumValues !== undefined) schema.enum = enumValues;
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
}

function parseSafeEnumValues(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_ENUM_VALUES) return undefined;
  const enumValues: unknown[] = [];
  for (const item of value) {
    if (item === null || typeof item === "boolean") {
      enumValues.push(item);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      enumValues.push(item);
    } else if (
      typeof item === "string" &&
      item.length <= MAX_PUBLIC_ENUM_STRING_LENGTH &&
      !CONTROL_CHAR_PATTERN.test(item)
    ) {
      enumValues.push(item);
    } else {
      return undefined;
    }
  }
  return enumValues;
}

function safeToken(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9_.:-]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descriptorFor(
  binding: CapabilityBinding,
  command: AdvancedCapabilityCommandDefinition
): AdvancedCommandDescriptor {
  return {
    component: binding.component,
    ...(binding.componentRole ? { componentRole: binding.componentRole } : {}),
    capability: binding.capability,
    capabilityVersion: binding.version,
    command: command.name,
    arguments: command.arguments.map((argument) => ({
      ...argument,
      schema: cloneSchema(argument.schema)
    })),
    transport: "advanced",
    confirmation: STATELESS_COMMAND_PATTERN.test(command.name) ? "accepted_receipt" : "state",
    label: command.name || binding.capability,
    labelSource: "capability"
  };
}

function cloneSchema(
  schema: AdvancedCapabilityCommandDefinition["arguments"][number]["schema"]
): AdvancedCapabilityCommandDefinition["arguments"][number]["schema"] {
  const clone: AdvancedCapabilityCommandDefinition["arguments"][number]["schema"] = {};
  if (schema.type !== undefined) clone.type = schema.type;
  if (schema.enum) clone.enum = [...schema.enum];
  if (schema.minimum !== undefined) clone.minimum = schema.minimum;
  if (schema.maximum !== undefined) clone.maximum = schema.maximum;
  return clone;
}

function omission(
  binding: CapabilityBinding,
  reason: AdvancedCommandOmission["reason"],
  command?: string
): AdvancedCommandOmission {
  return {
    component: binding.component,
    capability: binding.capability,
    ...(command ? { command } : {}),
    reason
  };
}

function bindingKey(binding: CapabilityBinding): string {
  return `${binding.rawCapability}\u0000${binding.version}`;
}

function sortedBindings(bindings: readonly CapabilityBinding[]): CapabilityBinding[] {
  return [...bindings].sort((left, right) =>
    [
      left.deviceId.localeCompare(right.deviceId),
      left.component.localeCompare(right.component),
      left.capability.localeCompare(right.capability),
      left.rawCapability.localeCompare(right.rawCapability),
      left.version - right.version
    ].find((result) => result !== 0) ?? 0
  );
}

function sortCommandMap(
  commandsByDevice: Map<string, AdvancedCommandDescriptor[]>
): Map<string, AdvancedCommandDescriptor[]> {
  const sorted = new Map<string, AdvancedCommandDescriptor[]>();
  for (const [deviceId, commands] of [...commandsByDevice.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    sorted.set(
      deviceId,
      commands.sort((left, right) =>
        `${left.component}:${left.capability}:${left.command}`.localeCompare(
          `${right.component}:${right.capability}:${right.command}`
        )
      )
    );
  }
  return sorted;
}

function sortOmissionMap(
  omissionsByDevice: Map<string, AdvancedCommandOmission[]>
): Map<string, AdvancedCommandOmission[]> {
  const sorted = new Map<string, AdvancedCommandOmission[]>();
  for (const [deviceId, omissions] of [...omissionsByDevice.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    sorted.set(deviceId, omissions.sort(compareOmissions));
  }
  return sorted;
}

function compareOmissions(left: AdvancedCommandOmission, right: AdvancedCommandOmission): number {
  return `${left.component}:${left.capability}:${left.command ?? ""}:${left.reason}`.localeCompare(
    `${right.component}:${right.capability}:${right.command ?? ""}:${right.reason}`
  );
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_CONCURRENCY;
  return Math.min(value, 32);
}

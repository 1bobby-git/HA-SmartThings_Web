import type {
  AdvancedCapabilityArgumentDefinition,
  AdvancedCapabilityCommandDefinition,
  AdvancedCapabilityDefinition,
  AdvancedCapabilitySchema
} from "./types.js";

export type CapabilityDefinitionLoader = (
  capabilityId: string,
  version: number
) => Promise<AdvancedCapabilityDefinition>;

export type CapabilityValidationErrorCode =
  | "capability_definition_invalid"
  | "unsupported_command"
  | "missing_argument"
  | "unexpected_argument"
  | "argument_type_invalid"
  | "argument_enum_invalid"
  | "argument_out_of_range";

export class CapabilityValidationError extends Error {
  constructor(readonly code: CapabilityValidationErrorCode) {
    super(code);
    this.name = "CapabilityValidationError";
  }
}

export class CapabilityDefinitionCache {
  readonly #entries = new Map<string, Promise<AdvancedCapabilityDefinition>>();

  constructor(
    private readonly load: CapabilityDefinitionLoader,
    private readonly maxEntries = 512
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
      throw new Error("capability_cache_size_invalid");
    }
  }

  get(capabilityId: string, version: number): Promise<AdvancedCapabilityDefinition> {
    const key = cacheKey(capabilityId, version);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const loaded = this.load(capabilityId, version)
      .then((definition) => {
        if (definition.id !== capabilityId || definition.version !== version) {
          throw new CapabilityValidationError("capability_definition_invalid");
        }
        return definition;
      })
      .catch((error: unknown) => {
        this.#entries.delete(key);
        throw error;
      });
    this.#entries.set(key, loaded);
    this.#prune();
    return loaded;
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #prune(): void {
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

export function parseCapabilityDefinition(value: unknown): AdvancedCapabilityDefinition {
  if (!isRecord(value)) throw invalidDefinition();
  const id = safeToken(value.id) ? value.id : safeToken(value.capabilityId) ? value.capabilityId : undefined;
  const version = safeVersion(value.version);
  if (!id || version === undefined || !isRecord(value.attributes) || !isRecord(value.commands)) {
    throw invalidDefinition();
  }
  const commands: Record<string, AdvancedCapabilityCommandDefinition> = {};
  for (const [name, rawCommand] of Object.entries(value.commands)) {
    if (!safeToken(name) || !isRecord(rawCommand)) throw invalidDefinition();
    const rawArguments = rawCommand.arguments ?? [];
    if (!Array.isArray(rawArguments)) throw invalidDefinition();
    commands[name] = {
      name,
      arguments: rawArguments.map((argument) => parseArgument(argument))
    };
  }
  return {
    id,
    version,
    attributes: value.attributes,
    commands
  };
}

export function validateCommandArguments(
  definition: AdvancedCapabilityDefinition,
  commandName: string,
  values: readonly unknown[]
): unknown[] {
  const command = definition.commands[commandName];
  if (!command) throw new CapabilityValidationError("unsupported_command");
  if (values.length > command.arguments.length) {
    throw new CapabilityValidationError("unexpected_argument");
  }
  const requiredCount = command.arguments.filter((argument) => argument.required).length;
  if (values.length < requiredCount) throw new CapabilityValidationError("missing_argument");
  const result: unknown[] = [];
  for (let index = 0; index < command.arguments.length; index += 1) {
    const argument = command.arguments[index];
    if (!argument) continue;
    if (index >= values.length) {
      if (argument.required) throw new CapabilityValidationError("missing_argument");
      continue;
    }
    const value = values[index];
    validateValue(argument.schema, value);
    result.push(value);
  }
  return result;
}

function parseArgument(value: unknown): AdvancedCapabilityArgumentDefinition {
  if (!isRecord(value) || !safeToken(value.name) || !isRecord(value.schema)) {
    throw invalidDefinition();
  }
  return {
    name: value.name,
    required: value.required !== false,
    sensitive: value.sensitive === true,
    schema: parseSchema(value.schema),
    ...(typeof value.unit === "string" && value.unit.length <= 64 ? { unit: value.unit } : {})
  };
}

function parseSchema(value: Record<string, unknown>): AdvancedCapabilitySchema {
  const type = value.type;
  if (
    type !== undefined &&
    !["array", "boolean", "integer", "number", "object", "string"].includes(
      String(type)
    )
  ) {
    throw invalidDefinition();
  }
  const minimum = safeFiniteNumber(value.minimum);
  const maximum = safeFiniteNumber(value.maximum);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw invalidDefinition();
  }
  const parsed: AdvancedCapabilitySchema = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!["type", "enum", "minimum", "maximum"].includes(key)) parsed[key] = entry;
  }
  if (type !== undefined) parsed.type = type as NonNullable<AdvancedCapabilitySchema["type"]>;
  if (Array.isArray(value.enum)) parsed.enum = [...value.enum];
  if (minimum !== undefined) parsed.minimum = minimum;
  if (maximum !== undefined) parsed.maximum = maximum;
  return parsed;
}

function validateValue(schema: AdvancedCapabilitySchema, value: unknown): void {
  if (schema.type === "integer" && (!Number.isSafeInteger(value) || typeof value !== "number")) {
    throw new CapabilityValidationError("argument_type_invalid");
  }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new CapabilityValidationError("argument_type_invalid");
  }
  if (schema.type === "string" && typeof value !== "string") {
    throw new CapabilityValidationError("argument_type_invalid");
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new CapabilityValidationError("argument_type_invalid");
  }
  if (schema.type === "array" && !Array.isArray(value)) {
    throw new CapabilityValidationError("argument_type_invalid");
  }
  if (schema.type === "object" && !isRecord(value)) {
    throw new CapabilityValidationError("argument_type_invalid");
  }
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    throw new CapabilityValidationError("argument_enum_invalid");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new CapabilityValidationError("argument_out_of_range");
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new CapabilityValidationError("argument_out_of_range");
    }
  }
}

function cacheKey(capabilityId: string, version: number): string {
  if (!safeToken(capabilityId) || safeVersion(version) === undefined) {
    throw new CapabilityValidationError("capability_definition_invalid");
  }
  return `${capabilityId}@${version}`;
}

function safeToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_.:-]+$/u.test(value)
  );
}

function safeVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function invalidDefinition(): CapabilityValidationError {
  return new CapabilityValidationError("capability_definition_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

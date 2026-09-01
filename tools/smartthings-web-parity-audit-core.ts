import { safeAdvancedCommandReason } from "../bridge/src/advanced/safe-command-policy.js";
import type { AdvancedCommandDescriptor, AdvancedCommandOmission } from "../bridge/src/advanced/command-catalog-types.js";

const MAX_DEVICES = 5_000;
const MAX_COMMANDS_PER_DEVICE = 500;
const MAX_CONTROLS_PER_DEVICE = 1_000;
const MAX_OMISSIONS_PER_DEVICE = 1_000;
const MAX_PROJECTIONS = 20_000;
const MAX_STRING_LENGTH = 1_024;
const MAX_DEPTH = 8;
const MAX_NODES = 150_000;

const DEVICE_ALIAS = /^dev_[0-9]+$/u;
const RAW_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const SECRET_WORD = /(?:authorization|bearer|cookie|refresh[_-]?token|access[_-]?token|secret|password|session)/iu;
const SAFE_OMISSION_REASONS = new Set<AdvancedCommandOmission["reason"]>([
  "definition_unavailable",
  "dangerous_command",
  "sensitive_argument",
  "schema_invalid"
]);
const NON_FAILING_OMISSION_REASONS = new Set<AdvancedCommandOmission["reason"]>([
  "sensitive_argument",
  "schema_invalid"
]);

export interface WebParityInventory {
  devices: WebParityDevice[];
}

export interface WebParityDevice {
  id: string;
  controls?: WebParityControl[];
  advancedCommands?: AdvancedCommandDescriptor[];
  commandOmissions?: AdvancedCommandOmission[];
}

export interface WebParityControl {
  id: string;
  kind?: string;
  component?: string;
  capability?: string;
  attribute?: string;
  command?: string;
  commands?: string[];
  label?: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  optionCommands?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
  transport?: string;
}

export interface HomeAssistantEntityProjection {
  deviceId: string;
  entityId: string;
  uniqueId: string;
  domain: string;
  originalName: string;
  userNamed: boolean;
}

export interface WebParityReport {
  schemaVersion: 1;
  summary: {
    devices: number;
    safeCommands: number;
    locationControls: number;
    advancedControls: number;
    projectedEntities: number;
    omissions: number;
    dangerousCommandsExposed: number;
    duplicateUniqueIds: number;
    duplicateGeneratedNames: number;
  };
  omissions: WebParityOmission[];
  failures: WebParityFailure[];
}

export interface WebParityOmission {
  deviceId: string;
  component?: string;
  capability: string;
  command?: string;
  reason: AdvancedCommandOmission["reason"];
}

export interface WebParityFailure {
  code:
    | "dangerous_command_exposed"
    | "duplicate_unique_id"
    | "duplicate_generated_name"
    | "unexplained_omission";
  deviceId?: string;
  domain?: string;
  component?: string;
  capability?: string;
  command?: string;
  reason?: string;
  count?: number;
}

export function evaluateWebParity(
  rawInventory: unknown,
  rawProjection: unknown
): WebParityReport {
  validateBoundedJsonShape(rawInventory);
  validateBoundedJsonShape(rawProjection);
  assertNoSecretKeys(rawInventory);
  assertNoSecretKeys(rawProjection);

  const inventory = parseInventory(rawInventory);
  const projection = parseProjection(rawProjection);
  assertNoRawOrSecretFields(inventory);
  assertNoRawOrSecretFields(projection);
  const omissions = collectOmissions(inventory);
  const dangerousFailures = collectDangerousCommandFailures(inventory);
  const duplicateUniqueFailures = collectDuplicateUniqueIdFailures(projection);
  const duplicateNameFailures = collectDuplicateGeneratedNameFailures(projection);
  const unexplainedOmissionFailures = omissions
    .filter((omission) => !isExplainedOmission(omission))
    .map((omission): WebParityFailure => ({
      code: "unexplained_omission",
      deviceId: omission.deviceId,
      ...(omission.component !== undefined ? { component: omission.component } : {}),
      capability: omission.capability,
      ...(omission.command !== undefined ? { command: omission.command } : {}),
      reason: omission.reason
    }));
  const failures = [
    ...dangerousFailures,
    ...duplicateUniqueFailures,
    ...duplicateNameFailures,
    ...unexplainedOmissionFailures
  ].sort(compareFailure);

  return {
    schemaVersion: 1,
    summary: {
      devices: inventory.devices.length,
      safeCommands: inventory.devices.reduce(
        (total, device) =>
          total +
          (device.advancedCommands ?? []).filter((command) => !safeAdvancedCommandReason(command)).length,
        0
      ),
      locationControls: inventory.devices.reduce(
        (total, device) =>
          total + (device.controls ?? []).filter((control) => control.transport === "location_native").length,
        0
      ),
      advancedControls: inventory.devices.reduce(
        (total, device) =>
          total + (device.controls ?? []).filter((control) => control.transport === "advanced").length,
        0
      ),
      projectedEntities: projection.length,
      omissions: omissions.length,
      dangerousCommandsExposed: dangerousFailures.length,
      duplicateUniqueIds: duplicateUniqueFailures.length,
      duplicateGeneratedNames: duplicateNameFailures.length
    },
    omissions,
    failures
  };
}

export function reportHasFailingParity(report: WebParityReport): boolean {
  return report.failures.length > 0;
}

function parseInventory(value: unknown): WebParityInventory {
  if (!isRecord(value) || !Array.isArray(value.devices)) {
    invalid();
  }
  const allowed = new Set([
    "devices",
    "schemaVersion",
    "sequence",
    "ready",
    "bridgeVersion",
    "protocolVersion",
    "locations",
    "rooms",
    "scenes",
    "deviceAliases"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalid();
  }
  if (value.devices.length > MAX_DEVICES) invalid();
  const devices = value.devices.map(parseDevice).sort((left, right) => left.id.localeCompare(right.id));
  return { devices };
}

function parseDevice(value: unknown): WebParityDevice {
  if (!isRecord(value)) invalid();
  const allowed = new Set([
    "id",
    "locationId",
    "roomId",
    "name",
    "type",
    "online",
    "healthUpdatedAt",
    "presentation",
    "states",
    "advanced",
    "controls",
    "advancedCommands",
    "commandOmissions"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  const id = parseDeviceAlias(value.id);
  const controls = value.controls === undefined ? [] : parseControls(value.controls);
  const advancedCommands =
    value.advancedCommands === undefined ? [] : parseAdvancedCommands(value.advancedCommands);
  const commandOmissions =
    value.commandOmissions === undefined ? [] : parseOmissions(value.commandOmissions);
  return { id, controls, advancedCommands, commandOmissions };
}

function parseControls(value: unknown): WebParityControl[] {
  if (!Array.isArray(value) || value.length > MAX_CONTROLS_PER_DEVICE) invalid();
  return value.map((item) => {
    if (!isRecord(item)) invalid();
    const allowed = new Set([
      "id",
      "kind",
      "component",
      "capability",
      "attribute",
      "command",
      "commands",
      "label",
      "options",
      "optionLabels",
      "optionCommands",
      "min",
      "max",
      "step",
      "transport"
    ]);
    if (Object.keys(item).some((key) => !allowed.has(key))) invalid();
    const control: WebParityControl = { id: parseSafeString(item.id) };
    if (item.kind !== undefined) control.kind = parseSafeString(item.kind);
    if (item.component !== undefined) control.component = parseSafeString(item.component);
    if (item.capability !== undefined) control.capability = parseSafeString(item.capability);
    if (item.attribute !== undefined) control.attribute = parseSafeString(item.attribute);
    if (item.command !== undefined) control.command = parseSafeString(item.command);
    if (item.label !== undefined) control.label = parseSafeString(item.label);
    if (item.transport !== undefined) control.transport = parseSafeString(item.transport);
    if (item.commands !== undefined) {
      if (!Array.isArray(item.commands) || item.commands.length > 50) invalid();
      control.commands = item.commands.map(parseSafeString);
    }
    if (item.options !== undefined) {
      if (!Array.isArray(item.options) || item.options.length > 200) invalid();
      control.options = item.options.map(parseSafeString);
    }
    if (item.optionLabels !== undefined) control.optionLabels = parseStringMap(item.optionLabels);
    if (item.optionCommands !== undefined) control.optionCommands = parseStringMap(item.optionCommands);
    if (item.min !== undefined) control.min = parseFiniteNumber(item.min);
    if (item.max !== undefined) control.max = parseFiniteNumber(item.max);
    if (item.step !== undefined) control.step = parseFiniteNumber(item.step);
    return control;
  });
}

function parseAdvancedCommands(value: unknown): AdvancedCommandDescriptor[] {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS_PER_DEVICE) invalid();
  return value.map((item) => {
    if (!isRecord(item)) invalid();
    const allowed = new Set([
      "component",
      "componentRole",
      "capability",
      "capabilityVersion",
      "command",
      "arguments",
      "transport",
      "confirmation",
      "label",
      "labelSource"
    ]);
    if (Object.keys(item).some((key) => !allowed.has(key))) invalid();
    if (item.transport !== "advanced") invalid();
    if (item.confirmation !== "accepted_receipt" && item.confirmation !== "state") invalid();
    if (
      item.labelSource !== "visible_web" &&
      item.labelSource !== "capability" &&
      item.labelSource !== "role" &&
      item.labelSource !== "fallback"
    ) {
      invalid();
    }
    const capabilityVersion =
      typeof item.capabilityVersion === "number" &&
      Number.isInteger(item.capabilityVersion) &&
      item.capabilityVersion > 0 &&
      item.capabilityVersion <= 10_000
        ? item.capabilityVersion
        : undefined;
    if (capabilityVersion === undefined || !Array.isArray(item.arguments) || item.arguments.length > 20) {
      invalid();
    }
    return {
      component: parseSafeString(item.component),
      ...(item.componentRole !== undefined ? { componentRole: parseSafeString(item.componentRole) } : {}),
      capability: parseSafeString(item.capability),
      capabilityVersion,
      command: parseSafeString(item.command),
      arguments: item.arguments.map(parseArgument),
      transport: "advanced",
      confirmation: item.confirmation,
      label: parseSafeString(item.label),
      labelSource: item.labelSource
    };
  });
}

function parseArgument(value: unknown): AdvancedCommandDescriptor["arguments"][number] {
  if (!isRecord(value)) invalid();
  const allowed = new Set(["name", "optional", "required", "schema", "sensitive", "unit"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  if (value.optional !== undefined && value.required !== undefined) invalid();
  const argument: AdvancedCommandDescriptor["arguments"][number] = {
    name: parseSafeString(value.name),
    required:
      value.required !== undefined
        ? parseBoolean(value.required)
        : value.optional !== undefined
          ? !parseBoolean(value.optional)
          : true,
    sensitive: value.sensitive === undefined ? false : parseBoolean(value.sensitive),
    schema: value.schema === undefined ? {} : parseSchema(value.schema)
  };
  if (value.unit !== undefined) argument.unit = parseSafeString(value.unit);
  return argument;
}

function parseSchema(value: unknown): NonNullable<AdvancedCommandDescriptor["arguments"][number]["schema"]> {
  if (!isRecord(value)) invalid();
  const allowed = new Set(["type", "enum", "minimum", "maximum"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  const schema: NonNullable<AdvancedCommandDescriptor["arguments"][number]["schema"]> = {};
  if (value.type !== undefined) {
    const type = parseSafeString(value.type);
    if (
      type !== "array" &&
      type !== "boolean" &&
      type !== "integer" &&
      type !== "number" &&
      type !== "object" &&
      type !== "string"
    ) {
      invalid();
    }
    schema.type = type;
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length > 200) invalid();
    schema.enum = value.enum.map((item) => {
      if (
        item === null ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item)) ||
        typeof item === "string"
      ) {
        if (typeof item === "string") return parseSafeString(item);
        return item;
      }
      invalid();
    });
  }
  if (value.minimum !== undefined) schema.minimum = parseFiniteNumber(value.minimum);
  if (value.maximum !== undefined) schema.maximum = parseFiniteNumber(value.maximum);
  return schema;
}

function parseOmissions(value: unknown): AdvancedCommandOmission[] {
  if (!Array.isArray(value) || value.length > MAX_OMISSIONS_PER_DEVICE) invalid();
  return value.map((item) => {
    if (!isRecord(item)) invalid();
    const allowed = new Set(["component", "capability", "command", "reason"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) invalid();
    const reason = parseSafeString(item.reason);
    if (!SAFE_OMISSION_REASONS.has(reason as AdvancedCommandOmission["reason"])) invalid();
    return {
      component: item.component !== undefined ? parseSafeString(item.component) : "main",
      capability: parseSafeString(item.capability),
      ...(item.command !== undefined ? { command: parseSafeString(item.command) } : {}),
      reason: reason as AdvancedCommandOmission["reason"]
    };
  });
}

function parseProjection(value: unknown): HomeAssistantEntityProjection[] {
  if (!Array.isArray(value) || value.length > MAX_PROJECTIONS) invalid();
  return value.map((item) => {
    if (!isRecord(item)) invalid();
    const allowed = new Set(["deviceId", "entityId", "uniqueId", "domain", "originalName", "userNamed"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) invalid();
    return {
      deviceId: parseDeviceAlias(item.deviceId),
      entityId: parseSafeString(item.entityId),
      uniqueId: parseSafeString(item.uniqueId),
      domain: parseSafeString(item.domain),
      originalName: parseSafeString(item.originalName),
      userNamed: parseBoolean(item.userNamed)
    };
  });
}

function collectOmissions(inventory: WebParityInventory): WebParityOmission[] {
  const byKey = new Map<string, WebParityOmission>();
  for (const device of inventory.devices) {
    for (const omission of device.commandOmissions ?? []) {
      const reportOmission: WebParityOmission = {
        deviceId: device.id,
        ...(omission.component !== undefined ? { component: omission.component } : {}),
        capability: omission.capability,
        ...(omission.command !== undefined ? { command: omission.command } : {}),
        reason: omission.reason
      };
      byKey.set(JSON.stringify(reportOmission), reportOmission);
    }
  }
  return [...byKey.values()].sort(compareOmission);
}

function isExplainedOmission(omission: WebParityOmission): boolean {
  return (
    omission.reason === "definition_unavailable" ||
    NON_FAILING_OMISSION_REASONS.has(omission.reason) ||
    (omission.reason === "dangerous_command" &&
      safeAdvancedCommandReason({
        component: omission.component ?? "main",
        capability: omission.capability,
        capabilityVersion: 1,
        command: omission.command ?? omission.capability,
        arguments: [],
        transport: "advanced",
        confirmation: "accepted_receipt",
        label: omission.capability,
        labelSource: "capability"
      }) === "dangerous_command")
  );
}

function collectDangerousCommandFailures(inventory: WebParityInventory): WebParityFailure[] {
  const failures: WebParityFailure[] = [];
  for (const device of inventory.devices) {
    for (const command of device.advancedCommands ?? []) {
      const reason = safeAdvancedCommandReason(command);
      if (!reason) continue;
      failures.push({
        code: "dangerous_command_exposed",
        deviceId: device.id,
        component: command.component,
        capability: command.capability,
        command: command.command,
        reason
      });
    }
    for (const control of device.controls ?? []) {
      const commandDescriptors = controlToDescriptors(control);
      for (const commandDescriptor of commandDescriptors) {
        const reason = safeAdvancedCommandReason(commandDescriptor);
        if (!reason) continue;
        failures.push({
          code: "dangerous_command_exposed",
          deviceId: device.id,
          ...(control.component !== undefined ? { component: control.component } : {}),
          ...(control.capability !== undefined ? { capability: control.capability } : {}),
          reason
        });
      }
    }
  }
  return dedupeFailures(failures);
}

function controlToDescriptors(control: WebParityControl): AdvancedCommandDescriptor[] {
  if (!control.capability) return [];
  const commands = control.commands?.length ? control.commands : [control.command ?? control.attribute ?? control.id];
  return commands.map((command) => ({
    component: control.component ?? "main",
    capability: control.capability as string,
    capabilityVersion: 1,
    command,
    arguments: [],
    transport: "advanced",
    confirmation: "accepted_receipt",
    label: control.label ?? control.attribute ?? control.capability ?? command,
    labelSource: "capability"
  }));
}

function collectDuplicateUniqueIdFailures(projection: HomeAssistantEntityProjection[]): WebParityFailure[] {
  const groups = groupBy(projection, (entity) => entity.uniqueId);
  return [...groups.entries()]
    .filter(([, entities]) => entities.length > 1)
    .map(([, entities]) => ({
      code: "duplicate_unique_id" as const,
      count: entities.length
    }))
    .sort(compareFailure);
}

function collectDuplicateGeneratedNameFailures(projection: HomeAssistantEntityProjection[]): WebParityFailure[] {
  const groups = groupBy(
    projection.filter((entity) => !entity.userNamed),
    (entity) => `${entity.deviceId}\u0000${entity.domain}\u0000${entity.originalName}`
  );
  return [...groups.values()]
    .filter((entities) => entities.length > 1)
    .map((entities): WebParityFailure => {
      const first = entities[0];
      if (!first) invalid();
      return {
        code: "duplicate_generated_name",
        deviceId: first.deviceId,
        domain: first.domain,
        count: entities.length
      };
    })
    .sort(compareFailure);
}

function groupBy<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function parseStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 500) invalid();
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    parsed[parseSafeString(key)] = parseSafeString(item);
  }
  return parsed;
}

function validateBoundedJsonShape(value: unknown): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    if (typeof item === "string" && item.length > MAX_STRING_LENGTH) invalid();
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        parseSafeString(key);
        visit(child, depth + 1);
      }
      return;
    }
    if (
      item !== null &&
      typeof item !== "boolean" &&
      typeof item !== "string" &&
      !(typeof item === "number" && Number.isFinite(item))
    ) {
      invalid();
    }
  };
  visit(value, 0);
}

function assertNoRawOrSecretFields(value: unknown): void {
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (RAW_UUID.test(item)) invalid();
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (RAW_UUID.test(key) || SECRET_WORD.test(key)) invalid();
        visit(child);
      }
    }
  };
  visit(value);
}

function assertNoSecretKeys(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (SECRET_WORD.test(key)) invalid();
        visit(child);
      }
    }
  };
  visit(value);
}

function parseDeviceAlias(value: unknown): string {
  const parsed = parseSafeString(value);
  if (!DEVICE_ALIAS.test(parsed)) invalid();
  return parsed;
}

function parseSafeString(value: unknown): string {
  if (typeof value !== "string") invalid();
  if (value.length === 0 || value.length > MAX_STRING_LENGTH) invalid();
  if (/[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function parseFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareOmission(left: WebParityOmission, right: WebParityOmission): number {
  return omissionKey(left).localeCompare(omissionKey(right));
}

function omissionKey(omission: WebParityOmission): string {
  return [
    omission.deviceId,
    omission.component === undefined ? "1" : "0",
    omission.component ?? "",
    omission.capability,
    omission.command ?? "",
    omission.reason
  ].join("\u0000");
}

function dedupeFailures(failures: WebParityFailure[]): WebParityFailure[] {
  const byKey = new Map<string, WebParityFailure>();
  for (const failure of failures) byKey.set(JSON.stringify(failure), failure);
  return [...byKey.values()].sort(compareFailure);
}

function compareFailure(left: WebParityFailure, right: WebParityFailure): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function invalid(): never {
  throw new Error("web_parity_audit_input_invalid");
}

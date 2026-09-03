import { createHash } from "node:crypto";

export type ProtocolFingerprintErrorCode =
  | "cyclic_structure"
  | "maximum_depth_exceeded"
  | "maximum_nodes_exceeded"
  | "unsupported_object";

export interface ProtocolFingerprintOptions {
  maxDepth?: number;
  maxNodes?: number;
}

export class ProtocolFingerprintError extends Error {
  constructor(
    readonly code: ProtocolFingerprintErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProtocolFingerprintError";
  }
}

interface ShapeContext {
  readonly maxDepth: number;
  readonly maxNodes: number;
  nodes: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 100_000;

export function protocolFingerprint(value: unknown, options: ProtocolFingerprintOptions = {}): string {
  const context: ShapeContext = {
    maxDepth: validatePositiveSafeInteger(
      options.maxDepth ?? DEFAULT_MAX_DEPTH,
      "maximum_depth_exceeded",
      "Protocol fingerprint maxDepth must be a positive safe integer."
    ),
    maxNodes: validatePositiveSafeInteger(
      options.maxNodes ?? DEFAULT_MAX_NODES,
      "maximum_nodes_exceeded",
      "Protocol fingerprint maxNodes must be a positive safe integer."
    ),
    nodes: 0
  };

  return createHash("sha256").update(JSON.stringify(shapeOf(value, context, 0, new WeakSet()))).digest("hex");
}

function shapeOf(value: unknown, context: ShapeContext, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > context.maxDepth) {
    throw new ProtocolFingerprintError(
      "maximum_depth_exceeded",
      "Protocol fingerprint input exceeds maximum depth."
    );
  }
  context.nodes += 1;
  if (context.nodes > context.maxNodes) {
    throw new ProtocolFingerprintError(
      "maximum_nodes_exceeded",
      "Protocol fingerprint input exceeds maximum nodes."
    );
  }

  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (typeof value !== "object") {
    throw new ProtocolFingerprintError(
      "unsupported_object",
      "Protocol fingerprint input contains an unsupported value."
    );
  }
  if (ancestors.has(value)) {
    throw new ProtocolFingerprintError("cyclic_structure", "Protocol fingerprint input contains a cycle.");
  }
  ancestors.add(value);
  try {
    return shapeObject(value, context, depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function shapeObject(value: object, context: ShapeContext, depth: number, ancestors: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    const uniqueMemberShapes = new Map<string, unknown>();
    for (const descriptor of denseArrayElementDescriptors(value)) {
      const memberShape = shapeOf(descriptor.value, context, depth + 1, ancestors);
      uniqueMemberShapes.set(JSON.stringify(memberShape), memberShape);
    }
    return Array.from(uniqueMemberShapes.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, memberShape]) => memberShape);
  }

  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ProtocolFingerprintError(
      "unsupported_object",
      "Protocol fingerprint input contains an unsupported value."
    );
  }

  const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
    .filter(([, descriptor]) => descriptor.enumerable)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, descriptor]) => {
      if (!("value" in descriptor)) {
        throw new ProtocolFingerprintError(
          "unsupported_object",
          "Protocol fingerprint input contains an unsupported value."
        );
      }
      return [key, shapeOf(descriptor.value, context, depth + 1, ancestors)];
    });

  return Object.fromEntries(entries);
}

function denseArrayElementDescriptors(value: unknown[]): Array<PropertyDescriptor & { value: unknown }> {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throwUnsupportedObject();
  }

  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !isDataDescriptor(lengthDescriptor) ||
    lengthDescriptor.value !== value.length ||
    lengthDescriptor.writable !== true ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false
  ) {
    throwUnsupportedObject();
  }

  const elements: Array<PropertyDescriptor & { value: unknown }> = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") {
      continue;
    }

    const index = Number(key);
    if (!isCanonicalArrayIndex(key, index) || index >= value.length) {
      throwUnsupportedObject();
    }
    if (!isDataDescriptor(descriptor) || descriptor.writable !== true || descriptor.enumerable !== true) {
      throwUnsupportedObject();
    }
    elements[index] = descriptor;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (elements[index] === undefined) {
      throwUnsupportedObject();
    }
  }
  return elements;
}

function isCanonicalArrayIndex(key: string, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & { value: unknown } {
  return "value" in descriptor;
}

function validatePositiveSafeInteger(
  value: number,
  code: "maximum_depth_exceeded" | "maximum_nodes_exceeded",
  message: string
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProtocolFingerprintError(code, message);
  }
  return value;
}

function throwUnsupportedObject(): never {
  throw new ProtocolFingerprintError(
    "unsupported_object",
    "Protocol fingerprint input contains an unsupported value."
  );
}

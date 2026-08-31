import type { AuthenticatedAdvancedSession } from "./authenticated-session.js";
import { AdvancedSessionError } from "./authenticated-session.js";
import {
  CapabilityValidationError,
  validateCommandArguments,
  type CapabilityDefinitionCache
} from "./capability-cache.js";
import { advancedEndpoints } from "./endpoints.js";
import type { AdvancedCommandBody } from "./types.js";
import {
  CommandTransportError,
  type CommandTransport,
  type CommandTransportErrorCode,
  type CommandTransportReceipt,
  type RoutedCommandRequest
} from "../command/command-router.js";

export type AdvancedCommandErrorCode =
  | "unsupported"
  | "invalid_arguments"
  | "authentication_failed"
  | "permission_denied"
  | "device_offline"
  | "request_failed"
  | "timeout"
  | "http_error"
  | "response_invalid";

export class AdvancedCommandError extends CommandTransportError {
  constructor(readonly advancedCode: AdvancedCommandErrorCode) {
    super(transportCode(advancedCode), "advanced");
    this.message = advancedCode;
    this.name = "AdvancedCommandError";
  }
}

export interface AdvancedCommandAdapterOptions {
  session: AuthenticatedAdvancedSession;
  resolveRawDeviceId: (alias: string) => string | undefined;
  resolveRawIdentifier: (alias: string) => string | undefined;
  capabilityCache?: CapabilityDefinitionCache;
  maxAttempts?: number;
  now?: () => number;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,256}$/u;

export class AdvancedCommandAdapter implements CommandTransport {
  readonly name = "advanced" as const;
  readonly #maxAttempts: number;
  readonly #now: () => number;

  constructor(private readonly options: AdvancedCommandAdapterOptions) {
    this.#maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 3) {
      throw new Error("advanced_command_attempts_invalid");
    }
    this.#now = options.now ?? Date.now;
  }

  async execute(request: RoutedCommandRequest): Promise<CommandTransportReceipt> {
    const deviceId = this.options.resolveRawDeviceId(request.deviceId);
    const component = resolveIdentifier(request.component, this.options.resolveRawIdentifier);
    const capability = resolveIdentifier(request.capability, this.options.resolveRawIdentifier);
    if (!deviceId || !component || !capability) throw new AdvancedCommandError("unsupported");
    if (!TOKEN.test(request.command)) throw new AdvancedCommandError("invalid_arguments");
    let arguments_: unknown[];
    try {
      arguments_ = await this.validateArguments(capability, request);
      assertJsonArguments(arguments_);
    } catch (error) {
      if (error instanceof AdvancedCommandError) throw error;
      if (error instanceof CapabilityValidationError) {
        if (error.code === "unsupported_command") throw new AdvancedCommandError("unsupported");
        throw new AdvancedCommandError("invalid_arguments");
      }
      throw error;
    }

    const body: AdvancedCommandBody = {
      commands: [
        {
          component,
          capability,
          command: request.command,
          arguments: arguments_
        }
      ]
    };
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.options.session.request(
          {
            endpoint: "commands",
            method: "POST",
            path: advancedEndpoints.deviceCommands(deviceId),
            body
          },
          (value) => parseReceipt(value, this.#now())
        );
      } catch (error) {
        const classified = classifyError(error);
        if (
          attempt < this.#maxAttempts &&
          (classified.advancedCode === "request_failed" || classified.advancedCode === "timeout")
        ) {
          continue;
        }
        throw classified;
      }
    }
    throw new AdvancedCommandError("request_failed");
  }

  private async validateArguments(
    rawCapabilityId: string,
    request: RoutedCommandRequest
  ): Promise<unknown[]> {
    if (!this.options.capabilityCache || request.capabilityVersion === undefined) {
      return [...request.arguments];
    }
    const definition = await this.options.capabilityCache.get(
      rawCapabilityId,
      request.capabilityVersion
    );
    return validateCommandArguments(definition, request.command, request.arguments);
  }
}

function parseReceipt(value: unknown, acceptedAtMs: number): CommandTransportReceipt {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length === 0) {
    throw new AdvancedCommandError("response_invalid");
  }
  const first = value.results[0];
  if (!isRecord(first) || typeof first.status !== "string") {
    throw new AdvancedCommandError("response_invalid");
  }
  if (first.status === "UNSUPPORTED" || first.status === "NOT_SUPPORTED") {
    throw new AdvancedCommandError("unsupported");
  }
  if (first.status !== "ACCEPTED") throw new AdvancedCommandError("response_invalid");
  const commandId = typeof first.id === "string" && first.id.length <= 256 ? first.id : undefined;
  return {
    state: "ACCEPTED",
    transport: "advanced",
    acceptedAtMs,
    ...(commandId === undefined ? {} : { commandId })
  };
}

function classifyError(error: unknown): AdvancedCommandError {
  if (error instanceof AdvancedCommandError) return error;
  if (error instanceof CapabilityValidationError) {
    return new AdvancedCommandError(
      error.code === "unsupported_command" ? "unsupported" : "invalid_arguments"
    );
  }
  if (error instanceof AdvancedSessionError) {
    if (error.code === "advanced_authentication_failed") {
      return new AdvancedCommandError("authentication_failed");
    }
    if (error.code === "advanced_permission_denied") {
      return new AdvancedCommandError("permission_denied");
    }
    if (error.code === "advanced_timeout") return new AdvancedCommandError("timeout");
    if (error.code === "advanced_http_error") {
      if (error.status === 409 || error.status === 423) {
        return new AdvancedCommandError("device_offline");
      }
      return new AdvancedCommandError("http_error");
    }
    if (error.code === "advanced_response_invalid") {
      return new AdvancedCommandError("response_invalid");
    }
    return new AdvancedCommandError("request_failed");
  }
  return new AdvancedCommandError("request_failed");
}

function resolveIdentifier(
  value: string,
  resolveRaw: (alias: string) => string | undefined
): string | undefined {
  if (value.startsWith("identifier_")) return resolveRaw(value);
  return TOKEN.test(value) ? value : undefined;
}

function assertJsonArguments(values: unknown[]): void {
  try {
    const serialized = JSON.stringify(values);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 16_384) {
      throw new AdvancedCommandError("invalid_arguments");
    }
  } catch (error) {
    if (error instanceof AdvancedCommandError) throw error;
    throw new AdvancedCommandError("invalid_arguments");
  }
}

function transportCode(code: AdvancedCommandErrorCode): CommandTransportErrorCode {
  if (code === "unsupported") return "unsupported";
  if (code === "authentication_failed") return "authentication";
  if (code === "permission_denied") return "permission";
  if (code === "invalid_arguments") return "invalid_arguments";
  if (code === "device_offline") return "offline";
  if (code === "response_invalid") return "response_invalid";
  if (code === "http_error") return "http_error";
  return "transient";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

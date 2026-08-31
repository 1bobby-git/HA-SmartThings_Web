export interface RoutedCommandRequest {
  deviceId: string;
  component: string;
  capability: string;
  capabilityVersion?: number;
  command: string;
  arguments: unknown[];
}

export type CommandTransportName = "advanced" | "location_native" | "internal" | "dom";

export interface CommandTransportReceipt {
  state: "ACCEPTED";
  transport: CommandTransportName;
  sentAtMs?: number;
  acceptedAtMs: number;
  commandId?: string;
}

export type CommandTransportErrorCode =
  | "unsupported"
  | "authentication"
  | "permission"
  | "transient"
  | "invalid_arguments"
  | "offline"
  | "response_invalid"
  | "http_error";

export class CommandTransportError extends Error {
  constructor(
    readonly code: CommandTransportErrorCode,
    readonly transport: CommandTransportName
  ) {
    super(code);
    this.name = "CommandTransportError";
  }
}

export interface CommandTransport {
  name: CommandTransportName;
  execute(request: RoutedCommandRequest): Promise<CommandTransportReceipt>;
}

export interface OrderedCommandRouterOptions {
  advanced: CommandTransport;
  locationNative?: CommandTransport;
  otherInternal?: CommandTransport;
  dom?: CommandTransport;
  domFallbackEnabled?: boolean;
}

export class OrderedCommandRouter {
  readonly #transports: CommandTransport[];

  constructor(options: OrderedCommandRouterOptions) {
    assertName(options.advanced, "advanced");
    if (options.locationNative) assertName(options.locationNative, "location_native");
    if (options.otherInternal) assertName(options.otherInternal, "internal");
    if (options.dom) assertName(options.dom, "dom");
    this.#transports = [
      options.advanced,
      ...(options.locationNative ? [options.locationNative] : []),
      ...(options.otherInternal ? [options.otherInternal] : []),
      ...(options.dom && options.domFallbackEnabled === true ? [options.dom] : [])
    ];
  }

  async execute(request: RoutedCommandRequest): Promise<CommandTransportReceipt> {
    for (const transport of this.#transports) {
      try {
        return await transport.execute(request);
      } catch (error) {
        if (error instanceof CommandTransportError && error.code === "unsupported") continue;
        throw error;
      }
    }
    throw new CommandTransportError("unsupported", "advanced");
  }
}

function assertName(transport: CommandTransport, expected: CommandTransportName): void {
  if (transport.name !== expected) throw new Error("command_transport_order_invalid");
}

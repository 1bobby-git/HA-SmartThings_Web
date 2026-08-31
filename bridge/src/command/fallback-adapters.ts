import {
  CommandTransportError,
  type CommandTransport,
  type CommandTransportReceipt,
  type RoutedCommandRequest
} from "./command-router.js";

type ExecuteFallback = (request: RoutedCommandRequest) => Promise<void>;

export class LocationNativeCommandAdapter implements CommandTransport {
  readonly name = "location_native" as const;

  constructor(
    private readonly executeNative: ExecuteFallback,
    private readonly now: () => number = Date.now
  ) {}

  async execute(request: RoutedCommandRequest): Promise<CommandTransportReceipt> {
    const sentAtMs = this.now();
    try {
      await this.executeNative(request);
      return {
        state: "ACCEPTED",
        transport: "location_native",
        sentAtMs,
        acceptedAtMs: this.now()
      };
    } catch (error) {
      if (error instanceof Error && error.message === "command_native_unavailable") {
        throw new CommandTransportError("unsupported", "location_native");
      }
      throw error;
    }
  }
}

export class DomFallbackAdapter implements CommandTransport {
  readonly name = "dom" as const;

  constructor(
    private readonly executeDom: ExecuteFallback,
    private readonly now: () => number = Date.now
  ) {}

  async execute(request: RoutedCommandRequest): Promise<CommandTransportReceipt> {
    const sentAtMs = this.now();
    await this.executeDom(request);
    return {
      state: "ACCEPTED",
      transport: "dom",
      sentAtMs,
      acceptedAtMs: this.now()
    };
  }
}

import type { BrowserPageLike } from "../browser/keeper-page.js";

export interface AppClientCommandRequest {
  path: string;
  body?: unknown;
  timeoutMs: number;
}

export interface AppClientCommandResult {
  ok: boolean;
  status: number;
  value?: unknown;
  error?: string;
  timing?: {
    browserMs: number;
    fetchMs: number;
    bodyMs: number;
    appClient?: true;
  };
}

/**
 * Execute a validated light command through the SmartThings application's own
 * already-authenticated api/device service. `undefined` means no patch was
 * attempted, so the caller may safely use the existing Advanced POST path.
 * Once patch() is entered every failure is terminal/ambiguous and MUST NOT be
 * replayed through another transport.
 */
export async function executeAppClientCommand(
  page: BrowserPageLike,
  request: AppClientCommandRequest
): Promise<AppClientCommandResult | undefined> {
  if (!page.evaluate || page.isClosed()) return undefined;
  try {
    const outcome = await page.evaluate(
      async (input) => {
        type PageRecord = Record<string | symbol, unknown>;
        type NativeService = { patch?: (id: string, body: unknown) => unknown };
        type NativeClient = { service?: (name: string) => unknown };
        type PageResult =
          | { kind: "unavailable" }
          | { kind: "result"; result: AppClientCommandResult };

        const startedAt = performance.now();
        let requestMs = 0;
        const finish = (
          result: Omit<AppClientCommandResult, "timing">
        ): PageResult => ({
          kind: "result",
          result: {
            ...result,
            timing: {
              browserMs: performance.now() - startedAt,
              fetchMs: requestMs,
              bodyMs: 0,
              appClient: true
            }
          }
        });

        const deviceId = commandDeviceId(input.path);
        const commands = normalizedCommands(input.body);
        if (!deviceId || !commands) return { kind: "unavailable" } as PageResult;

        const pageWindow = (
          ((globalThis as unknown as { window?: PageRecord }).window ?? globalThis) as unknown as PageRecord
        );
        const serviceSymbol = Symbol.for("smartthings_web_bridge.api_device_service");
        const clientSymbol = Symbol.for("smartthings_web_bridge.cake_client");
        let service = asService(pageWindow[serviceSymbol]);
        if (!service) {
          const client = asClient(pageWindow[clientSymbol]);
          if (!client?.service) return { kind: "unavailable" } as PageResult;
          try {
            service = asService(client.service("api/device"));
          } catch {
            return { kind: "unavailable" } as PageResult;
          }
        }
        if (!service?.patch) return { kind: "unavailable" } as PageResult;
        try {
          Object.defineProperty(pageWindow, serviceSymbol, {
            configurable: true,
            value: service
          });
        } catch {
          // A cache miss only affects lookup speed and never command semantics.
        }

        const patchStartedAt = performance.now();
        try {
          const response = await withTimeout(
            Promise.resolve(
              service.patch(deviceId, {
                query: { execute: true, commands }
              })
            ),
            input.timeoutMs
          );
          requestMs = performance.now() - patchStartedAt;
          const failure = explicitFailureStatus(response);
          if (failure !== undefined) {
            return finish({
              ok: false,
              status: failure,
              error: failure === 401 ? "login_required" : `http_${failure}`
            });
          }
          // The application service does not guarantee the Advanced admin
          // endpoint's receipt shape. patch() resolving without an explicit
          // rejection is only an accepted receipt; the existing command
          // confirmation still requires newer real device state.
          return finish({
            ok: true,
            status: 202,
            value: {
              results: commands.map(() => ({ status: "ACCEPTED" }))
            }
          });
        } catch (error) {
          requestMs = performance.now() - patchStartedAt;
          const status = errorStatus(error);
          return finish({
            ok: false,
            status: status ?? 0,
            error:
              status === 401
                ? "login_required"
                : status === 403
                  ? "http_403"
                  : error instanceof Error && error.message === "app_client_timeout"
                    ? "timeout"
                    : "app_client_request_failed"
          });
        }

        function commandDeviceId(path: string): string | undefined {
          const match = /^\/advanced\/cupcake-api\/api\/devices\/([^/?#]+)\/commands$/u.exec(path);
          if (!match?.[1]) return undefined;
          try {
            const value = decodeURIComponent(match[1]);
            return validToken(value, 512) ? value : undefined;
          } catch {
            return undefined;
          }
        }

        function normalizedCommands(body: unknown): Array<Record<string, unknown>> | undefined {
          const root = record(body);
          if (!root || !Array.isArray(root.commands) || root.commands.length < 1 || root.commands.length > 4) {
            return undefined;
          }
          const allowed = new Set([
            "on",
            "off",
            "setLevel",
            "setColor",
            "setHue",
            "setSaturation",
            "setColorTemperature"
          ]);
          const result: Array<Record<string, unknown>> = [];
          for (const item of root.commands) {
            const command = record(item);
            if (
              !command ||
              !validToken(command.component, 256) ||
              !validToken(command.capability, 256) ||
              !validToken(command.command, 128) ||
              !allowed.has(command.command as string) ||
              !Array.isArray(command.arguments) ||
              command.arguments.length > 16
            ) {
              return undefined;
            }
            result.push({
              component: command.component,
              capability: command.capability,
              command: command.command,
              ...(command.arguments.length === 0
                ? {}
                : { arguments: command.arguments })
            });
          }
          return result;
        }

        function validToken(value: unknown, max: number): value is string {
          return (
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= max &&
            !/[\u0000-\u001f\u007f]/u.test(value)
          );
        }

        function asClient(value: unknown): NativeClient | undefined {
          const candidate = record(value);
          return candidate && typeof candidate.service === "function"
            ? (candidate as unknown as NativeClient)
            : undefined;
        }

        function asService(value: unknown): NativeService | undefined {
          const candidate = record(value);
          return candidate && typeof candidate.patch === "function"
            ? (candidate as unknown as NativeService)
            : undefined;
        }

        function explicitFailureStatus(value: unknown): number | undefined {
          const outer = record(value);
          if (!outer) return undefined;
          const numeric = numericStatus(outer);
          if (numeric !== undefined && numeric >= 400) return numeric;
          if (outer.ok === false) return numeric ?? 502;
          if (
            typeof outer.status === "string" &&
            /(?:fail|error|reject|denied)/iu.test(outer.status)
          ) {
            return numeric ?? 502;
          }
          const data = record(outer.data);
          const results = Array.isArray(data?.results)
            ? data.results
            : Array.isArray(outer.results)
              ? outer.results
              : [];
          for (const item of results) {
            const row = record(item);
            const status = row?.status;
            if (
              typeof status === "string" &&
              !/^(?:success|accepted|complete|completed)$/iu.test(status)
            ) {
              return 502;
            }
          }
          return undefined;
        }

        function errorStatus(value: unknown): number | undefined {
          const direct = record(value);
          const response = record(direct?.response);
          return numericStatus(direct) ?? numericStatus(response);
        }

        function numericStatus(value: Record<string, unknown> | undefined): number | undefined {
          if (!value) return undefined;
          for (const candidate of [value.statusCode, value.status, value.code]) {
            if (
              typeof candidate === "number" &&
              Number.isInteger(candidate) &&
              candidate >= 400 &&
              candidate <= 599
            ) {
              return candidate;
            }
          }
          return undefined;
        }

        function record(value: unknown): Record<string, unknown> | undefined {
          return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value as Record<string, unknown>
            : undefined;
        }

        async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              promise,
              new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("app_client_timeout")), timeoutMs);
              })
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
      },
      request
    );
    if (
      typeof outcome === "object" && outcome !== null &&
      typeof (outcome as { ok?: unknown }).ok === "boolean" &&
      typeof (outcome as { status?: unknown }).status === "number"
    ) {
      return outcome as unknown as AppClientCommandResult;
    }
    return outcome.kind === "unavailable" ? undefined : outcome.result;
  } catch {
    // Playwright can reject after browser execution has already started (for
    // example during navigation/context loss), so this is deliberately NOT a
    // safe-to-replay result.
    return { ok: false, status: 0, error: "app_client_evaluate_failed" };
  }
}

import type { BrowserPageLike, KeeperPageManager } from "./keeper-page.js";
import { SafeCommandError, type SafeCommandExecutor } from "../command/command-service.js";

type LocationInput = Parameters<NonNullable<SafeCommandExecutor["executeLocationAction"]>>[0];
type Manager = Pick<KeeperPageManager, "currentKeeper" | "openCommandPage">;
type Mode = "ARMED_AWAY" | "ARMED_STAY" | "DISARMED";
type Outcome = "accepted" | "unavailable" | "busy" | "login" | "denied" | "rejected" | "uncertain";
interface RequestInput { locationId: string; armState: Mode; readyMs: number; deadline: number }
export interface LocationSecurityCommandOptions {
  getManager: () => Manager | undefined;
  resolveRawLocationId: (alias: string) => string | undefined;
  requestTimeoutMs?: number;
  onDiagnostic?: (stage: string) => void;
}

/** Uses the authenticated client already created by SmartThings, not a new token
 * or an invented Advanced endpoint. See docs/home-monitor-direct-transport.md.
 * A fulfilled patch is an acknowledgement only; SafeCommandService confirms state.
 */
export class LocationSecurityCommandExecutor {
  readonly #requestTimeoutMs: number;
  constructor(private readonly options: LocationSecurityCommandOptions) {
    const timeout = options.requestTimeoutMs ?? 8_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
      throw new Error("invalid_security_request_timeout");
    }
    this.#requestTimeoutMs = timeout;
  }

  async executeLocationAction(input: LocationInput): Promise<"location_native"> {
    const modes = { armAway: "ARMED_AWAY", armStay: "ARMED_STAY", disarm: "DISARMED" } as const;
    const armState = modes[input.action];
    if (!armState) throw new SafeCommandError("unsupported_command");
    const locationId = this.options.resolveRawLocationId(input.locationId);
    if (!locationId || !/^[A-Za-z0-9_-]{1,128}$/u.test(locationId)) {
      throw new SafeCommandError("command_location_unknown");
    }
    const manager = this.options.getManager();
    if (!manager) throw new SafeCommandError("command_browser_unavailable");
    const startedAt = Date.now();
    let owned: BrowserPageLike | undefined;
    this.#diagnostic(`start_${input.action}`);
    try {
      const keeper = manager.currentKeeper();
      let outcome: Outcome = keeper ? await this.#request(keeper, locationId, armState, 300) : "unavailable";
      if (outcome === "unavailable") {
        // Only a proven pre-dispatch absence may create another page. Never replay
        // a rejected, timed-out, busy or otherwise uncertain mutation.
        this.#diagnostic("client_bootstrap");
        owned = await manager.openCommandPage(locationId);
        outcome = await this.#request(owned, locationId, armState, 2_000);
      } else {
        this.#diagnostic("keeper_reused");
      }
      this.#diagnostic(`dispatch_${outcome}_ms_${Date.now() - startedAt}`);
      if (outcome === "unavailable") throw new SafeCommandError("command_security_unavailable");
      if (outcome === "busy") throw new SafeCommandError("command_security_busy");
      if (outcome === "login") throw new SafeCommandError("command_login_required");
      if (outcome === "denied") throw new SafeCommandError("command_security_permission_denied");
      if (outcome === "rejected") throw new SafeCommandError("command_execution_failed");
      if (outcome === "uncertain") {
        // An event can establish success even if the request acknowledgement was
        // lost. Never issue a second mutation to find out what happened.
        if (!input.waitForConfirmation) throw new SafeCommandError("command_security_dispatch_uncertain");
        try { await input.waitForConfirmation(); }
        catch { throw new SafeCommandError("command_security_dispatch_uncertain"); }
      } else {
        await input.waitForConfirmation?.();
      }
      return "location_native";
    } finally {
      // The borrowed keeper is never navigated, brought forward or closed.
      await owned?.close().catch(() => undefined);
    }
  }

  async #request(page: BrowserPageLike, locationId: string, armState: Mode, readyMs: number): Promise<Outcome> {
    if (!page.evaluate || page.isClosed()) return "unavailable";
    try {
      const url = new URL(page.url());
      if (url.origin !== "https://my.smartthings.com" || !/^\/location(?:\/[^/]+)?\/?$/u.test(url.pathname)) return "unavailable";
    } catch { return "unavailable"; }
    const deadline = Date.now() + readyMs + this.#requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        page.evaluate(sendLocationSecurityRequest, { locationId, armState, readyMs, deadline }),
        new Promise<Outcome>((resolve) => { timer = setTimeout(() => resolve("uncertain"), readyMs + this.#requestTimeoutMs + 150); })
      ]);
      return ["accepted", "unavailable", "busy", "login", "denied", "rejected", "uncertain"].includes(result) ? result : "uncertain";
    } catch {
      // Context loss does not establish whether the server received the patch.
      return "uncertain";
    } finally { if (timer) clearTimeout(timer); }
  }

  #diagnostic(stage: string): void {
    try { this.options.onDiagnostic?.(stage); } catch { /* Logging is non-fatal. */ }
  }
}

/** Executed inside the dedicated authenticated browser. No cookies, tokens,
 * response bodies, user IDs or raw errors leave the page. Exported for fixtures.
 */
export async function sendLocationSecurityRequest(input: RequestInput): Promise<Outcome> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.locationId) ||
      !["ARMED_AWAY", "ARMED_STAY", "DISARMED"].includes(input.armState) ||
      !Number.isFinite(input.deadline) || input.deadline <= Date.now()) return "unavailable";
  const url = location.href;
  const validRoute = () => location.href === url && location.origin === "https://my.smartthings.com" &&
    /^\/location(?:\/[^/]+)?\/?$/u.test(location.pathname);
  if (!validRoute()) return "unavailable";
  type Service = { patch?: (id: string, body: { patchType: "armStateChange"; armState: Mode }) => Promise<unknown> };
  type Client = { service?: (name: string) => Service };
  const root = window as unknown as Record<symbol, unknown>;
  const readyUntil = Math.min(input.deadline, Date.now() + Math.max(0, input.readyMs));
  let service: Service | undefined;
  do {
    if (!validRoute() || Date.now() >= input.deadline) return "unavailable";
    try {
      const client = root[Symbol.for("smartthings_web_bridge.cake_client")] as Client | undefined;
      service = typeof client?.service === "function" ? client.service("api/location") : undefined;
    } catch { return "unavailable"; }
    if (typeof service?.patch === "function") break;
    if (Date.now() >= readyUntil) return "unavailable";
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, readyUntil - Date.now())));
  } while (Date.now() < input.deadline);
  if (typeof service?.patch !== "function" || !validRoute() || Date.now() >= input.deadline) return "unavailable";

  // Keep unresolved writes visible to subsequent requests in the same context.
  // There is no timer-based retry or forced expiry of a possibly delivered write.
  const pendingKey = Symbol.for("smartthings_web_bridge.security_pending");
  if (root[pendingKey] !== undefined && !(root[pendingKey] instanceof Map)) return "unavailable";
  const pending = (root[pendingKey] ?? new Map<string, object>()) as Map<string, object>;
  root[pendingKey] = pending;
  if (pending.has(input.locationId)) return "busy";
  const marker = {};
  pending.set(input.locationId, marker);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<Outcome>;
  try {
    // Verified in the public SmartThings 2.57.0 changeArmState implementation.
    const request = service.patch(input.locationId, { patchType: "armStateChange", armState: input.armState });
    work = Promise.resolve(request).then<Outcome, Outcome>(
      () => "accepted",
      (error: unknown) => {
        const row = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
        const code = row.code ?? row.status ?? row.statusCode;
        if (code === 401) return "login";
        if (code === 403) return "denied";
        if (typeof code === "number" && code >= 400 && code < 500) return "rejected";
        return "uncertain";
      }
    ).finally(() => { if (pending.get(input.locationId) === marker) pending.delete(input.locationId); });
  } catch {
    // A synchronous throw can still follow a socket dispatch. Do not replay.
    pending.delete(input.locationId);
    return "uncertain";
  }
  try {
    return await Promise.race([
      work,
      new Promise<Outcome>((resolve) => { timer = setTimeout(() => resolve("uncertain"), Math.max(1, input.deadline - Date.now())); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

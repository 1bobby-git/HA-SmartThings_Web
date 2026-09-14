import type { BrowserPageLike } from "./keeper-page.js";
import { nativeLoginTarget } from "./native-login-policy.js";
import { verifyLocationApplicationSession, type ApplicationSessionProof } from "./session-application-proof.js";

export type NativeSessionState = "unknown" | "checking" | "active" | "renewing" | "attention";
export type NativeSessionReason = "unsupported" | "setting_pending" | "session_verified" | "renewed" |
  "applied" | "unconfirmed" | "expired" | "busy" | "deferred" | "read_failed" | "reauth" | "stale";
export interface NativeSessionObservation {
  state: NativeSessionState;
  reason: NativeSessionReason;
  uiKeepSignedIn?: boolean;
  sessionKeepSignedIn?: boolean;
  storageAllowed?: boolean;
  socketConnected?: boolean;
  socketAuthenticated?: boolean;
  remainingMs?: number;
}
interface NativeSnapshot {
  instance: string;
  revision: number;
  uiKeepSignedIn: boolean;
  sessionKeepSignedIn: boolean;
  socketConnected: boolean;
  socketAuthenticated: boolean;
  storageAllowed?: boolean;
  expiresInMs: number;
  busy: boolean;
  busyAgeMs: number;
  outcome: "idle" | "requested" | "renewed" | "applied" | "unconfirmed" | "stale";
}
export interface NativeMaintenanceResult {
  /** Suppress unnecessary candidate-tab replacement, NOT authentication proof. */
  handled: boolean;
  observation: NativeSessionObservation;
  authenticationRejected?: boolean;
}

/** Only this allowlisted projection crosses out of the browser. A native
 * fulfilled Promise never counts as success: require a new effective session
 * plus a protected read. No tokens, user IDs, DOM, storage contents or raw errors.
 */
export class NativeSessionMaintenance {
  #page: BrowserPageLike | undefined;
  #nextAt = 0;
  #url = "";
  #generation = 0;
  lastReadAtMs: number | undefined;
  #proofKey: string | undefined;
  #proofAt = 0;
  #last: NativeMaintenanceResult | undefined;
  #flight: Promise<NativeMaintenanceResult> | undefined;
  constructor(private readonly proof = verifyLocationApplicationSession,
    private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.#generation++; this.#url = ""; this.lastReadAtMs = undefined;
    this.#page = undefined; this.#nextAt = 0; this.#proofKey = undefined;
    this.#proofAt = 0; this.#last = undefined; this.#flight = undefined;
  }

  run(page: BrowserPageLike, options: { enabled: boolean; canRun: () => boolean;
    current: () => boolean; force?: boolean }): Promise<NativeMaintenanceResult> {
    if (page !== this.#page || page.url() !== this.#url) this.reset();
    this.#page = page; this.#url = page.url();
    if (this.#flight) return this.#flight;
    if (!options.force && this.now() < this.#nextAt && this.#last) return Promise.resolve(this.#last);
    this.#nextAt = this.now() + 10_000;
    const flight = this.#run(page, options);
    this.#flight = flight;
    void flight.then(result => {
      if (this.#flight === flight) { this.#last = result; this.#flight = undefined; }
    }, () => { if (this.#flight === flight) this.#flight = undefined; });
    return flight;
  }

  async #run(page: BrowserPageLike, options: { enabled: boolean; canRun: () => boolean; current: () => boolean }): Promise<NativeMaintenanceResult> {
    const unknown = (reason: NativeSessionReason = "unsupported"): NativeMaintenanceResult =>
      ({ handled: false, observation: { state: "unknown", reason } });
    const url = page.url();
    const generation = this.#generation;
    const current = () => this.#generation === generation && this.#page === page && options.current() && !page.isClosed() && page.url() === url;
    if (!page.evaluate || !nativeLoginTarget(url) || !current()) return unknown();
    const raw = await evaluateBounded(page, { action: "read", target: url });
    if (!current()) return unknown("stale");
    this.lastReadAtMs = Date.now();
    const snapshot = sanitizeSnapshot(raw);
    if (!snapshot) return unknown();
    const observation: NativeSessionObservation = {
      state: "checking", reason: "setting_pending", uiKeepSignedIn: snapshot.uiKeepSignedIn,
      sessionKeepSignedIn: snapshot.sessionKeepSignedIn, socketConnected: snapshot.socketConnected,
      socketAuthenticated: snapshot.socketAuthenticated, remainingMs: Math.max(0, snapshot.expiresInMs),
      ...(snapshot.storageAllowed === undefined ? {} : { storageAllowed: snapshot.storageAllowed })
    };
    if (!options.enabled) return { handled: false, observation };
    if (snapshot.busy && snapshot.busyAgeMs < 60_000) {
      return { handled: true, observation: { ...observation, state: "renewing", reason: "busy" } };
    }
    if (snapshot.expiresInMs <= 0 || !snapshot.socketConnected || !snapshot.socketAuthenticated ||
        snapshot.outcome === "stale" || snapshot.outcome === "unconfirmed" || snapshot.busy) {
      this.#proofKey = undefined;
      return { handled: false, observation: { ...observation, state: "attention",
        reason: snapshot.expiresInMs <= 0 ? "expired" : snapshot.outcome === "unconfirmed" ? "unconfirmed" : "read_failed" } };
    }
    if (!options.canRun()) return { handled: true, observation: { ...observation, reason: "deferred" } };
    const key = `${snapshot.instance}:${snapshot.revision}`;
    if (key !== this.#proofKey || this.now() - this.#proofAt > 60_000) {
      const proof: ApplicationSessionProof = await this.proof(page, url, 5_000);
      if (!current()) return unknown("stale");
      if (proof.outcome !== "ok") {
        this.#proofKey = undefined;
        return { handled: false, authenticationRejected: proof.outcome === "reauth",
          observation: { ...observation, state: "attention", reason: proof.outcome === "reauth" ? "reauth" : "read_failed" } };
      }
      // A response from before a same-URL document replacement is not valid.
      const checked = sanitizeSnapshot(await evaluateBounded(page, { action: "read", target: url }));
      if (!current() || !checked || checked.instance !== snapshot.instance || checked.revision !== snapshot.revision ||
          !checked.socketAuthenticated || !checked.socketConnected || checked.busy) return unknown("stale");
      this.#proofKey = key; this.#proofAt = this.now();
    }
    if (!snapshot.uiKeepSignedIn || !snapshot.sessionKeepSignedIn || snapshot.expiresInMs <= 5 * 60_000) {
      if (!current() || !options.canRun()) return { handled: true, observation: { ...observation, reason: "deferred" } };
      const result = await evaluateBounded(page, { action: "begin", target: url, instance: snapshot.instance, revision: snapshot.revision });
      if (!current()) return unknown("stale");
      this.#nextAt = 0;
      if (result === "requested" || result === "busy") return { handled: true,
        observation: { ...observation, state: "renewing", reason: "busy" } };
      if (result === "blocked") return { handled: true, observation: { ...observation, reason: "deferred" } };
      return { handled: false, observation: { ...observation, state: "attention", reason: "unconfirmed" } };
    }
    return { handled: true, observation: { ...observation, state: "active",
      reason: snapshot.outcome === "renewed" ? "renewed" : snapshot.outcome === "applied" ? "applied" : "session_verified" } };
  }
}

async function evaluateBounded(page: BrowserPageLike, argument: { action: "read" | "begin"; target: string; instance?: string; revision?: number }): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([page.evaluate!(nativeSessionOperation, { ...argument, deadline: Date.now() + 1_400 }), new Promise(resolve => {
      timer = setTimeout(() => resolve(undefined), 1_500);
    })]);
  } catch { return undefined; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function nativeSessionOperation({ action, target, instance, revision, deadline }: { action: "read" | "begin"; target: string; instance?: string; revision?: number; deadline: number }): unknown {
  if (Date.now() > deadline) return undefined;
  if (location.href !== target || location.origin !== "https://my.smartthings.com") return undefined;
  const api = (window as unknown as Record<symbol, { read(): any; begin(enable: boolean): string }>)[Symbol.for("smartthings_web_bridge.native_session")];
  if (typeof api?.read !== "function") return undefined;
  if (action === "read") return api.read();
  if (typeof api.begin !== "function" || (api.read()?.instance !== instance || api.read()?.revision !== revision)) return "unsupported";
  return api.begin(true);
}
function sanitizeSnapshot(raw: unknown): NativeSnapshot | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1 || r.available !== true || typeof r.instance !== "string" ||
      !/^[a-f0-9-]{36}$/.test(r.instance) || !Number.isSafeInteger(r.revision) || Number(r.revision) < 0 ||
      !["uiKeepSignedIn", "sessionKeepSignedIn", "socketConnected", "socketAuthenticated", "busy"].every(k => typeof r[k] === "boolean") ||
      !Number.isFinite(r.expiresInMs) || Number(r.expiresInMs) < -86400_000 || Number(r.expiresInMs) > 31 * 86400_000 ||
      !Number.isFinite(r.busyAgeMs) || Number(r.busyAgeMs) < 0 ||
      !["idle", "requested", "renewed", "applied", "unconfirmed", "stale"].includes(String(r.outcome))) return undefined;
  return { instance: r.instance, revision: Number(r.revision), uiKeepSignedIn: r.uiKeepSignedIn as boolean,
    sessionKeepSignedIn: r.sessionKeepSignedIn as boolean, socketConnected: r.socketConnected as boolean,
    socketAuthenticated: r.socketAuthenticated as boolean, expiresInMs: Number(r.expiresInMs),
    busy: r.busy as boolean, busyAgeMs: Number(r.busyAgeMs), outcome: r.outcome as NativeSnapshot["outcome"],
    ...(typeof r.storageAllowed === "boolean" ? { storageAllowed: r.storageAllowed } : {}) };
}

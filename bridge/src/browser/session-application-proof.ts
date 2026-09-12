import type { BrowserPageLike } from "./keeper-page.js";

export type ApplicationSessionReason =
  | "verified" | "invalid_target" | "client_unavailable" | "read_timeout"
  | "http_401" | "http_403" | "read_failed" | "wrong_location"
  | "navigation_changed" | "renderer_timeout" | "evaluation_failed";
export interface ApplicationSessionProof {
  outcome: "ok" | "reauth" | "failed";
  reason: ApplicationSessionReason;
}

/** Check the existing Location application's own read-only connection. A 200
 * from the separate Advanced HTTP surface is not proof of this connection.
 * No new client, credentials, authentication strategy, or device write is used.
 */
export async function verifyLocationApplicationSession(
  page: BrowserPageLike, expectedUrl: string, timeoutMs = 10_000
): Promise<ApplicationSessionProof> {
  const failed = (reason: ApplicationSessionReason): ApplicationSessionProof => ({ outcome: "failed", reason });
  let id: string;
  try {
    const target = new URL(expectedUrl);
    const current = new URL(page.url());
    const match = /^\/location\/([^/]+)\/?$/u.exec(target.pathname);
    if (!match || target.origin !== "https://my.smartthings.com" || target.search || target.hash ||
        current.origin !== target.origin || current.pathname !== target.pathname || current.search || current.hash) {
      return failed("invalid_target");
    }
    id = decodeURIComponent(match[1]!);
    if (!id || id.length > 512 || /[\u0000-\u001f\u007f/]/u.test(id)) return failed("invalid_target");
  } catch { return failed("invalid_target"); }
  if (!page.evaluate || page.isClosed()) return failed("evaluation_failed");
  const initialUrl = page.url();
  const budget = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(10_000, Math.floor(timeoutMs))) : 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = page.evaluate(async ({ id, budget }): Promise<ApplicationSessionProof> => {
      const failed = (reason: ApplicationSessionReason): ApplicationSessionProof => ({ outcome: "failed", reason });
      const deadline = performance.now() + budget;
      type NativeClient = { service?: (name: string) => { get?: (id: string) => Promise<unknown> } };
      let client: NativeClient | undefined;
      do {
        client = (window as unknown as Record<symbol, NativeClient>)[Symbol.for("smartthings_web_bridge.cake_client")];
        if (typeof client?.service === "function") break;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - performance.now()))));
      } while (performance.now() < deadline);
      if (typeof client?.service !== "function") return failed("client_unavailable");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol();
      try {
        // Reuse the same observed read-only service as location-status.ts.
        const service = client.service("api/location");
        if (typeof service?.get !== "function") return failed("client_unavailable");
        const response = await Promise.race([
          service.get(id),
          new Promise<typeof timedOut>(resolve => {
            timeout = setTimeout(() => resolve(timedOut), Math.max(1, deadline - performance.now()));
          })
        ]);
        if (response === timedOut) return failed("read_timeout");
        const record = (value: unknown): Record<string, unknown> | undefined =>
          typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
        const outer = record(response);
        const row = record(outer?.data) ?? outer;
        if (!row || outer?.error || outer?.errors || row.error || row.errors ||
            (row.locationId ?? row.location_id ?? row.id) !== id) return failed("wrong_location");
        return { outcome: "ok", reason: "verified" };
      } catch (error) {
        const code = typeof error === "object" && error !== null
          ? ((error as Record<string, unknown>).code ?? (error as Record<string, unknown>).status) : undefined;
        if (code === 401) return { outcome: "reauth", reason: "http_401" };
        return failed(code === 403 ? "http_403" : "read_failed");
      } finally { if (timeout !== undefined) clearTimeout(timeout); }
    }, { id, budget });
    const proof = await Promise.race([work, new Promise<ApplicationSessionProof>(resolve => {
      timer = setTimeout(() => resolve(failed("renderer_timeout")), budget + 250);
    })]);
    if (page.isClosed() || page.url() !== initialUrl) return failed("navigation_changed");
    const reasons: readonly string[] = ["verified", "client_unavailable", "read_timeout", "http_401", "http_403",
      "read_failed", "wrong_location", "renderer_timeout"];
    if (!proof || !reasons.includes(proof.reason)) return failed("evaluation_failed");
    // Construct a fresh allowlisted object: never leak a response/error body.
    if (proof.reason === "verified" && proof.outcome === "ok") return { outcome: "ok", reason: "verified" };
    if (proof.reason === "http_401") return { outcome: "reauth", reason: "http_401" };
    return failed(proof.reason);
  } catch { return failed("evaluation_failed"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export type AuthenticationSurface = "password_input" | "otp_input" | "email_input" | "no_visible_auth_input" | "unavailable";
export type AuthenticationPageCategory = "samsung_account" | "smartthings_account" | "smartthings_location" | "other";
export interface AuthenticationPageDiagnostic {
  page: AuthenticationPageCategory;
  surface: AuthenticationSurface;
}

/** Observe presence of visible standard authentication controls, never values,
 * text, URLs, query strings, HTML, cookies or tokens. Absence is not proof that
 * no challenge exists; iframe/custom controls are intentionally 'unknown'.
 */
export async function inspectAuthenticationPage(page: BrowserPageLike): Promise<AuthenticationPageDiagnostic> {
  let category: AuthenticationPageCategory = "other";
  try {
    const url = new URL(page.url());
    if (url.origin === "https://account.samsung.com") category = "samsung_account";
    else if (url.origin === "https://account.smartthings.com") category = "smartthings_account";
    else if (url.origin === "https://my.smartthings.com" && /^\/location(?:\/|$)/u.test(url.pathname)) category = "smartthings_location";
  } catch { /* Do not include the URL in diagnostics. */ }
  if (!page.evaluate || page.isClosed()) return { page: category, surface: "unavailable" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const initialUrl = page.url();
  try {
    const work = page.evaluate((): AuthenticationSurface => {
      const visible = (selector: string) => Array.from(document.querySelectorAll<HTMLInputElement>(selector)).some(input => {
        const style = getComputedStyle(input);
        return input.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      if (visible('input[autocomplete="one-time-code"]')) return "otp_input";
      if (visible('input[type="password"]')) return "password_input";
      if (visible('input[type="email"]')) return "email_input";
      return "no_visible_auth_input";
    }, undefined);
    const surface = await Promise.race([work, new Promise<AuthenticationSurface>(resolve => {
      timer = setTimeout(() => resolve("unavailable"), 1_500);
    })]);
    const allowed = ["password_input", "otp_input", "email_input", "no_visible_auth_input"];
    return { page: category, surface: page.url() === initialUrl && allowed.includes(surface) ? surface : "unavailable" };
  } catch { return { page: category, surface: "unavailable" }; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

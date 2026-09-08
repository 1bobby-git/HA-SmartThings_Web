import type { BrowserPageLike } from "../browser/keeper-page.js";
import type { AdvancedEndpointCategory } from "./types.js";

export type AdvancedParser<T> = (value: unknown) => T;

export interface AdvancedRequest {
  endpoint: AdvancedEndpointCategory;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** Optional READ-only fast path: never open a fallback page for this request. */
  keeperOnly?: boolean;
}

export interface AuthenticatedAdvancedSession {
  request<T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T>;
}

export type AdvancedSessionErrorCode =
  | "advanced_request_path_invalid"
  | "advanced_request_unavailable"
  | "advanced_authentication_failed"
  | "advanced_permission_denied"
  | "advanced_http_error"
  | "advanced_timeout"
  | "advanced_response_invalid";

export class AdvancedSessionError extends Error {
  constructor(
    readonly code: AdvancedSessionErrorCode,
    readonly endpoint: AdvancedEndpointCategory,
    readonly status?: number
  ) {
    super(code);
    this.name = "AdvancedSessionError";
  }
}

interface SessionPageManager {
  currentKeeper(): BrowserPageLike | undefined;
  openAdvancedPage(): Promise<BrowserPageLike>;
}

export interface AdvancedRequestTiming {
  endpoint: AdvancedEndpointCategory;
  method: "GET" | "POST";
  route: "keeper" | "advanced_page" | "context";
  totalMs: number;
  status: number;
  browserMs?: number;
  fetchMs?: number;
  bodyMs?: number;
  bridgeOverheadMs?: number;
}

interface BrowserFetchResult {
  ok: boolean;
  status: number;
  value?: unknown;
  error?: string;
  timing?: { browserMs: number; fetchMs: number; bodyMs: number };
}

export interface AuthenticatedSmartThingsSessionOptions extends SessionPageManager {
  requestJson?: (request: AdvancedRequest) => Promise<BrowserFetchResult | undefined>;
  defaultTimeoutMs?: number;
  onRequestTiming?: (event: AdvancedRequestTiming) => void;
  onAuthenticationFailure?: (page: BrowserPageLike, url: string) => void;
}

const SMARTTHINGS_ORIGIN = "https://my.smartthings.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export class AuthenticatedSmartThingsSession implements AuthenticatedAdvancedSession {
  constructor(private readonly options: AuthenticatedSmartThingsSessionOptions) {}

  async request<T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T> {
    const safeRequest = normalizeRequest(
      request,
      this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    if (request.keeperOnly !== undefined && (request.keeperOnly !== true || safeRequest.method !== "GET")) {
      throw new AdvancedSessionError("advanced_request_path_invalid", request.endpoint);
    }
    const requestKeeper = this.options.currentKeeper();
    const requestKeeperUrl = requestKeeper?.url();
    const measured = async (route: AdvancedRequestTiming["route"], run: () => Promise<BrowserFetchResult | undefined>) => {
      const start = performance.now();
      const result = await run();
      if (result?.status === 401 && requestKeeper && requestKeeperUrl !== undefined &&
          this.options.currentKeeper() === requestKeeper && !requestKeeper.isClosed() && requestKeeper.url() === requestKeeperUrl) {
        try { this.options.onAuthenticationFailure?.(requestKeeper, requestKeeperUrl); }
        catch { /* Recovery notifications cannot change delivery or replay a POST. */ }
      }
      if (safeRequest.method === "POST" && safeRequest.endpoint === "commands") {
        const totalMs = Math.max(0, Math.round(performance.now() - start));
        const timing = result?.timing;
        const valid = timing && [timing.browserMs, timing.fetchMs, timing.bodyMs]
          .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120_000) &&
          timing.fetchMs + timing.bodyMs <= timing.browserMs + 2;
        try {
          this.options.onRequestTiming?.({ endpoint: "commands", method: "POST", route, totalMs,
            status: Number.isInteger(result?.status) && result!.status >= 0 && result!.status <= 599 ? result!.status : 0,
            ...(valid ? { browserMs: Math.round(timing.browserMs), fetchMs: Math.round(timing.fetchMs),
              bodyMs: Math.round(timing.bodyMs), bridgeOverheadMs: Math.max(0, totalMs - Math.round(timing.browserMs)) } : {}) });
        } catch { /* Timing observers cannot alter command delivery. */ }
      }
      return result;
    };
    const keeper = this.options.currentKeeper();
    if (keeper?.evaluate && !keeper.isClosed()) {
      const keeperResult = (await measured("keeper", () => executePageRequest(keeper, safeRequest)))!;
      if (keeperResult.ok) return parseResult(keeperResult, request.endpoint, parser);
      if (request.keeperOnly) throw classifyFailure(request.endpoint, keeperResult);
      if (safeRequest.method === "POST" && !knownNotSent(keeperResult)) {
        throw classifyFailure(request.endpoint, keeperResult);
      }
      if (keeperResult.status === 401) {
        throw new AdvancedSessionError(
          "advanced_authentication_failed",
          request.endpoint,
          keeperResult.status
        );
      }
    }

    if (request.keeperOnly) throw new AdvancedSessionError("advanced_request_unavailable", request.endpoint);

    if (this.options.requestJson) {
      const contextResult = await measured("context", () => this.options.requestJson!(safeRequest));
      if (contextResult?.ok) return parseResult(contextResult, request.endpoint, parser);
      if (safeRequest.method === "POST" && contextResult && !knownNotSent(contextResult)) {
        throw classifyFailure(request.endpoint, contextResult);
      }
      if (contextResult?.status === 401) {
        throw new AdvancedSessionError(
          "advanced_authentication_failed",
          request.endpoint,
          contextResult.status
        );
      }
    }

    let page: BrowserPageLike | undefined;
    try {
      page = await this.options.openAdvancedPage();
      if (!page.evaluate || page.isClosed()) {
        throw new AdvancedSessionError("advanced_request_unavailable", request.endpoint);
      }
      const result = (await measured("advanced_page", () => executePageRequest(page!, safeRequest)))!;
      if (!result.ok) throw classifyFailure(request.endpoint, result);
      return parseResult(result, request.endpoint, parser);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
}

function knownNotSent(result: BrowserFetchResult): boolean {
  return result.status === 0 && ["csrf_token_unavailable", "evaluate_unavailable"].includes(result.error ?? "");
}

async function executePageRequest(
  page: BrowserPageLike,
  request: Required<Pick<AdvancedRequest, "endpoint" | "method" | "path" | "timeoutMs">> &
    Pick<AdvancedRequest, "body">
): Promise<BrowserFetchResult> {
  if (!page.evaluate) {
    return { ok: false, status: 0, error: "evaluate_unavailable" };
  }
  try {
    return await page.evaluate(
      async (input) => {
        const startedAt = performance.now();
        let fetchMs = 0, bodyMs = 0;
        const finish = (result: { ok: boolean; status: number; value?: unknown; error?: string }) => ({
          ...result, timing: { browserMs: performance.now() - startedAt, fetchMs, bodyMs }
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs);
        try {
          const headers: Record<string, string> = {};
          if (input.body !== undefined) {
            headers["content-type"] = "application/json";
          }
          if (input.method === "POST") {
            const csrfToken = smartThingsCsrfToken();
            if (!csrfToken) {
              return finish({ ok: false, status: 0, error: "csrf_token_unavailable" });
            }
            headers["x-csrf-token"] = csrfToken;
          }
          const fetchStartedAt = performance.now();
          // api-free-audit: authenticated-page-same-origin-advanced-request
          const response = await fetch(input.path, {
            cache: "no-store",
            credentials: "same-origin",
            method: input.method,
            redirect: "manual",
            signal: controller.signal,
            ...(Object.keys(headers).length === 0 ? {} : { headers }),
            ...(input.body === undefined
              ? {}
              : {
                  body: JSON.stringify(input.body)
                })
          });
          fetchMs = performance.now() - fetchStartedAt;
          if (response.type === "opaqueredirect") {
            return finish({ ok: false, status: 401, error: "redirect" });
          }
          const bodyStartedAt = performance.now();
          let value: unknown;
          try {
            value = await response.json();
          } catch {
            bodyMs = performance.now() - bodyStartedAt;
            return finish({ ok: false, status: response.status, error: "invalid_json" });
          }
          bodyMs = performance.now() - bodyStartedAt;
          return finish(response.ok
            ? { ok: true, status: response.status, value }
            : { ok: false, status: response.status, value, error: `http_${response.status}` });
        } catch (error) {
          return finish({
            ok: false,
            status: 0,
            error: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network"
          });
        } finally {
          clearTimeout(timer);
        }

        function smartThingsCsrfToken(): string | undefined {
          const app = (
            ((globalThis as { window?: { _app?: { csrfToken?: unknown } } }).window ??
              globalThis) as { _app?: { csrfToken?: unknown } }
          )._app;
          const token = app?.csrfToken;
          if (
            typeof token !== "string" ||
            token.length < 1 ||
            token.length > 4096 ||
            /[\u0000-\u001f\u007f]/u.test(token)
          ) {
            return undefined;
          }
          return token;
        }
      },
      request
    );
  } catch {
    return { ok: false, status: 0, error: "evaluate_failed" };
  }
}

function normalizeRequest(
  request: AdvancedRequest,
  defaultTimeoutMs: number
): Required<Pick<AdvancedRequest, "endpoint" | "method" | "path" | "timeoutMs">> &
  Pick<AdvancedRequest, "body"> {
  let url: URL;
  try {
    url = new URL(request.path, SMARTTHINGS_ORIGIN);
  } catch {
    throw new AdvancedSessionError("advanced_request_path_invalid", request.endpoint);
  }
  if (
    url.origin !== SMARTTHINGS_ORIGIN ||
    !url.pathname.startsWith("/advanced/cupcake-api/") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new AdvancedSessionError("advanced_request_path_invalid", request.endpoint);
  }
  const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new AdvancedSessionError("advanced_request_path_invalid", request.endpoint);
  }
  return {
    endpoint: request.endpoint,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    timeoutMs,
    ...(request.body === undefined ? {} : { body: request.body })
  };
}

function parseResult<T>(
  result: BrowserFetchResult,
  endpoint: AdvancedEndpointCategory,
  parser: AdvancedParser<T>
): T {
  if (!("value" in result)) {
    throw new AdvancedSessionError("advanced_response_invalid", endpoint, result.status);
  }
  return parser(result.value);
}

function classifyFailure(
  endpoint: AdvancedEndpointCategory,
  result: BrowserFetchResult
): AdvancedSessionError {
  if (result.error === "timeout") return new AdvancedSessionError("advanced_timeout", endpoint);
  if (result.error === "invalid_json") {
    return new AdvancedSessionError("advanced_response_invalid", endpoint, result.status);
  }
  if (result.status === 401) {
    return new AdvancedSessionError("advanced_authentication_failed", endpoint, result.status);
  }
  if (result.status === 403) {
    return new AdvancedSessionError("advanced_permission_denied", endpoint, result.status);
  }
  if (result.status > 0) {
    return new AdvancedSessionError("advanced_http_error", endpoint, result.status);
  }
  return new AdvancedSessionError("advanced_request_unavailable", endpoint);
}

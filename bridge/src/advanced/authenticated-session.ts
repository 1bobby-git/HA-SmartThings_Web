import type { BrowserPageLike } from "../browser/keeper-page.js";
import type { AdvancedEndpointCategory } from "./types.js";

export type AdvancedParser<T> = (value: unknown) => T;

export interface AdvancedRequest {
  endpoint: AdvancedEndpointCategory;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs?: number;
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

interface BrowserFetchResult {
  ok: boolean;
  status: number;
  value?: unknown;
  error?: string;
}

export interface AuthenticatedSmartThingsSessionOptions extends SessionPageManager {
  requestJson?: (request: AdvancedRequest) => Promise<BrowserFetchResult | undefined>;
  defaultTimeoutMs?: number;
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
    const keeper = this.options.currentKeeper();
    if (keeper?.evaluate && !keeper.isClosed()) {
      const keeperResult = await executePageRequest(keeper, safeRequest);
      if (keeperResult.ok) return parseResult(keeperResult, request.endpoint, parser);
      if (keeperResult.status === 401) {
        throw new AdvancedSessionError(
          "advanced_authentication_failed",
          request.endpoint,
          keeperResult.status
        );
      }
    }

    if (this.options.requestJson) {
      const contextResult = await this.options.requestJson(safeRequest);
      if (contextResult?.ok) return parseResult(contextResult, request.endpoint, parser);
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
      const result = await executePageRequest(page, safeRequest);
      if (!result.ok) throw classifyFailure(request.endpoint, result);
      return parseResult(result, request.endpoint, parser);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
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
              return { ok: false, status: 0, error: "csrf_token_unavailable" };
            }
            headers["x-csrf-token"] = csrfToken;
          }
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
          if (response.type === "opaqueredirect") {
            return { ok: false, status: 401, error: "redirect" };
          }
          let value: unknown;
          try {
            value = await response.json();
          } catch {
            return { ok: false, status: response.status, error: "invalid_json" };
          }
          return response.ok
            ? { ok: true, status: response.status, value }
            : { ok: false, status: response.status, value, error: `http_${response.status}` };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            error: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network"
          };
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

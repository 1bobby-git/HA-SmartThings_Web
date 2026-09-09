from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8", newline="\n")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:80]!r}")
    write(path, text.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    text = read(path)
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} replacements, found {count}: {old!r}")
    write(path, text.replace(old, new))


# 1) A browser-local fast path for light commands. It reuses only the already
# authenticated Cake client captured from the persistent keeper. It returns
# None only before service.patch is called, making an Advanced fetch fallback safe.
app_client = r'''import type { BrowserPageLike } from "../browser/keeper-page.js";

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
          ((globalThis as { window?: PageRecord }).window ?? globalThis) as PageRecord
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
          return record(value) && typeof value.service === "function"
            ? (value as NativeClient)
            : undefined;
        }

        function asService(value: unknown): NativeService | undefined {
          return record(value) && typeof value.patch === "function"
            ? (value as NativeService)
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
    return outcome.kind === "unavailable" ? undefined : outcome.result;
  } catch {
    // Playwright can reject after browser execution has already started (for
    // example during navigation/context loss), so this is deliberately NOT a
    // safe-to-replay result.
    return { ok: false, status: 0, error: "app_client_evaluate_failed" };
  }
}
'''
write("bridge/src/advanced/app-client-command.ts", app_client)

# 2) Opt in only the verified light-plan adapter calls. Generic Advanced
# commands retain the existing CSRF fetch transport.
replace_once(
    "bridge/src/advanced/command-adapter.ts",
    'path: advancedEndpoints.deviceCommands(deviceId),\n        body: { commands }\n      },',
    'path: advancedEndpoints.deviceCommands(deviceId),\n        body: { commands },\n        preferAppClient: true\n      },',
)
replace_once(
    "bridge/src/advanced/command-adapter.ts",
    'path: advancedEndpoints.deviceCommands(deviceId),\n          body: { commands: [command] }\n        },',
    'path: advancedEndpoints.deviceCommands(deviceId),\n          body: { commands: [command] },\n          preferAppClient: true\n        },',
)

# 3) Session wiring: try the browser-local app client only on the persistent
# keeper. If it is unavailable before patch(), continue through the exact old
# Advanced fetch. Never try it on auxiliary pages or context fallbacks.
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    'import type { BrowserPageLike } from "../browser/keeper-page.js";\n',
    'import type { BrowserPageLike } from "../browser/keeper-page.js";\nimport { executeAppClientCommand } from "./app-client-command.js";\n',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '  /** Optional READ-only fast path: never open a fallback page for this request. */\n  keeperOnly?: boolean;\n',
    '  /** Optional READ-only fast path: never open a fallback page for this request. */\n  keeperOnly?: boolean;\n  /** Verified light plans may reuse the keeper\'s already-loaded api/device client. */\n  preferAppClient?: boolean;\n',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '  bridgeOverheadMs?: number;\n}',
    '  bridgeOverheadMs?: number;\n  appClient?: true;\n}',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '  timing?: { browserMs: number; fetchMs: number; bodyMs: number };\n}',
    '  timing?: { browserMs: number; fetchMs: number; bodyMs: number; appClient?: true };\n}',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '    if (request.keeperOnly !== undefined && (request.keeperOnly !== true || safeRequest.method !== "GET")) {\n      throw new AdvancedSessionError("advanced_request_path_invalid", request.endpoint);\n    }\n',
    '    if (request.keeperOnly !== undefined && (request.keeperOnly !== true || safeRequest.method !== "GET")) {\n      throw new AdvancedSessionError("advanced_request_path_invalid", request.endpoint);\n    }\n    if (request.preferAppClient !== undefined &&\n        (request.preferAppClient !== true || safeRequest.method !== "POST" || safeRequest.endpoint !== "commands")) {\n      throw new AdvancedSessionError("advanced_request_path_invalid", request.endpoint);\n    }\n',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '            ...(valid ? { browserMs: Math.round(timing.browserMs), fetchMs: Math.round(timing.fetchMs),\n              bodyMs: Math.round(timing.bodyMs), bridgeOverheadMs: Math.max(0, totalMs - Math.round(timing.browserMs)) } : {}) });',
    '            ...(valid ? { browserMs: Math.round(timing.browserMs), fetchMs: Math.round(timing.fetchMs),\n              bodyMs: Math.round(timing.bodyMs), bridgeOverheadMs: Math.max(0, totalMs - Math.round(timing.browserMs)),\n              ...(timing.appClient === true ? { appClient: true as const } : {}) } : {}) });',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '    if (keeper?.evaluate && !keeper.isClosed()) {\n      const keeperResult = (await measured("keeper", () => executePageRequest(keeper, safeRequest)))!;\n',
    '    if (keeper?.evaluate && !keeper.isClosed()) {\n      const keeperResult = (await measured("keeper", async () => {\n        if (safeRequest.preferAppClient === true) {\n          const appClientResult = await executeAppClientCommand(keeper, safeRequest);\n          if (appClientResult !== undefined) return appClientResult;\n        }\n        return await executePageRequest(keeper, safeRequest);\n      }))!;\n',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '  request: Required<Pick<AdvancedRequest, "endpoint" | "method" | "path" | "timeoutMs">> &\n    Pick<AdvancedRequest, "body">\n',
    '  request: Required<Pick<AdvancedRequest, "endpoint" | "method" | "path" | "timeoutMs">> &\n    Pick<AdvancedRequest, "body" | "preferAppClient">\n',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '): Required<Pick<AdvancedRequest, "endpoint" | "method" | "path" | "timeoutMs">> &\n  Pick<AdvancedRequest, "body"> {\n',
    '): Required<Pick<AdvancedRequest, "endpoint" | "method" | "path" | "timeoutMs">> &\n  Pick<AdvancedRequest, "body" | "preferAppClient"> {\n',
)
replace_once(
    "bridge/src/advanced/authenticated-session.ts",
    '    timeoutMs,\n    ...(request.body === undefined ? {} : { body: request.body })\n',
    '    timeoutMs,\n    ...(request.body === undefined ? {} : { body: request.body }),\n    ...(request.preferAppClient === true ? { preferAppClient: true } : {})\n',
)

# 4) Focused regression coverage executes the real pageFunction in-process.
test_source = r'''import { afterEach, describe, expect, test, vi } from "vitest";

import { AdvancedCommandAdapter } from "../../src/advanced/command-adapter.js";
import {
  CapabilityDefinitionCache,
  parseCapabilityDefinition
} from "../../src/advanced/capability-cache.js";
import {
  AuthenticatedSmartThingsSession,
  type AdvancedParser,
  type AdvancedRequest,
  type AuthenticatedAdvancedSession
} from "../../src/advanced/authenticated-session.js";
import type { BrowserPageLike } from "../../src/browser/keeper-page.js";
import type { RoutedCommandRequest } from "../../src/command/command-router.js";

class ExecutingPage implements BrowserPageLike {
  closed = false;
  constructor(public currentUrl = "https://my.smartthings.com/location") {}
  url(): string { return this.currentUrl; }
  isClosed(): boolean { return this.closed; }
  async goto(url: string): Promise<void> { this.currentUrl = url; }
  async close(): Promise<void> { this.closed = true; }
  async evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    return await pageFunction(argument);
  }
}

class RecordingSession implements AuthenticatedAdvancedSession {
  readonly requests: AdvancedRequest[] = [];
  constructor(private readonly resultsPerRequest: number) {}
  async request<T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T> {
    this.requests.push(request);
    return parser({ results: Array.from({ length: this.resultsPerRequest }, () => ({ status: "ACCEPTED" })) });
  }
}

function setPageWindow(value: Record<PropertyKey, unknown>): void {
  vi.stubGlobal("window", value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("keeper app-client light fast path", () => {
  test("uses the already-loaded api/device service without an Advanced fetch", async () => {
    const patch = vi.fn(async () => ({ data: { results: [{ status: "ACCEPTED" }] } }));
    const pageWindow: Record<PropertyKey, unknown> = { _app: { csrfToken: "unused-fixture" } };
    pageWindow[Symbol.for("smartthings_web_bridge.cake_client")] = {
      service: (name: string) => name === "api/device" ? { patch } : undefined
    };
    setPageWindow(pageWindow);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const timing: unknown[] = [];
    const page = new ExecutingPage();
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => page,
      openAdvancedPage: vi.fn(),
      onRequestTiming: (event) => timing.push(event)
    });
    const body = {
      commands: [
        { component: "main", capability: "switch", command: "on", arguments: [] },
        { component: "main", capability: "switchLevel", command: "setLevel", arguments: [42] }
      ]
    };
    await expect(session.request({
      endpoint: "commands",
      method: "POST",
      path: "/advanced/cupcake-api/api/devices/raw-device/commands",
      body,
      preferAppClient: true
    }, (value) => value)).resolves.toEqual({
      results: [{ status: "ACCEPTED" }, { status: "ACCEPTED" }]
    });
    expect(patch).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith("raw-device", {
      query: {
        execute: true,
        commands: [
          { component: "main", capability: "switch", command: "on" },
          { component: "main", capability: "switchLevel", command: "setLevel", arguments: [42] }
        ]
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(timing).toEqual([
      expect.objectContaining({
        endpoint: "commands",
        method: "POST",
        route: "keeper",
        status: 202,
        appClient: true,
        browserMs: expect.any(Number),
        fetchMs: expect.any(Number),
        bodyMs: 0
      })
    ]);
  });

  test("falls back to the unchanged CSRF fetch only before patch is available", async () => {
    setPageWindow({ _app: { csrfToken: "fixture-csrf" } });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      type: "basic",
      json: async () => ({ results: [{ status: "ACCEPTED" }] })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const page = new ExecutingPage();
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => page,
      openAdvancedPage: vi.fn()
    });
    await expect(session.request({
      endpoint: "commands",
      method: "POST",
      path: "/advanced/cupcake-api/api/devices/raw-device/commands",
      body: { commands: [{ component: "main", capability: "switch", command: "on", arguments: [] }] },
      preferAppClient: true
    }, (value) => value)).resolves.toEqual({ results: [{ status: "ACCEPTED" }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("never replays through fetch after api/device patch has been attempted", async () => {
    const patch = vi.fn(async () => { throw new Error("fixture failure"); });
    const pageWindow: Record<PropertyKey, unknown> = { _app: { csrfToken: "fixture-csrf" } };
    pageWindow[Symbol.for("smartthings_web_bridge.cake_client")] = {
      service: () => ({ patch })
    };
    setPageWindow(pageWindow);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const openAdvancedPage = vi.fn();
    const page = new ExecutingPage();
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => page,
      openAdvancedPage
    });
    await expect(session.request({
      endpoint: "commands",
      method: "POST",
      path: "/advanced/cupcake-api/api/devices/raw-device/commands",
      body: { commands: [{ component: "main", capability: "switch", command: "on", arguments: [] }] },
      preferAppClient: true
    }, (value) => value)).rejects.toThrow("advanced_request_unavailable");
    expect(patch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openAdvancedPage).not.toHaveBeenCalled();
  });
});

describe("light adapter app-client opt in", () => {
  const actions: RoutedCommandRequest[] = [
    { deviceId: "dev_001", component: "main", capability: "switch", capabilityVersion: 1,
      command: "on", arguments: [] },
    { deviceId: "dev_001", component: "main", capability: "switchLevel", capabilityVersion: 1,
      command: "setLevel", arguments: [42] }
  ];
  const definition = (id: string) => parseCapabilityDefinition({
    id,
    version: 1,
    attributes: {},
    commands: {
      on: { arguments: [] },
      setLevel: { arguments: [{ name: "level", schema: { type: "integer", minimum: 0, maximum: 100 } }] }
    }
  });

  test("marks both batch and sequence light-plan POSTs for keeper app-client reuse", async () => {
    const cache = new CapabilityDefinitionCache(async (id) => definition(id));
    const batchSession = new RecordingSession(2);
    const batch = new AdvancedCommandAdapter({
      session: batchSession,
      capabilityCache: cache,
      resolveRawDeviceId: () => "raw-device",
      resolveRawIdentifier: (id) => id
    });
    await batch.executeBatch(actions);
    expect(batchSession.requests).toHaveLength(1);
    expect(batchSession.requests[0]?.preferAppClient).toBe(true);

    const sequenceSession = new RecordingSession(1);
    const sequence = new AdvancedCommandAdapter({
      session: sequenceSession,
      capabilityCache: cache,
      resolveRawDeviceId: () => "raw-device",
      resolveRawIdentifier: (id) => id
    });
    await sequence.executeSequence(actions);
    expect(sequenceSession.requests).toHaveLength(2);
    expect(sequenceSession.requests.every((request) => request.preferAppClient === true)).toBe(true);
  });
});
'''
write("bridge/tests/advanced/light-app-client-fast-path.test.ts", test_source)

# 5) Version synchronization.
replace_once("package.json", '"version": "1.8.35"', '"version": "1.8.36"')
replace_count("package-lock.json", '"version": "1.8.35"', '"version": "1.8.36"', 2)
replace_once("bridge/src/runtime.ts", 'const bridgeVersion = "1.8.35";', 'const bridgeVersion = "1.8.36";')
replace_once("custom_components/smartthings_web/manifest.json", '"version": "1.8.35"', '"version": "1.8.36"')
replace_once("addon/smartthings_web_bridge/config.yaml", 'version: 1.8.35', 'version: 1.8.36')

# 6) Release notes/documentation. Do not claim a real-device speed number until
# the user's HA logs prove it.
changelog = '''## 1.8.36\n\n- 조명 `applyLight`의 검증된 Advanced 전송에 로그인된 keeper가 이미 로드한 SmartThings 웹앱 `api/device` 서비스를 우선 사용하는 fast path를 추가합니다. 새 브라우저 컨텍스트/탭, 쿠키 복제, 별도 로그인을 만들지 않으며 기존 persistent Chromium 프로필과 세션 유지/복구를 그대로 사용합니다.\n- fast path는 `service.patch(deviceId, { query: { execute: true, commands } })`가 호출되기 **전** 서비스가 없을 때만 기존 `/advanced/cupcake-api/.../commands` CSRF POST로 폴백합니다. patch 호출 후 시간초과·네트워크·인증 오류는 불확실 재전송을 하지 않아 같은 물리 명령의 중복 실행을 막습니다. 일반 Advanced 명령, Home Monitor, 장면 및 조회는 기존 경로를 유지합니다.\n- `advanced_request_timing`의 fast path 요청에는 `appClient:true`를 추가합니다. `fetchMs`는 이 경우 웹앱 client patch Promise의 왕복 대기이고 `browserMs`는 keeper 평가 전체 시간입니다. 원본 기기 ID·쿠키·CSRF·본문은 로그에 추가하지 않습니다.\n- 기존 `light_command_batch_enabled=true`이면 on/밝기/setColor/색온도 묶음은 계속 한 client patch로 전달되며 실제 상태 확인과 `command_superseded` 최신 의도 직렬화도 유지됩니다. 요청값을 HA 상태로 낙관 적용하지 않으며, 실제 상태 이벤트/상태 조회가 성공 조건입니다.\n- 제공된 1.8.35 로그의 `inventory_persist_timing` 60~117ms Worker 저장은 현재 약 690~790ms 명령 병목과 분리되어 있습니다. 이번 변경은 그 단일 Advanced keeper POST를 웹앱의 기존 제어 서비스로 우회하는 것이 핵심입니다. 사용자 `dev_300`의 실제 물리 반응 개선값은 업데이트 후 새 `advanced_request_timing`/`command_request_timing`으로 검증해야 하며 미측정 수치를 보장하지 않습니다.\n\n'''
path = "addon/smartthings_web_bridge/CHANGELOG.md"
text = read(path)
if not text.startswith("## 1.8.35\n"):
    raise SystemExit("unexpected addon changelog head")
write(path, changelog + text)

docs = '''## 1.8.36 조명 keeper 앱 클라이언트 fast path\n\nBridge와 HA 통합을 1.8.36으로 함께 업데이트하고 Bridge 앱을 재시작하세요. 조명 계획은 현재 로그인 keeper에 SmartThings 웹앱의 `api/device` 서비스가 이미 로드돼 있으면 그 서비스를 우선 재사용합니다. 새 탭/컨텍스트를 열거나 쿠키를 복제하지 않습니다. 서비스가 아직 없을 때만 기존 Advanced CSRF POST를 사용하며, 한 번 `patch()`를 시도한 요청은 실패 시 다른 전송으로 자동 재전송하지 않습니다.\n\n`advanced_request_timing`에 `appClient:true`가 보이면 fast path가 사용된 것입니다. 이 경우 `fetchMs`는 웹앱 client patch 대기 시간입니다. `light_command_batch_enabled=true`이면 검증된 전원+밝기/색상/색온도 조합을 계속 한 요청으로 보냅니다. 실제 상태 확인은 유지하므로 HA 요청 완료 시간이 물리 동작보다 늦을 수 있습니다. 요청값을 낙관적으로 상태에 쓰지는 않습니다.\n\n'''
path = "addon/smartthings_web_bridge/DOCS.md"
write(path, docs + read(path))

print("Applied SmartThings Web 1.8.36 light app-client fast path")

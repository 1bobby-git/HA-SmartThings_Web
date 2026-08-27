import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertOutputDirectoryOutsideRepo } from "./haos-soak-core.js";
import {
  DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
  createLiveControlEventBenchmarkPreview,
  runLiveControlEventBenchmark,
  type BridgeSseBenchmarkClient,
  type HaStateChangedEvent,
  type HomeAssistantEventControlClient
} from "./haos-live-control-event-benchmark-core.js";

interface CliOptions {
  execute: boolean;
  entityId: string;
  allowedEntityIds: readonly string[];
  cycles: number;
  outputDirectory?: string;
  repositoryRoot: string;
  haUrl: string;
  haWsUrl: string;
  haTokenFile?: string;
  bridgeUrl: string;
  bridgeTokenFile: string;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  baselineHaObservedAfterRequestMs?: number;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const haToken = await readOptionalToken(options.haTokenFile, process.env.SUPERVISOR_TOKEN);
  const ha = createHomeAssistantClient(options.haUrl, options.haWsUrl, haToken);

  if (!options.execute) {
    const preview = await createLiveControlEventBenchmarkPreview({
      entityId: options.entityId,
      allowedEntityIds: options.allowedEntityIds,
      cycles: options.cycles,
      ha
    });
    writeJson({ event: "haos_live_control_event_benchmark_preview", ...preview });
    return;
  }

  if (!options.outputDirectory) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
  const outputDirectory = await assertOutputDirectoryOutsideRepo(
    options.outputDirectory,
    options.repositoryRoot
  );
  await mkdir(outputDirectory, { recursive: true });
  const bridgeToken = await readOptionalToken(options.bridgeTokenFile);
  if (!bridgeToken) throw new Error("live_control_event_benchmark_bridge_token_missing");
  const bridgeDeviceId = await readBridgeDeviceIdFromEntityRegistry(
    options.haWsUrl,
    haToken,
    options.entityId
  );
  const bridge = createBridgeSseClient(options.bridgeUrl, bridgeToken);
  const result = await runLiveControlEventBenchmark({
    entityId: options.entityId,
    allowedEntityIds: options.allowedEntityIds,
    execute: true,
    cycles: options.cycles,
    ha,
    bridge,
    bridgeDeviceId,
    waitTimeoutMs: options.waitTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    ...(options.baselineHaObservedAfterRequestMs === undefined
      ? {}
      : { baselineHaObservedAfterRequestMs: options.baselineHaObservedAfterRequestMs }),
    writeArtifact: async (fileName, value) => {
      await writeFile(join(outputDirectory, fileName), `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600
      });
    }
  });
  writeJson({
    event: "haos_live_control_event_benchmark_completed",
    mode: result.mode,
    entityId: result.entityId,
    cycles: result.cycles,
    transitionCount: result.transitions.length,
    p95HaEventSeenAfterRequestMs: result.latency.p95HaEventSeenAfterRequestMs,
    bridgeSequenceGaps: result.sequence.gaps,
    speedupFactor: result.speedup.factor,
    finalState: result.finalState.state
  });
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string[]>();
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--execute") {
      execute = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("live_control_event_benchmark_arguments_invalid");
    }
    if (!ALLOWED_CLI_KEYS.has(key)) {
      throw new Error("live_control_event_benchmark_arguments_invalid");
    }
    values.set(key, [...(values.get(key) ?? []), value]);
    index += 1;
  }
  const entityId = single(values, "--entity-id") ?? DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID;
  const outputDirectory = single(values, "--output-dir");
  const haUrl = safeLocalHttpUrl(single(values, "--ha-url") ?? "http://supervisor/core/api");
  const parsed: CliOptions = {
    execute,
    entityId,
    allowedEntityIds: values.get("--allow-entity-id") ?? [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
    cycles: positiveInteger(single(values, "--cycles") ?? "10", 20),
    repositoryRoot: resolve(single(values, "--repository-root") ?? process.cwd()),
    haUrl,
    haWsUrl: safeLocalWsUrl(single(values, "--ha-ws-url") ?? httpApiUrlToWebsocket(haUrl)),
    bridgeUrl: safeLocalHttpUrl(single(values, "--bridge-url") ?? "http://127.0.0.1:8098"),
    bridgeTokenFile: resolve(single(values, "--bridge-token-file") ?? "/data/bridge-secret"),
    waitTimeoutMs: positiveInteger(single(values, "--timeout-ms") ?? "15000", 120_000),
    pollIntervalMs: nonNegativeInteger(single(values, "--poll-ms") ?? "25", 120_000)
  };
  const haTokenFile = single(values, "--ha-token-file");
  if (haTokenFile !== undefined) parsed.haTokenFile = resolve(haTokenFile);
  if (outputDirectory !== undefined) parsed.outputDirectory = resolve(outputDirectory);
  const baseline = single(values, "--baseline-ha-ms");
  if (baseline !== undefined) parsed.baselineHaObservedAfterRequestMs = positiveInteger(baseline, 600_000);
  return parsed;
}

function createHomeAssistantClient(
  baseUrl: string,
  websocketUrl: string,
  token: string | undefined
): HomeAssistantEventControlClient {
  return {
    async getState(entityId) {
      const response = await fetch(`${baseUrl}/states/${encodeURIComponent(entityId)}`, {
        headers: authHeaders(token)
      });
      if (!response.ok) throw new Error("live_control_event_benchmark_ha_state_failed");
      const raw = (await response.json()) as Record<string, unknown>;
      if (
        raw.entity_id !== entityId ||
        typeof raw.state !== "string" ||
        typeof raw.last_updated !== "string"
      ) {
        throw new Error("live_control_event_benchmark_ha_state_invalid");
      }
      return { entityId, state: raw.state, lastUpdated: raw.last_updated };
    },
    async callService(domain, service, data) {
      const response = await fetch(`${baseUrl}/services/${domain}/${service}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error("live_control_event_benchmark_ha_service_failed");
    },
    async subscribeStateChanged(entityId, onEvent) {
      const socket = await openHaWebSocket(websocketUrl, token);
      const subscriptionId = await sendHaRequest(socket, "subscribe_events", {
        event_type: "state_changed"
      });
      const listener = (message: MessageEvent) => {
        const raw = parseJsonRecord(message.data);
        const event = raw?.type === "event" ? parseHaStateEvent(raw.event, entityId) : undefined;
        if (event) onEvent(event);
      };
      socket.addEventListener("message", listener);
      return {
        async unsubscribe() {
          socket.removeEventListener("message", listener);
          if (socket.readyState === WebSocket.OPEN) {
            try {
              await sendHaRequest(socket, "unsubscribe_events", {
                subscription: subscriptionId
              });
            } catch {
              // The benchmark is already ending; close below still releases the socket.
            }
          }
          socket.close();
        }
      };
    }
  };
}

function createBridgeSseClient(baseUrl: string, token: string): BridgeSseBenchmarkClient {
  return {
    async subscribeEvents(onEvent) {
      const controller = new AbortController();
      void readBridgeEvents(baseUrl, token, controller.signal, onEvent);
      return {
        async unsubscribe() {
          controller.abort();
        }
      };
    }
  };
}

async function readBridgeEvents(
  baseUrl: string,
  token: string,
  signal: AbortSignal,
  onEvent: (event: unknown) => void
): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal
    });
    if (!response.ok || !response.body) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = parseJsonRecord(line.slice(6));
        if (raw) onEvent({ ...raw, receivedAt: new Date().toISOString() });
      }
    }
  } catch {
    if (!signal.aborted) throw new Error("live_control_event_benchmark_bridge_sse_failed");
  }
}

async function readBridgeDeviceIdFromEntityRegistry(
  websocketUrl: string,
  token: string | undefined,
  entityId: string
): Promise<string> {
  const socket = await openHaWebSocket(websocketUrl, token);
  try {
    const id = nextMessageId();
    socket.send(JSON.stringify({ id, type: "config/entity_registry/get", entity_id: entityId }));
    const response = await waitForHaResponse(socket, id);
    const result = isRecord(response.result) ? response.result : undefined;
    const uniqueId = typeof result?.unique_id === "string" ? result.unique_id : "";
    const match = uniqueId.match(/(?:^|_)(dev_[A-Za-z0-9]{3,64})(?:_|$)/u);
    if (!match?.[1]) throw new Error("live_control_event_benchmark_bridge_device_id_missing");
    return match[1];
  } finally {
    socket.close();
  }
}

async function openHaWebSocket(url: string, token: string | undefined): Promise<WebSocket> {
  if (!token) throw new Error("live_control_event_benchmark_ha_token_missing");
  const socket = new WebSocket(url);
  await waitForOpen(socket);
  const authRequired = await waitForNextMessage(socket);
  if (authRequired?.type === "auth_required") {
    socket.send(JSON.stringify({ type: "auth", access_token: token }));
    const auth = await waitForNextMessage(socket);
    if (auth?.type !== "auth_ok") {
      throw new Error("live_control_event_benchmark_ha_auth_failed");
    }
  }
  return socket;
}

async function sendHaRequest(
  socket: WebSocket,
  type: string,
  fields: Record<string, unknown>
): Promise<number> {
  const id = nextMessageId();
  socket.send(JSON.stringify({ id, type, ...fields }));
  await waitForHaResponse(socket, id);
  return id;
}

function waitForHaResponse(socket: WebSocket, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("live_control_event_benchmark_ha_ws_timeout"));
    }, 15_000);
    const listener = (message: MessageEvent) => {
      const raw = parseJsonRecord(message.data);
      if (raw?.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      if (raw.success === false) {
        reject(new Error("live_control_event_benchmark_ha_ws_failed"));
        return;
      }
      resolve(raw);
    };
    socket.addEventListener("message", listener);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("live_control_event_benchmark_ha_ws_timeout")), 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("live_control_event_benchmark_ha_ws_failed"));
    }, { once: true });
  });
}

function waitForNextMessage(socket: WebSocket): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("live_control_event_benchmark_ha_ws_timeout")), 15_000);
    socket.addEventListener("message", (message) => {
      clearTimeout(timeout);
      resolve(parseJsonRecord(message.data));
    }, { once: true });
  });
}

function parseHaStateEvent(value: unknown, entityId: string): HaStateChangedEvent | undefined {
  const event = isRecord(value) ? value : undefined;
  const data = isRecord(event?.data) ? event.data : undefined;
  const newState = isRecord(data?.new_state) ? data.new_state : undefined;
  if (
    data?.entity_id !== entityId ||
    (newState?.state !== "on" && newState?.state !== "off") ||
    typeof newState.last_updated !== "string"
  ) {
    return undefined;
  }
  return {
    entityId,
    state: newState.state,
    lastUpdated: newState.last_updated,
    receivedAt: new Date().toISOString()
  };
}

async function readOptionalToken(path: string | undefined, fallback?: string): Promise<string | undefined> {
  if (fallback?.trim()) return fallback.trim();
  if (!path) return undefined;
  try {
    const value = await readFile(path, "utf8");
    return value.trim() || undefined;
  } catch {
    return undefined;
  }
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function httpApiUrlToWebsocket(value: string): string {
  const parsed = new URL(value);
  parsed.protocol = "ws:";
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/websocket`;
  return parsed.toString();
}

const ALLOWED_CLI_KEYS = new Set([
  "--entity-id",
  "--allow-entity-id",
  "--cycles",
  "--output-dir",
  "--repository-root",
  "--ha-url",
  "--ha-ws-url",
  "--ha-token-file",
  "--bridge-url",
  "--bridge-token-file",
  "--timeout-ms",
  "--poll-ms",
  "--baseline-ha-ms"
]);

let messageId = 100;

function nextMessageId(): number {
  messageId += 1;
  return messageId;
}

function single(values: Map<string, string[]>, key: string): string | undefined {
  const found = values.get(key);
  if (!found) return undefined;
  if (found.length !== 1) throw new Error("live_control_event_benchmark_arguments_invalid");
  return found[0];
}

function positiveInteger(value: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
  return parsed;
}

function nonNegativeInteger(value: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
  return parsed;
}

function safeLocalHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    !["supervisor", "127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function safeLocalWsUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "ws:" ||
    !["supervisor", "127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (executedPath && import.meta.url === executedPath) {
  void main().catch(() => {
    process.stderr.write("haos_live_control_event_benchmark_failed\n");
    process.exitCode = 1;
  });
}

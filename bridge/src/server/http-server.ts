import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  SafeCommandError,
  type SafeCommandService
} from "../command/command-service.js";

import {
  PHYSICAL_ACTION_PRESETS,
  type PhysicalActionCorrelationProbe,
  type ProbeArmRequest,
  type ProbeRuntimeEvidence
} from "../inspector/physical-action-correlation-probe.js";
import type { BridgeDeviceStoreEvent, DeviceStore } from "../state/device-store.js";
import type { BridgeCameraImageEvent, CameraImageStore } from "../state/camera-image-store.js";
import { createHealthReport } from "./health.js";
import type { BridgeAuth } from "./bridge-auth.js";
import { renderStatusPage } from "./status-page.js";
import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface BridgeHttpServerOptions {
  store: RuntimeStatusStore;
  host: string;
  port: number;
  auth?: BridgeAuth;
  devices?: DeviceStore;
  commands?: Pick<SafeCommandService, "execute">;
  maintenance?: {
    reloadInventory(): Promise<void>;
    reconnectRealtime(): Promise<void>;
  };
  images?: Pick<CameraImageStore, "get"> & Partial<Pick<CameraImageStore, "subscribe">>;
  physicalActionProbe?: PhysicalActionCorrelationProbe;
  getProbeEvidence?: () => ProbeRuntimeEvidence;
}

export interface BridgeHttpServer {
  port: number;
  close: () => Promise<void>;
}

export async function createBridgeHttpServer(options: BridgeHttpServerOptions): Promise<BridgeHttpServer> {
  const server = createServer((request, response) => {
    const report = createHealthReport(options.store.getSnapshot());
    const path = request.url?.split("?")[0] ?? "/";

    if (path === "/health/live") {
      writeJson(response, report.live ? 200 : 503, { live: report.live, details: report.details });
      return;
    }
    if (path === "/health/ready") {
      writeJson(response, report.ready ? 200 : 503, { ready: report.ready, details: report.details });
      return;
    }
    if (path === "/health/details") {
      writeJson(response, 200, report);
      return;
    }
    if (path === "/" || path === "/index.html") {
      writeHeaders(response, 200, "text/html; charset=utf-8");
      response.end(renderStatusPage(report));
      return;
    }
    if (path.startsWith("/api/v1/")) {
      void handleBridgeApiRequest(request, response, options, path);
      return;
    }
    if (isProbePath(path)) {
      void handleProbeRequest(request, response, options, path);
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  await listen(server, options.port, options.host);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    port,
    close: () => close(server)
  };
}

async function handleBridgeApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: BridgeHttpServerOptions,
  path: string
): Promise<void> {
  try {
    const method = request.method ?? "GET";
    if (!options.auth || !options.devices) {
      return writeError(response, 503, "bridge_api_unavailable");
    }
    if (path === "/api/v1/pairing-code") {
      if (method !== "POST") return writeError(response, 405, "method_not_allowed");
      if (!isLoopback(request.socket.remoteAddress)) {
        return writeError(response, 403, "ingress_required");
      }
      return writeJson(response, 201, options.auth.createPairingCode());
    }
    if (path === "/api/v1/pair") {
      if (method !== "POST") return writeError(response, 405, "method_not_allowed");
      if (!isJsonContentType(request.headers["content-type"])) {
        return writeError(response, 415, "content_type_unsupported");
      }
      const body = await readJsonBody(request, 1_024);
      if (!body.ok || !isRecord(body.value) || typeof body.value.code !== "string") {
        return writeError(response, 400, "invalid_pairing_code");
      }
      const token = options.auth.exchangePairingCode(body.value.code);
      return token
        ? writeJson(response, 200, { token })
        : writeError(response, 401, "invalid_pairing_code");
    }
    if (!options.auth.authenticate(request.headers.authorization)) {
      return writeError(response, 401, "unauthorized");
    }
    if (path === "/api/v1/maintenance/reload-inventory") {
      if (method !== "POST") return writeError(response, 405, "method_not_allowed");
      if (!options.maintenance) return writeError(response, 503, "maintenance_unavailable");
      await options.maintenance.reloadInventory();
      return writeJson(response, 200, { accepted: true });
    }
    if (path === "/api/v1/maintenance/reconnect-realtime") {
      if (method !== "POST") return writeError(response, 405, "method_not_allowed");
      if (!options.maintenance) return writeError(response, 503, "maintenance_unavailable");
      await options.maintenance.reconnectRealtime();
      return writeJson(response, 200, { accepted: true });
    }
    const imageDeviceId = imageDeviceIdFromPath(path);
    if (imageDeviceId) {
      if (method !== "GET") return writeError(response, 405, "method_not_allowed");
      if (!options.images) return writeError(response, 503, "camera_image_unavailable");
      const image = options.images.get(imageDeviceId);
      if (!image) return writeError(response, 404, "camera_image_not_found");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": image.contentType,
        "content-length": String(image.body.length),
        "last-modified": new Date(image.capturedAt).toUTCString(),
        "x-content-type-options": "nosniff"
      });
      response.end(image.body);
      return;
    }
    if (path === "/api/v1/commands") {
      if (method !== "POST") return writeError(response, 405, "method_not_allowed");
      if (!options.commands) return writeError(response, 503, "command_api_unavailable");
      if (!isJsonContentType(request.headers["content-type"])) {
        return writeError(response, 415, "content_type_unsupported");
      }
      const body = await readJsonBody(request, 4_096);
      if (!body.ok) return writeError(response, body.status, body.error);
      return writeJson(response, 200, await options.commands.execute(body.value));
    }
    if (path === "/api/v1/commands/catalog") {
      if (method !== "GET") return writeError(response, 405, "method_not_allowed");
      const query = validateCatalogQuery(request.url);
      if (!query.ok) return writeError(response, 400, query.error);
      const device = options.devices.snapshot().devices.find((item) => item.id === query.deviceId);
      if (!device) return writeError(response, 404, "device_not_found");
      return writeJson(response, 200, {
        schemaVersion: 1,
        deviceId: device.id,
        commands: (device.advancedCommands ?? []).map(cloneCatalogCommand),
        omissions: summarizeCatalogOmissions(device.commandOmissions ?? [])
      });
    }
    if (path === "/api/v1/inventory") {
      if (method !== "GET") return writeError(response, 405, "method_not_allowed");
      const report = createHealthReport(options.store.getSnapshot());
      return writeJson(response, 200, {
        ...options.devices.snapshot(),
        ready: report.ready,
        bridgeVersion: report.details.bridgeVersion,
        protocolVersion: report.details.protocolVersion
      });
    }
    if (path === "/api/v1/events") {
      if (method !== "GET") return writeError(response, 405, "method_not_allowed");
      return openEventStream(request, response, options.devices, options.store, options.images);
    }
    writeError(response, 404, "not_found");
  } catch (error) {
    if (!response.headersSent && error instanceof SafeCommandError) {
      writeError(response, commandErrorStatus(error.code), error.code);
    } else if (!response.headersSent) writeError(response, 500, "internal_error");
    else response.destroy();
  }
}

function imageDeviceIdFromPath(path: string): string | undefined {
  const match = path.match(/^\/api\/v1\/images\/(dev_[0-9]{3,32})$/u);
  return match?.[1];
}

type CatalogQueryResult =
  | { ok: true; deviceId: string }
  | { ok: false; error: "missing_device_id" | "duplicate_query_param" | "unknown_query_param" | "invalid_device_id" };

function validateCatalogQuery(rawUrl: string | undefined): CatalogQueryResult {
  if (!rawUrl) return { ok: false, error: "missing_device_id" };
  const url = new URL(rawUrl, "http://bridge.local");
  for (const key of url.searchParams.keys()) {
    if (key !== "deviceId") return { ok: false, error: "unknown_query_param" };
  }
  const values = url.searchParams.getAll("deviceId");
  if (values.length === 0) return { ok: false, error: "missing_device_id" };
  if (values.length > 1) return { ok: false, error: "duplicate_query_param" };
  const deviceId = values[0];
  return typeof deviceId === "string" && /^dev_[A-Za-z0-9]{3,64}$/u.test(deviceId)
    ? { ok: true, deviceId }
    : { ok: false, error: "invalid_device_id" };
}

function cloneCatalogCommand(command: NonNullable<ReturnType<DeviceStore["snapshot"]>["devices"][number]["advancedCommands"]>[number]): unknown {
  return {
    ...command,
    arguments: command.arguments.map((argument) => ({
      ...argument,
      schema: JSON.parse(JSON.stringify(argument.schema)) as unknown
    }))
  };
}

function summarizeCatalogOmissions(
  omissions: NonNullable<ReturnType<DeviceStore["snapshot"]>["devices"][number]["commandOmissions"]>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const omission of omissions) {
    counts[omission.reason] = (counts[omission.reason] ?? 0) + 1;
  }
  return counts;
}

function commandErrorStatus(code: SafeCommandError["code"]): number {
  if (code === "command_confirmation_timeout") return 504;
  if (
    code === "bridge_not_connected" ||
    code === "command_queue_timeout" ||
    code === "command_browser_unavailable" ||
    code === "command_login_required"
  ) {
    return 503;
  }
  if (code === "device_not_found") return 404;
  if (code === "client_request_conflict" || code === "device_offline") return 409;
  if (
    code === "command_target_not_found" ||
    code === "command_location_mismatch" ||
    code === "command_location_unknown" ||
    code === "command_location_picker_not_found" ||
    code === "command_location_target_not_found" ||
    code === "command_location_change_failed" ||
    code === "command_room_not_found" ||
    code === "command_target_ambiguous" ||
    code === "command_search_not_found" ||
    code === "command_search_ambiguous" ||
    code === "command_control_not_found" ||
    code === "command_control_ambiguous" ||
    code === "component_command_partial_failure" ||
    code === "component_command_rollback_failed" ||
    code === "command_execution_failed"
  ) {
    return 502;
  }
  return 400;
}

type SseWritableResponse = Pick<
  ServerResponse,
  "destroyed" | "write" | "once" | "removeListener"
>;

export interface SseEventWriterOptions {
  inventoryCoalesceMs?: number;
  maxPendingEvents?: number;
}

const DEFAULT_SSE_INVENTORY_COALESCE_MS = 75;
const DEFAULT_SSE_MAX_PENDING_EVENTS = 128;

export class SseEventWriter {
  readonly #response: SseWritableResponse;
  readonly #currentSequence: () => number;
  readonly #inventoryCoalesceMs: number;
  readonly #maxPendingEvents: number;
  readonly #drainListener = () => this.#handleDrain();
  #blocked = false;
  #closed = false;
  #pendingChunks: string[] = [];
  #pendingInventory: (BridgeDeviceStoreEvent & { type: "inventory" }) | undefined;
  #inventoryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    response: SseWritableResponse,
    currentSequence: () => number,
    options: SseEventWriterOptions = {}
  ) {
    this.#response = response;
    this.#currentSequence = currentSequence;
    this.#inventoryCoalesceMs = Math.max(
      0,
      options.inventoryCoalesceMs ?? DEFAULT_SSE_INVENTORY_COALESCE_MS
    );
    this.#maxPendingEvents = Math.max(
      1,
      options.maxPendingEvents ?? DEFAULT_SSE_MAX_PENDING_EVENTS
    );
  }

  write(value: unknown, options: { immediateInventory?: boolean } = {}): void {
    if (this.#closed || this.#response.destroyed) return;
    const inventory = asInventoryEvent(value);
    if (inventory && options.immediateInventory !== true) {
      if (
        this.#pendingInventory === undefined ||
        inventory.sequence > this.#pendingInventory.sequence
      ) {
        this.#pendingInventory = inventory;
      }
      if (this.#inventoryCoalesceMs === 0) {
        this.#flushPendingInventory();
      } else if (this.#inventoryTimer === undefined) {
        this.#inventoryTimer = setTimeout(() => {
          this.#inventoryTimer = undefined;
          this.#flushPendingInventory();
        }, this.#inventoryCoalesceMs);
        this.#inventoryTimer.unref();
      }
      return;
    }
    this.#flushPendingInventory();
    this.#enqueue(formatSseData(value));
  }

  writeComment(comment: string): void {
    if (
      this.#closed ||
      this.#response.destroyed ||
      this.#blocked ||
      this.#pendingChunks.length > 0 ||
      this.#pendingInventory !== undefined
    ) {
      return;
    }
    this.#enqueue(`: ${comment}

`);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#inventoryTimer !== undefined) {
      clearTimeout(this.#inventoryTimer);
      this.#inventoryTimer = undefined;
    }
    this.#pendingInventory = undefined;
    this.#pendingChunks = [];
    this.#response.removeListener("drain", this.#drainListener);
  }

  #flushPendingInventory(): void {
    const inventory = this.#pendingInventory;
    if (inventory === undefined || this.#closed) return;
    if (this.#inventoryTimer !== undefined) {
      clearTimeout(this.#inventoryTimer);
      this.#inventoryTimer = undefined;
    }
    this.#pendingInventory = undefined;
    this.#enqueue(formatSseData(inventory));
  }

  #enqueue(chunk: string): void {
    if (this.#closed || this.#response.destroyed) return;
    if (this.#blocked) {
      if (this.#pendingChunks.length >= this.#maxPendingEvents) {
        this.#collapsePendingToInventory();
        return;
      }
      this.#pendingChunks.push(chunk);
      return;
    }
    if (!this.#response.write(chunk)) {
      this.#blocked = true;
      this.#armDrain();
    }
  }

  #handleDrain(): void {
    if (this.#closed || this.#response.destroyed) return;
    this.#blocked = false;
    while (!this.#blocked && this.#pendingChunks.length > 0) {
      const chunk = this.#pendingChunks.shift();
      if (chunk === undefined) break;
      if (!this.#response.write(chunk)) {
        this.#blocked = true;
        this.#armDrain();
      }
    }
  }

  #armDrain(): void {
    this.#response.once("drain", this.#drainListener);
  }

  #collapsePendingToInventory(): void {
    if (this.#inventoryTimer !== undefined) {
      clearTimeout(this.#inventoryTimer);
      this.#inventoryTimer = undefined;
    }
    this.#pendingInventory = undefined;
    this.#pendingChunks = [
      formatSseData({
        schemaVersion: 1,
        sequence: this.#currentSequence(),
        type: "inventory"
      })
    ];
  }
}

function asInventoryEvent(
  value: unknown
): (BridgeDeviceStoreEvent & { type: "inventory" }) | undefined {
  if (!isRecord(value)) return undefined;
  const sequence = value.sequence;
  if (
    value.schemaVersion !== 1 ||
    value.type !== "inventory" ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sequence: sequence as number,
    type: "inventory"
  };
}

function formatSseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}

`;
}

function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  devices: DeviceStore,
  store: RuntimeStatusStore,
  images?: Partial<Pick<CameraImageStore, "subscribe">>
): void {
  request.socket.setNoDelay(true);
  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff"
  });
  const writer = new SseEventWriter(response, () => devices.currentSequence());
  const activeConnections = store.getSnapshot().activeConnections;
  store.update({ activeConnections: activeConnections + 1 });
  writer.write(
    { schemaVersion: 1, sequence: devices.currentSequence(), type: "inventory" },
    { immediateInventory: true }
  );
  const unsubscribe = devices.subscribe((event) => writer.write(event));
  const unsubscribeImages = images?.subscribe
    ? images.subscribe((event: BridgeCameraImageEvent) => writer.write(event))
    : undefined;
  const keepalive = setInterval(() => writer.writeComment("keepalive"), 15_000);
  let closed = false;
  request.once("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
    unsubscribeImages?.();
    writer.close();
    const currentConnections = store.getSnapshot().activeConnections;
    store.update({ activeConnections: Math.max(0, currentConnections - 1) });
    response.end();
  });
}

function isLoopback(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  writeHeaders(response, status, "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function writeHeaders(response: ServerResponse, status: number, contentType: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff"
  });
}

async function handleProbeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: BridgeHttpServerOptions,
  path: string
): Promise<void> {
  try {
    const method = request.method ?? "GET";
    if (path === "/probe/physical-action" && method !== "GET") {
      writeError(response, 405, "method_not_allowed");
      return;
    }
    if (path === "/probe/physical-action/arm" && method !== "POST") {
      writeError(response, 405, "method_not_allowed");
      return;
    }
    if (path === "/probe/physical-action/reset" && method !== "POST") {
      writeError(response, 405, "method_not_allowed");
      return;
    }

    if (!options.physicalActionProbe || !options.getProbeEvidence) {
      writeError(response, 503, "probe_unavailable");
      return;
    }

    if (path === "/probe/physical-action") {
      writeJson(response, 200, options.physicalActionProbe.snapshot(options.getProbeEvidence()));
      return;
    }

    if (!isJsonContentType(request.headers["content-type"])) {
      writeError(response, 415, "content_type_unsupported");
      return;
    }

    const body = await readJsonBody(request, 4_096);
    if (!body.ok) {
      writeError(response, body.status, body.error);
      return;
    }

    if (path === "/probe/physical-action/reset") {
      const validation = validateResetBody(body.value);
      if (!validation.ok) {
        writeError(response, 400, validation.error);
        return;
      }
      writeJson(response, 200, options.physicalActionProbe.reset(options.getProbeEvidence()));
      return;
    }

    const validation = validateArmBody(body.value);
    if (!validation.ok) {
      writeError(response, 400, validation.error);
      return;
    }
    const result = options.physicalActionProbe.arm(validation.value, options.getProbeEvidence());
    if (!result.ok) {
      writeError(response, result.error === "not_ready" ? 503 : 409, result.error);
      return;
    }
    writeJson(response, 201, result.snapshot);
  } catch {
    if (!response.headersSent) {
      writeError(response, 500, "internal_error");
    } else {
      response.destroy();
    }
  }
}

function isProbePath(path: string): boolean {
  return (
    path === "/probe/physical-action" ||
    path === "/probe/physical-action/arm" ||
    path === "/probe/physical-action/reset"
  );
}

function writeError(response: ServerResponse, status: number, error: string): void {
  writeJson(response, status, { error });
}

type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: "invalid_body" | "invalid_json" | "body_too_large" };

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<ReadJsonBodyResult> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limitBytes) {
      request.resume();
      return { ok: false, status: 413, error: "body_too_large" };
    }
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      request.resume();
      return { ok: false, status: 413, error: "body_too_large" };
    }
    chunks.push(buffer);
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (text.trim().length === 0) {
      return { ok: false, status: 400, error: "invalid_body" };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "application/json") {
    return false;
  }
  return parts.slice(1).every((part) => part === "" || part === "charset=utf-8");
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function validateArmBody(value: unknown): ValidationResult<ProbeArmRequest> {
  if (!isRecord(value)) {
    return { ok: false, error: "invalid_body" };
  }

  const keys = Object.keys(value);
  if (keys.some((key) => !["actionType", "targetDeviceAlias", "windowSeconds"].includes(key))) {
    return { ok: false, error: "unknown_key" };
  }

  if (typeof value.actionType !== "string") {
    return { ok: false, error: "invalid_body" };
  }
  if (!isPhysicalActionType(value.actionType)) {
    return { ok: false, error: "unsupported_action" };
  }
  if (value.targetDeviceAlias !== undefined) {
    if (typeof value.targetDeviceAlias !== "string") {
      return { ok: false, error: "invalid_body" };
    }
    if (!/^dev_[0-9]{3,32}$/.test(value.targetDeviceAlias)) {
      return { ok: false, error: "unsafe_target_alias" };
    }
  }
  if (value.windowSeconds !== undefined) {
    if (
      typeof value.windowSeconds !== "number" ||
      !Number.isInteger(value.windowSeconds) ||
      value.windowSeconds < 15 ||
      value.windowSeconds > 120
    ) {
      return { ok: false, error: "window_out_of_range" };
    }
  }

  return {
    ok: true,
    value: {
      actionType: value.actionType,
      ...(value.targetDeviceAlias === undefined ? {} : { targetDeviceAlias: value.targetDeviceAlias }),
      ...(value.windowSeconds === undefined ? {} : { windowSeconds: value.windowSeconds })
    }
  };
}

function validateResetBody(value: unknown): ValidationResult<Record<string, never>> {
  if (!isRecord(value)) {
    return { ok: false, error: "invalid_body" };
  }
  if (Object.keys(value).length > 0) {
    return { ok: false, error: "unknown_key" };
  }
  return { ok: true, value: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhysicalActionType(value: string): value is ProbeArmRequest["actionType"] {
  return Object.prototype.hasOwnProperty.call(PHYSICAL_ACTION_PRESETS, value);
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

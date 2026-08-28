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
import type { DeviceStore } from "../state/device-store.js";
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

function commandErrorStatus(code: SafeCommandError["code"]): number {
  if (code === "command_confirmation_timeout") return 504;
  if (
    code === "bridge_not_connected" ||
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
    code === "command_execution_failed"
  ) {
    return 502;
  }
  return 400;
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
  const writeEvent = (value: unknown) => {
    if (!response.destroyed) response.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const activeConnections = store.getSnapshot().activeConnections;
  store.update({ activeConnections: activeConnections + 1 });
  writeEvent({ schemaVersion: 1, sequence: devices.currentSequence(), type: "inventory" });
  const unsubscribe = devices.subscribe(writeEvent);
  const unsubscribeImages = images?.subscribe
    ? images.subscribe((event: BridgeCameraImageEvent) => writeEvent(event))
    : undefined;
  const keepalive = setInterval(() => {
    if (!response.destroyed) response.write(": keepalive\n\n");
  }, 15_000);
  let closed = false;
  request.once("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
    unsubscribeImages?.();
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

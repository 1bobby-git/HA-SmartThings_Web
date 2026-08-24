import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  PHYSICAL_ACTION_PRESETS,
  type PhysicalActionCorrelationProbe,
  type ProbeArmRequest,
  type ProbeRuntimeEvidence
} from "../inspector/physical-action-correlation-probe.js";
import { createHealthReport } from "./health.js";
import { renderStatusPage } from "./status-page.js";
import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface BridgeHttpServerOptions {
  store: RuntimeStatusStore;
  host: string;
  port: number;
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

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return { ok: false, status: 400, error: "invalid_body" };
  }

  try {
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

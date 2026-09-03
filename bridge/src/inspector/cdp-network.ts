import { sanitizeCaptureRecord, type CaptureSource } from "../state/capture-store.js";
import {
  isSmartThingsSocketIoUrl,
  type CaptureSink,
  type Redact
} from "./browser-observer.js";
import { createHash } from "node:crypto";
import {
  DEFAULT_CAPTURE_TEXT_LIMIT_BYTES,
  normalizeTextForCapture
} from "./text-normalizer.js";

export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
}

export interface CdpNetworkOptions {
  responseBodyLimitBytes?: number;
  onSmartThingsAdvancedDeviceSnapshot?: (snapshot: unknown, url: string) => void;
  onRawSmartThingsAdvancedDeviceSnapshot?: (snapshot: unknown) => void;
  onRawWebSocketFrame?: (
    direction: "sent" | "received",
    payload: string,
    connectionId: string
  ) => void;
  onRawWebSocketBinaryFrame?: (
    direction: "sent" | "received",
    payload: ArrayBuffer | ArrayBufferView,
    connectionId: string
  ) => void;
  onSmartThingsWebSocketFrame?: (
    direction: "sent" | "received",
    url: string,
    connectionId: string
  ) => void;
  onSmartThingsWebSocketClose?: (url: string, connectionId: string) => void;
}

interface TrackedResponse {
  url: string;
  mimeType: string;
  type: string;
  method?: string;
}

const ADVANCED_DEVICE_SNAPSHOT_PARSE_LIMIT_BYTES = 16 * 1024 * 1024;
let nextCdpSessionId = 1;

export async function installCdpNetworkObserver(
  session: CdpSessionLike,
  sink: CaptureSink,
  redact: Redact,
  options: CdpNetworkOptions = {}
): Promise<void> {
  const limit = options.responseBodyLimitBytes ?? DEFAULT_CAPTURE_TEXT_LIMIT_BYTES;
  const tracked = new Map<string, TrackedResponse>();
  const requestMethods = new Map<string, string>();
  const trackedWebSockets = new Map<string, string>();
  const sessionScope = `cdp_session_${nextCdpSessionId++}`;
  await session.send("Network.enable");

  session.on("Network.requestWillBeSent", (payload) => {
    const requestId = readString(payload, "requestId");
    const request = readObject(payload, "request");
    const method = request ? readString(request, "method") : undefined;
    if (requestId && method) requestMethods.set(requestId, method);
  });
  session.on("Network.webSocketCreated", (payload) => {
    const requestId = readString(payload, "requestId");
    const url = readString(payload, "url");
    if (requestId && url) trackedWebSockets.set(requestId, url);
  });
  session.on("Network.webSocketClosed", (payload) => {
    const requestId = readString(payload, "requestId");
    if (!requestId) return;
    const url = trackedWebSockets.get(requestId);
    trackedWebSockets.delete(requestId);
    if (!url || !isSmartThingsSocketIoUrl(url) || !options.onSmartThingsWebSocketClose) return;
    try {
      options.onSmartThingsWebSocketClose(url, `${sessionScope}:${requestId}`);
    } catch {
      // Recovery diagnostics must never interrupt the sanitized capture pipeline.
    }
  });

  session.on("Network.webSocketFrameSent", (payload) => {
    observeRawTextFrame(options.onRawWebSocketFrame, "sent", payload, sessionScope);
    observeRawBinaryFrame(options.onRawWebSocketBinaryFrame, "sent", payload, sessionScope);
    observeSmartThingsWebSocketFrame(
      options.onSmartThingsWebSocketFrame,
      "sent",
      payload,
      trackedWebSockets,
      sessionScope
    );
    write(sink, redact, "cdp-websocket-frame", {
      direction: "sent",
      ...connectionMetadata(payload, sessionScope),
      payload: normalizeFrame(payload, limit, redact)
    });
  });
  session.on("Network.webSocketFrameReceived", (payload) => {
    observeRawTextFrame(options.onRawWebSocketFrame, "received", payload, sessionScope);
    observeRawBinaryFrame(options.onRawWebSocketBinaryFrame, "received", payload, sessionScope);
    observeSmartThingsWebSocketFrame(
      options.onSmartThingsWebSocketFrame,
      "received",
      payload,
      trackedWebSockets,
      sessionScope
    );
    write(sink, redact, "cdp-websocket-frame", {
      direction: "received",
      ...connectionMetadata(payload, sessionScope),
      payload: normalizeFrame(payload, limit, redact)
    });
  });
  session.on("Network.eventSourceMessageReceived", (payload) =>
    write(sink, redact, "cdp-eventsource", normalizeEventSource(payload, limit, redact))
  );
  session.on("Network.responseReceived", (payload) => {
    const requestId = readString(payload, "requestId");
    const response = readObject(payload, "response");
    const type = readString(payload, "type") ?? "unknown";
    if (!requestId || !response || !["XHR", "Fetch"].includes(type)) {
      return;
    }
    const method = requestMethods.get(requestId);
    tracked.set(requestId, {
      url: readString(response, "url") ?? "",
      mimeType: readString(response, "mimeType") ?? "",
      type,
      ...(method ? { method } : {})
    });
  });
  session.on("Network.loadingFailed", (payload) => {
    const requestId = readString(payload, "requestId");
    if (!requestId) return;
    tracked.delete(requestId);
    requestMethods.delete(requestId);
  });
  session.on("Network.loadingFinished", async (payload) => {
    const requestId = readString(payload, "requestId");
    if (requestId) {
      requestMethods.delete(requestId);
    }
    if (!requestId || !tracked.has(requestId)) {
      return;
    }
    const response = tracked.get(requestId);
    tracked.delete(requestId);
    try {
      const body = (await session.send("Network.getResponseBody", { requestId })) as
        | { body?: string; base64Encoded?: boolean }
        | undefined;
      observeAdvancedDeviceSnapshot(
        response,
        body,
        redact,
        options.onSmartThingsAdvancedDeviceSnapshot,
        options.onRawSmartThingsAdvancedDeviceSnapshot
      );
      write(sink, redact, "cdp-response-body", normalizeBody(response, requestId, body, limit, redact));
    } catch {
      write(sink, redact, "cdp-response-body", {
        ...response,
        requestId,
        bodyUnavailable: true,
        error: "response body unavailable"
      });
    }
  });
}

function observeSmartThingsWebSocketFrame(
  observer: CdpNetworkOptions["onSmartThingsWebSocketFrame"],
  direction: "sent" | "received",
  payload: unknown,
  trackedWebSockets: Map<string, string>,
  sessionScope: string
): void {
  if (!observer) return;
  const requestId = readString(payload, "requestId");
  const url = requestId ? trackedWebSockets.get(requestId) : undefined;
  if (!requestId || !url || !isSmartThingsSocketIoUrl(url)) return;
  try {
    observer(direction, url, `${sessionScope}:${requestId}`);
  } catch {
    // Liveness diagnostics must never interrupt the sanitized capture pipeline.
  }
}

function observeAdvancedDeviceSnapshot(
  response: TrackedResponse | undefined,
  body: { body?: string; base64Encoded?: boolean } | undefined,
  redact: Redact,
  observer: CdpNetworkOptions["onSmartThingsAdvancedDeviceSnapshot"],
  rawObserver: CdpNetworkOptions["onRawSmartThingsAdvancedDeviceSnapshot"]
): void {
  if (
    (!observer && !rawObserver) ||
    body?.base64Encoded === true ||
    typeof body?.body !== "string" ||
    response?.method !== "GET" ||
    !isAdvancedDeviceSnapshotUrl(response?.url) ||
    Buffer.byteLength(body.body, "utf8") > ADVANCED_DEVICE_SNAPSHOT_PARSE_LIMIT_BYTES
  ) {
    return;
  }
  try {
    const parsed = JSON.parse(body.body) as unknown;
    try {
      rawObserver?.(parsed);
    } catch {
      // Raw identifiers are optional, in-memory acceleration hints only.
    }
    observer?.(redact(parsed), response?.url ?? "");
  } catch {
    // Advanced metadata is opportunistic enrichment; malformed JSON must not interrupt capture.
  }
}

function isAdvancedDeviceSnapshotUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://my.smartthings.com" &&
      url.pathname === "/advanced/cupcake-api/api/devices"
    );
  } catch {
    return false;
  }
}

function observeRawBinaryFrame(
  observer: CdpNetworkOptions["onRawWebSocketBinaryFrame"],
  direction: "sent" | "received",
  payload: unknown,
  sessionScope: string
): void {
  if (!observer) return;
  const requestId = readString(payload, "requestId");
  const response = readObject(payload, "response");
  const payloadData = response ? readString(response, "payloadData") : undefined;
  const opcode = response ? readNumber(response, "opcode") : undefined;
  if (!requestId || opcode === 1 || typeof payloadData !== "string") return;
  try {
    observer(direction, Buffer.from(payloadData, "base64"), `${sessionScope}:${requestId}`);
  } catch {
    // Image extraction must never interrupt the sanitized capture pipeline.
  }
}

function write(sink: CaptureSink, redact: Redact, source: CaptureSource, payload: unknown): void {
  sink.write(sanitizeCaptureRecord(source, payload, redact));
}

function connectionMetadata(payload: unknown, sessionScope: string): { connectionId?: string } {
  const requestId = readString(payload, "requestId");
  return requestId ? { connectionId: `${sessionScope}:${requestId}` } : {};
}

function observeRawTextFrame(
  observer: CdpNetworkOptions["onRawWebSocketFrame"],
  direction: "sent" | "received",
  payload: unknown,
  sessionScope: string
): void {
  if (!observer) return;
  const requestId = readString(payload, "requestId");
  const response = readObject(payload, "response");
  const payloadData = response ? readString(response, "payloadData") : undefined;
  const opcode = response ? readNumber(response, "opcode") : undefined;
  if (!requestId || opcode !== 1 || typeof payloadData !== "string") return;
  try {
    observer(direction, payloadData, `${sessionScope}:${requestId}`);
  } catch {
    // Image extraction must never interrupt the sanitized capture pipeline.
  }
}

function normalizeFrame(payload: unknown, limitBytes: number, redact: Redact): unknown {
  const response = readObject(payload, "response");
  const payloadData = response ? readString(response, "payloadData") : undefined;
  const opcode = response ? readNumber(response, "opcode") : undefined;
  if (opcode !== undefined && opcode !== 1) {
    const bytes = Buffer.from(payloadData ?? "", "base64");
    return {
      opcode,
      binary: true,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }
  if (opcode === 1 && payloadData !== undefined && response) {
    return {
      ...(typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}),
      response: {
        ...response,
        ...boundedText("payloadData", payloadData, limitBytes, redact)
      }
    };
  }
  return payload;
}

function normalizeEventSource(payload: unknown, limitBytes: number, redact: Redact): unknown {
  const data = readString(payload, "data");
  if (data === undefined || typeof payload !== "object" || payload === null) {
    return payload;
  }
  return {
    ...(payload as Record<string, unknown>),
    ...boundedText("data", data, limitBytes, redact)
  };
}

function normalizeBody(
  response: TrackedResponse | undefined,
  requestId: string,
  body: { body?: string; base64Encoded?: boolean } | undefined,
  limitBytes: number,
  redact: Redact
): Record<string, unknown> {
  const text = body?.body ?? "";
  if (body?.base64Encoded === true) {
    const bytes = Buffer.from(text, "base64");
    return {
      ...response,
      requestId,
      body: {
        binary: true,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }
    };
  }
  return {
    ...response,
    requestId,
    ...boundedText("body", text, limitBytes, redact)
  };
}

function boundedText(
  key: "body" | "data" | "payloadData",
  value: string,
  limitBytes: number,
  redact: Redact
): Record<"byteLength" | "truncated", number | boolean> & Record<typeof key, string> {
  const normalized = normalizeTextForCapture(value, limitBytes, redact);
  return { [key]: normalized.value, byteLength: normalized.byteLength, truncated: normalized.truncated } as Record<
    "byteLength" | "truncated",
    number | boolean
  > &
    Record<typeof key, string>;
}

function readObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "number" ? nested : undefined;
}

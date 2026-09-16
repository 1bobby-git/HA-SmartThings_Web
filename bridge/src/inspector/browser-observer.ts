import { sanitizeCaptureRecord, type CaptureStore, type CaptureSource } from "../state/capture-store.js";
import { createHash } from "node:crypto";
import {
  DEFAULT_CAPTURE_TEXT_LIMIT_BYTES,
  normalizeTextForCapture
} from "./text-normalizer.js";

export interface EventTargetLike {
  on(event: string, handler: (payload: unknown) => void): void;
  serviceWorkers?(): unknown[];
}

export interface CaptureSink {
  write(record: Parameters<CaptureStore["write"]>[0]): void;
}

export type Redact = (value: unknown) => unknown;

export interface BrowserObserverOptions {
  textLimitBytes?: number;
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
    connectionId: string,
    page?: object
  ) => void;
  onSmartThingsWebSocketClose?: (url: string, connectionId: string, page?: object) => void;
}

export function installBrowserObserver(
  context: EventTargetLike,
  sink: CaptureSink,
  redact: Redact,
  options: BrowserObserverOptions = {}
): void {
  const textLimitBytes = options.textLimitBytes ?? DEFAULT_CAPTURE_TEXT_LIMIT_BYTES;
  const observedPages = new WeakSet<object>();
  const observedServiceWorkers = new WeakSet<object>();
  const observedSockets = new WeakMap<object, { page?: object }>();
  let nextWebsocketConnectionId = 1;

  context.on("request", (request) => {
    write(sink, redact, "playwright-request", {
      url: callString(request, "url"),
      method: callString(request, "method"),
      resourceType: callString(request, "resourceType"),
      headers: callObject(request, "headers")
    });
  });

  context.on("response", (response) => {
    write(sink, redact, "playwright-response", {
      url: callString(response, "url"),
      status: callNumber(response, "status"),
      headers: callObject(response, "headers")
    });
  });

  const attachSocket = (socket: unknown, page?: object): void => {
    if (typeof socket !== "object" || socket === null) return;
    const existing = observedSockets.get(socket);
    if (existing) {
      if (page) existing.page = page;
      return;
    }
    const owner = page ? { page } : {} as { page?: object };
    observedSockets.set(socket, owner);
    const connectionId = `pw_ws_${nextWebsocketConnectionId++}`;
    const socketUrl = callString(socket, "url");
    write(sink, redact, "playwright-websocket", { url: socketUrl, connectionId });
    if (hasOn(socket)) {
      socket.on("framesent", (frame) => {
        observeRawTextFrame(options.onRawWebSocketFrame, "sent", frame, connectionId);
        observeRawBinaryFrame(options.onRawWebSocketBinaryFrame, "sent", frame, connectionId);
        // Sending does not prove that the server subscription is receiving data.
        write(sink, redact, "playwright-websocket-frame", {
          direction: "sent",
          connectionId,
          frame: normalizePlaywrightFrame(frame, textLimitBytes, redact)
        });
      });
      socket.on("framereceived", (frame) => {
        observeRawTextFrame(options.onRawWebSocketFrame, "received", frame, connectionId);
        observeRawBinaryFrame(options.onRawWebSocketBinaryFrame, "received", frame, connectionId);
        write(sink, redact, "playwright-websocket-frame", {
          direction: "received",
          connectionId,
          frame: normalizePlaywrightFrame(frame, textLimitBytes, redact)
        });
        // Only metadata reaches liveness observers, after the sanitized capture.
        observeSmartThingsWebSocketFrame(
          options.onSmartThingsWebSocketFrame,
          "received",
          socketUrl,
          connectionId,
          owner.page
        );
      });
      socket.on("close", () => {
        const url = callString(socket, "url");
        observeSmartThingsWebSocketClose(
          options.onSmartThingsWebSocketClose,
          url,
          connectionId,
          owner.page
        );
        write(sink, redact, "playwright-websocket", {
          url: callString(socket, "url"),
          connectionId,
          event: "close"
        });
      });
    }
  };
  // Playwright emits websocket on Page, not BrowserContext. Keep context adapters
  // supported, but deduplicate a socket delivered through both observation paths.
  context.on("websocket", (socket) => attachSocket(socket));

  for (const worker of callArray(context, "serviceWorkers")) {
    attachServiceWorker(worker, sink, redact, observedServiceWorkers);
  }

  context.on("serviceworker", (worker) => attachServiceWorker(worker, sink, redact, observedServiceWorkers));

  for (const page of callArray(context, "pages")) {
    attachPage(page, sink, redact, observedPages, attachSocket);
  }

  context.on("page", (page) => attachPage(page, sink, redact, observedPages, attachSocket));
}

function observeSmartThingsWebSocketFrame(
  observer: BrowserObserverOptions["onSmartThingsWebSocketFrame"],
  direction: "sent" | "received",
  url: string | undefined,
  connectionId: string,
  page?: object
): void {
  if (!observer || !isSmartThingsSocketIoUrl(url)) return;
  try {
    if (page) observer(direction, url, connectionId, page);
    else observer(direction, url, connectionId);
  } catch {
    // Liveness diagnostics must never interrupt the sanitized capture pipeline.
  }
}

function observeRawBinaryFrame(
  observer: BrowserObserverOptions["onRawWebSocketBinaryFrame"],
  direction: "sent" | "received",
  frame: unknown,
  connectionId: string
): void {
  if (!observer) return;
  const payload =
    isBinary(frame)
      ? frame
      : typeof frame === "object" && frame !== null
        ? (frame as Record<string, unknown>).payload
        : undefined;
  if (!isBinary(payload)) return;
  try {
    observer(direction, payload, connectionId);
  } catch {
    // Image extraction must never interrupt the sanitized capture pipeline.
  }
}

export function isSmartThingsSocketIoUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    const service = url.pathname.split("/").find((segment) => segment.length > 0);
    return (
      (url.protocol === "wss:" || url.protocol === "ws:") &&
      url.hostname === "my.smartthings.com" &&
      service === ["socket", "io"].join(".")
    );
  } catch {
    return false;
  }
}

function observeSmartThingsWebSocketClose(
  observer: BrowserObserverOptions["onSmartThingsWebSocketClose"],
  url: string | undefined,
  connectionId: string,
  page?: object
): void {
  if (!observer || !isSmartThingsSocketIoUrl(url)) return;
  try {
    if (page) observer(url, connectionId, page);
    else observer(url, connectionId);
  } catch {
    // Recovery diagnostics must never interrupt the sanitized capture pipeline.
  }
}

function observeRawTextFrame(
  observer: BrowserObserverOptions["onRawWebSocketFrame"],
  direction: "sent" | "received",
  frame: unknown,
  connectionId: string
): void {
  if (!observer) return;
  const payload =
    typeof frame === "string"
      ? frame
      : typeof frame === "object" && frame !== null
        ? (frame as Record<string, unknown>).payload
        : undefined;
  if (typeof payload !== "string") return;
  try {
    observer(direction, payload, connectionId);
  } catch {
    // Image extraction must never interrupt the sanitized capture pipeline.
  }
}

function write(sink: CaptureSink, redact: Redact, source: CaptureSource, payload: unknown): void {
  sink.write(sanitizeCaptureRecord(source, payload, redact));
}

function attachPage(page: unknown, sink: CaptureSink, redact: Redact, observedPages: WeakSet<object>,
  attachSocket: (socket: unknown, page?: object) => void): void {
  if (!hasOn(page) || observedPages.has(page)) {
    return;
  }
  observedPages.add(page);
  page.on("websocket", (socket) => attachSocket(socket, page));
  page.on("console", (message) =>
    write(sink, redact, "page-console", { type: callString(message, "type"), text: callString(message, "text") })
  );
  page.on("crash", () => write(sink, redact, "page-lifecycle", { event: "crash" }));
}

function attachServiceWorker(
  worker: unknown,
  sink: CaptureSink,
  redact: Redact,
  observedServiceWorkers: WeakSet<object>
): void {
  if (typeof worker !== "object" || worker === null || observedServiceWorkers.has(worker)) {
    return;
  }
  observedServiceWorkers.add(worker);
  const url = callString(worker, "url");
  write(sink, redact, "playwright-service-worker", { url, event: "created" });
  if (hasOn(worker)) {
    worker.on("close", () => write(sink, redact, "playwright-service-worker", { url, event: "close" }));
  }
}

function normalizePlaywrightFrame(frame: unknown, limitBytes: number, redact: Redact): unknown {
  if (isBinary(frame)) {
    return binaryMetadata(frame);
  }
  if (typeof frame === "string") {
    return boundedText(frame, limitBytes, redact);
  }
  if (typeof frame !== "object" || frame === null) {
    return frame;
  }
  const payload = (frame as Record<string, unknown>)["payload"];
  if (isBinary(payload)) {
    const rest = { ...(frame as Record<string, unknown>) };
    delete rest.payload;
    return { ...rest, ...binaryMetadata(payload) };
  }
  if (typeof payload === "string") {
    return { ...frame, ...boundedText(payload, limitBytes, redact) };
  }
  return frame;
}

function binaryMetadata(value: ArrayBuffer | ArrayBufferView): { binary: true; byteLength: number; sha256: string } {
  const bytes = toBuffer(value);
  return {
    binary: true,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function toBuffer(value: ArrayBuffer | ArrayBufferView): Buffer {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function boundedText(
  value: string,
  limitBytes: number,
  redact: Redact
): { payload: string; byteLength: number; truncated: boolean } {
  const normalized = normalizeTextForCapture(value, limitBytes, redact);
  return { payload: normalized.value, byteLength: normalized.byteLength, truncated: normalized.truncated };
}

function hasOn(value: unknown): value is EventTargetLike {
  return typeof value === "object" && value !== null && typeof (value as EventTargetLike).on === "function";
}

function callString(value: unknown, method: string): string | undefined {
  const result = call(value, method);
  return typeof result === "string" ? result : undefined;
}

function callNumber(value: unknown, method: string): number | undefined {
  const result = call(value, method);
  return typeof result === "number" ? result : undefined;
}

function callObject(value: unknown, method: string): unknown {
  return call(value, method);
}

function callArray(value: unknown, method: string): unknown[] {
  const result = call(value, method);
  return Array.isArray(result) ? result : [];
}

function call(value: unknown, method: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fn = (value as Record<string, unknown>)[method];
  return typeof fn === "function" ? fn.call(value) : undefined;
}

import { sanitizeCaptureRecord, type CaptureSource } from "../state/capture-store.js";
import type { CaptureSink, Redact } from "./browser-observer.js";

export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
}

export interface CdpNetworkOptions {
  responseBodyLimitBytes?: number;
}

interface TrackedResponse {
  url: string;
  mimeType: string;
  type: string;
}

export async function installCdpNetworkObserver(
  session: CdpSessionLike,
  sink: CaptureSink,
  redact: Redact,
  options: CdpNetworkOptions = {}
): Promise<void> {
  const limit = options.responseBodyLimitBytes ?? 64_000;
  const tracked = new Map<string, TrackedResponse>();
  await session.send("Network.enable");

  session.on("Network.webSocketFrameSent", (payload) =>
    write(sink, redact, "cdp-websocket-frame", { direction: "sent", payload: normalizeFrame(payload) })
  );
  session.on("Network.webSocketFrameReceived", (payload) =>
    write(sink, redact, "cdp-websocket-frame", { direction: "received", payload: normalizeFrame(payload) })
  );
  session.on("Network.eventSourceMessageReceived", (payload) =>
    write(sink, redact, "cdp-eventsource", payload)
  );
  session.on("Network.responseReceived", (payload) => {
    const requestId = readString(payload, "requestId");
    const response = readObject(payload, "response");
    const type = readString(payload, "type") ?? "unknown";
    if (!requestId || !response || !["XHR", "Fetch"].includes(type)) {
      return;
    }
    tracked.set(requestId, {
      url: readString(response, "url") ?? "",
      mimeType: readString(response, "mimeType") ?? "",
      type
    });
  });
  session.on("Network.loadingFinished", async (payload) => {
    const requestId = readString(payload, "requestId");
    if (!requestId || !tracked.has(requestId)) {
      return;
    }
    const response = tracked.get(requestId);
    tracked.delete(requestId);
    const body = (await session.send("Network.getResponseBody", { requestId })) as
      | { body?: string; base64Encoded?: boolean }
      | undefined;
    const text = body?.base64Encoded ? `[base64:${body.body?.length ?? 0}]` : (body?.body ?? "");
    write(sink, redact, "cdp-response-body", {
      ...response,
      requestId,
      body: text.slice(0, limit),
      truncated: text.length > limit
    });
  });
}

function write(sink: CaptureSink, redact: Redact, source: CaptureSource, payload: unknown): void {
  sink.write(sanitizeCaptureRecord(source, payload, redact));
}

function normalizeFrame(payload: unknown): unknown {
  const response = readObject(payload, "response");
  const payloadData = response ? readString(response, "payloadData") : undefined;
  const opcode = response ? readNumber(response, "opcode") : undefined;
  if (opcode !== undefined && opcode !== 1) {
    return { opcode, byteLength: payloadData?.length ?? 0 };
  }
  return payload;
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

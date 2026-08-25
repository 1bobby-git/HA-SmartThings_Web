import { sanitizeCaptureRecord, type CaptureSource } from "../state/capture-store.js";
import type { CaptureSink, Redact } from "./browser-observer.js";
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
  const limit = options.responseBodyLimitBytes ?? DEFAULT_CAPTURE_TEXT_LIMIT_BYTES;
  const tracked = new Map<string, TrackedResponse>();
  await session.send("Network.enable");

  session.on("Network.webSocketFrameSent", (payload) =>
    write(sink, redact, "cdp-websocket-frame", {
      direction: "sent",
      ...connectionMetadata(payload),
      payload: normalizeFrame(payload, limit, redact)
    })
  );
  session.on("Network.webSocketFrameReceived", (payload) =>
    write(sink, redact, "cdp-websocket-frame", {
      direction: "received",
      ...connectionMetadata(payload),
      payload: normalizeFrame(payload, limit, redact)
    })
  );
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
    try {
      const body = (await session.send("Network.getResponseBody", { requestId })) as
        | { body?: string; base64Encoded?: boolean }
        | undefined;
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

function write(sink: CaptureSink, redact: Redact, source: CaptureSource, payload: unknown): void {
  sink.write(sanitizeCaptureRecord(source, payload, redact));
}

function connectionMetadata(payload: unknown): { connectionId?: string } {
  const requestId = readString(payload, "requestId");
  return requestId ? { connectionId: requestId } : {};
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

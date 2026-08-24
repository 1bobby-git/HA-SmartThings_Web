import { DEFAULT_CAPTURE_TEXT_LIMIT_BYTES } from "./text-normalizer.js";

export interface SocketIoDecodeOptions {
  maxBytes?: number;
}

export type SocketIoInvalidReason =
  | "empty_frame"
  | "frame_too_large"
  | "unknown_engine_packet"
  | "unknown_socket_packet"
  | "invalid_json"
  | "invalid_event";

export type DecodedSocketIoFrame =
  | { kind: "engine_open"; data: unknown }
  | { kind: "engine_close" }
  | { kind: "ping"; data?: string }
  | { kind: "pong"; data?: string }
  | { kind: "socket_connect"; data: unknown }
  | { kind: "socket_disconnect" }
  | { kind: "event"; eventName: string; args: unknown[]; ackId?: number }
  | { kind: "ack"; ackId?: number; args: unknown[] }
  | { kind: "invalid"; reason: SocketIoInvalidReason; byteLength: number };

export function decodeSocketIoTextFrame(
  raw: string,
  options: SocketIoDecodeOptions = {}
): DecodedSocketIoFrame {
  const byteLength = Buffer.byteLength(raw, "utf8");
  const maxBytes = options.maxBytes ?? DEFAULT_CAPTURE_TEXT_LIMIT_BYTES;
  if (byteLength === 0) {
    return invalid("empty_frame", byteLength);
  }
  if (byteLength > maxBytes) {
    return invalid("frame_too_large", byteLength);
  }

  const engineType = raw[0];
  if (engineType === "0") {
    return decodeJsonPayload("engine_open", raw.slice(1), byteLength);
  }
  if (engineType === "1") {
    return { kind: "engine_close" };
  }
  if (engineType === "2") {
    return raw.length > 1 ? { kind: "ping", data: raw.slice(1) } : { kind: "ping" };
  }
  if (engineType === "3") {
    return raw.length > 1 ? { kind: "pong", data: raw.slice(1) } : { kind: "pong" };
  }
  if (engineType !== "4") {
    return invalid("unknown_engine_packet", byteLength);
  }

  return decodeSocketPacket(raw.slice(1), byteLength);
}

function decodeSocketPacket(payload: string, byteLength: number): DecodedSocketIoFrame {
  const socketType = payload[0];
  if (socketType === "0") {
    return decodeJsonPayload("socket_connect", payload.slice(1), byteLength, {});
  }
  if (socketType === "1") {
    return { kind: "socket_disconnect" };
  }
  if (socketType !== "2" && socketType !== "3") {
    return invalid("unknown_socket_packet", byteLength);
  }

  const dataStart = findJsonStart(payload, 1);
  if (dataStart < 0) {
    return invalid("invalid_json", byteLength);
  }
  const ackText = payload.slice(1, dataStart);
  const ackId = /^\d+$/.test(ackText) ? Number(ackText) : undefined;
  const decoded = parseJson(payload.slice(dataStart));
  if (!Array.isArray(decoded)) {
    return invalid("invalid_json", byteLength);
  }
  if (socketType === "3") {
    return ackId === undefined
      ? { kind: "ack", args: decoded }
      : { kind: "ack", ackId, args: decoded };
  }
  const [eventName, ...args] = decoded;
  if (typeof eventName !== "string" || eventName.length === 0) {
    return invalid("invalid_event", byteLength);
  }
  return ackId === undefined
    ? { kind: "event", eventName, args }
    : { kind: "event", eventName, ackId, args };
}

function decodeJsonPayload(
  kind: "engine_open" | "socket_connect",
  payload: string,
  byteLength: number,
  emptyValue?: unknown
): DecodedSocketIoFrame {
  if (payload.length === 0 && emptyValue !== undefined) {
    return { kind, data: emptyValue };
  }
  const data = parseJson(payload);
  return data === undefined ? invalid("invalid_json", byteLength) : { kind, data };
}

function findJsonStart(value: string, from: number): number {
  const arrayStart = value.indexOf("[", from);
  const objectStart = value.indexOf("{", from);
  if (arrayStart < 0) {
    return objectStart;
  }
  if (objectStart < 0) {
    return arrayStart;
  }
  return Math.min(arrayStart, objectStart);
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function invalid(reason: SocketIoInvalidReason, byteLength: number): DecodedSocketIoFrame {
  return { kind: "invalid", reason, byteLength };
}

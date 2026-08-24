import type { SanitizedCaptureRecord } from "../state/capture-store.js";
import {
  createEventPayloadHash,
  EventDeduplicator,
  extractDeviceEventIdentity,
  type EventDeduplicatorOptions
} from "./event-deduplicator.js";
import { decodeSocketIoTextFrame } from "./socketio-decoder.js";
import {
  PROTOCOL_CONTRACT_FINGERPRINT,
  REQUIRED_PROTOCOL_SURFACES,
  type ProtocolMismatchSurface,
  type SafeProtocolSurface,
  snapshotProtocolSurface
} from "./protocol-contract.js";
import {
  SnapshotDetector,
  type SnapshotCategory
} from "./snapshot-detector.js";

export interface ProtocolAnalyzerSnapshot {
  decodedDeviceEvents: number;
  uniqueLogicalEvents: number;
  duplicateDeliveries: number;
  invalidFrames: number;
  journalSize: number;
  snapshotComplete: boolean;
  snapshotCategories: Partial<Record<SnapshotCategory, number>>;
  pendingSnapshotRequests: number;
  protocolComplete: boolean;
  protocolFingerprint?: string;
  protocolMismatchCount: number;
  protocolMismatchSurface?: ProtocolMismatchSurface;
}

export type ProtocolAnalysisResult =
  | { kind: "new" | "duplicate"; key: string; occurrence: number }
  | { kind: "snapshot"; requestEvent: string; category: SnapshotCategory; count: number }
  | { kind: "protocol_changed"; surface: ProtocolMismatchSurface };

export class ProtocolAnalyzer {
  readonly #dedupe: EventDeduplicator;
  readonly #snapshotDetector = new SnapshotDetector();
  #decodedDeviceEvents = 0;
  #uniqueLogicalEvents = 0;
  #duplicateDeliveries = 0;
  #invalidFrames = 0;
  readonly #observedSurfaces = new Set<SafeProtocolSurface>();
  readonly #mismatchedSurfaces = new Set<ProtocolMismatchSurface>();
  #lastMismatchSurface: ProtocolMismatchSurface | undefined;

  constructor(options: EventDeduplicatorOptions) {
    this.#dedupe = new EventDeduplicator(options);
  }

  observe(record: SanitizedCaptureRecord): ProtocolAnalysisResult | null {
    const frame = extractTextFrame(record);
    if (frame === null) {
      return null;
    }
    if (frame.direction === "sent") {
      this.#snapshotDetector.observeSentFrame(frame.text);
      return null;
    }
    const snapshot = this.#snapshotDetector.observeReceivedFrame(frame.text);
    if (snapshot) {
      if (snapshot.kind === "protocol_changed") {
        this.#recordMismatch(snapshot.surface);
        return snapshot;
      }
      this.#observedSurfaces.add(snapshotProtocolSurface(snapshot.category));
      return snapshot;
    }
    const decoded = decodeSocketIoTextFrame(frame.text);
    if (decoded.kind === "invalid") {
      this.#invalidFrames += 1;
      return null;
    }
    if (decoded.kind !== "event" || decoded.eventName !== "api/subscription DEVICE_EVENT") {
      return null;
    }
    const identity = extractDeviceEventIdentity(decoded.args[0]);
    if (!identity) {
      this.#invalidFrames += 1;
      const surface = "event:device_event:identity";
      this.#recordMismatch(surface);
      return { kind: "protocol_changed", surface };
    }
    this.#observedSurfaces.add("event:device_event:v1");
    this.#decodedDeviceEvents += 1;
    const result = this.#dedupe.observe({
      ...identity,
      payloadHash: identity.payloadHash ?? createEventPayloadHash(decoded.args[0])
    });
    if (result.duplicate) {
      this.#duplicateDeliveries += 1;
    } else {
      this.#uniqueLogicalEvents += 1;
    }
    return {
      kind: result.duplicate ? "duplicate" : "new",
      key: result.key,
      occurrence: result.occurrence
    };
  }

  snapshot(): ProtocolAnalyzerSnapshot {
    const snapshot = this.#snapshotDetector.snapshot();
    const protocolComplete = REQUIRED_PROTOCOL_SURFACES.every((surface) =>
      this.#observedSurfaces.has(surface)
    );
    return {
      decodedDeviceEvents: this.#decodedDeviceEvents,
      uniqueLogicalEvents: this.#uniqueLogicalEvents,
      duplicateDeliveries: this.#duplicateDeliveries,
      invalidFrames: this.#invalidFrames,
      journalSize: this.#dedupe.size,
      snapshotComplete: snapshot.complete,
      snapshotCategories: snapshot.categories,
      pendingSnapshotRequests: snapshot.pendingRequests,
      protocolComplete,
      ...(protocolComplete ? { protocolFingerprint: PROTOCOL_CONTRACT_FINGERPRINT } : {}),
      protocolMismatchCount: this.#mismatchedSurfaces.size,
      ...(this.#lastMismatchSurface ? { protocolMismatchSurface: this.#lastMismatchSurface } : {})
    };
  }

  reset(): void {
    this.#dedupe.reset();
    this.#snapshotDetector.reset();
    this.#decodedDeviceEvents = 0;
    this.#uniqueLogicalEvents = 0;
    this.#duplicateDeliveries = 0;
    this.#invalidFrames = 0;
    this.#observedSurfaces.clear();
    this.#mismatchedSurfaces.clear();
    this.#lastMismatchSurface = undefined;
  }

  #recordMismatch(surface: ProtocolMismatchSurface): void {
    this.#mismatchedSurfaces.add(surface);
    this.#lastMismatchSurface = surface;
  }
}

function extractTextFrame(
  record: SanitizedCaptureRecord
): { direction: "sent" | "received"; text: string } | null {
  if (record.source !== "playwright-websocket-frame" && record.source !== "cdp-websocket-frame") {
    return null;
  }
  const payload = asRecord(record.payload);
  if (!payload) {
    return null;
  }
  const direction = payload["direction"];
  if (direction !== "sent" && direction !== "received") {
    return null;
  }
  if (record.source === "playwright-websocket-frame") {
    const frame = asRecord(payload["frame"]);
    const text = frame?.["truncated"] === true ? null : readString(frame, "payload");
    return text === null ? null : { direction, text };
  }
  const cdpPayload = asRecord(payload["payload"]);
  const response = asRecord(cdpPayload?.["response"]);
  const text = response?.["truncated"] === true ? null : readString(response, "payloadData");
  return text === null ? null : { direction, text };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : null;
}

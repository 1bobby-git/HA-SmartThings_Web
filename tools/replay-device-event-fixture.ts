import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EventDeduplicator,
  extractDeviceEventIdentity
} from "../bridge/src/inspector/event-deduplicator.js";
import { decodeSocketIoTextFrame } from "../bridge/src/inspector/socketio-decoder.js";

export interface DeviceEventReplaySummary {
  eventName: string;
  fixtureDeliveries: number;
  decodedDeviceEvents: number;
  uniqueLogicalEvents: number;
  duplicateDeliveries: number;
  invalidFrames: number;
  expectedUniqueEvents: number;
  matchesExpectation: boolean;
}

export function replaySanitizedDeviceEventFixture(fixture: unknown): DeviceEventReplaySummary {
  const record = asRecord(fixture);
  const eventName = readString(record, "event_name");
  const deliveries = record?.["fixture_deliveries"];
  const expectedUniqueEvents = readNumber(record, "expected_unique_events");
  if (!eventName || !Array.isArray(deliveries) || expectedUniqueEvents === null) {
    throw new Error("invalid sanitized DEVICE_EVENT fixture");
  }

  let now = 1;
  const dedupe = new EventDeduplicator({ ttlMs: 60_000, maxEntries: 10_000, now: () => now });
  let decodedDeviceEvents = 0;
  let uniqueLogicalEvents = 0;
  let duplicateDeliveries = 0;
  let invalidFrames = 0;

  for (const delivery of deliveries) {
    const decoded = decodeSocketIoTextFrame(`42${JSON.stringify([eventName, delivery])}`);
    if (decoded.kind !== "event" || decoded.eventName !== eventName) {
      invalidFrames += 1;
      continue;
    }
    const identity = extractDeviceEventIdentity(decoded.args[0]);
    if (!identity) {
      invalidFrames += 1;
      continue;
    }
    decodedDeviceEvents += 1;
    now += 1;
    const result = dedupe.observe(identity);
    if (result.duplicate) {
      duplicateDeliveries += 1;
    } else {
      uniqueLogicalEvents += 1;
    }
  }

  return {
    eventName,
    fixtureDeliveries: deliveries.length,
    decodedDeviceEvents,
    uniqueLogicalEvents,
    duplicateDeliveries,
    invalidFrames,
    expectedUniqueEvents,
    matchesExpectation: uniqueLogicalEvents === expectedUniqueEvents && invalidFrames === 0
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function readNumber(value: Record<string, unknown> | undefined, key: string): number | null {
  const candidate = value?.[key];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0 ? Number(candidate) : null;
}

function runCli(): void {
  const fixturePath = resolve(
    process.argv[2] ?? "protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json"
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  process.stdout.write(`${JSON.stringify(replaySanitizedDeviceEventFixture(fixture), null, 2)}\n`);
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (executedPath && import.meta.url === executedPath) {
  runCli();
}

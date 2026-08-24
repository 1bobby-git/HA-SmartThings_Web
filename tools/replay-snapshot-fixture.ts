import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  SnapshotDetector,
  type SnapshotCategory
} from "../bridge/src/inspector/snapshot-detector.js";

interface SnapshotFixtureCorrelation {
  ack_id: string;
  request_event: string;
  request_query: string;
  request_keys: string[];
  response_category: SnapshotCategory;
  response_count: number;
  response_item_keys: string[];
  response_keys?: string[];
}

interface SnapshotFixture {
  correlations: SnapshotFixtureCorrelation[];
}

export interface SnapshotReplaySummary {
  correlations: number;
  matchedCorrelations: number;
  complete: boolean;
  categories: Partial<Record<SnapshotCategory, number>>;
  pendingRequests: number;
}

export function replaySanitizedSnapshotFixture(fixture: unknown): SnapshotReplaySummary {
  const parsed = parseFixture(fixture);
  const detector = new SnapshotDetector();
  let matchedCorrelations = 0;

  for (const correlation of parsed.correlations) {
    const ackId = Number(correlation.ack_id.split("_")[1]);
    if (!Number.isSafeInteger(ackId) || ackId < 0) {
      throw new Error("invalid sanitized snapshot ACK alias");
    }
    detector.observeSentFrame(
      `42${ackId}${JSON.stringify([
        correlation.request_event,
        correlation.request_query,
        Object.fromEntries(correlation.request_keys.map((key) => [key, null]))
      ])}`
    );
    const result = detector.observeReceivedFrame(
      `43${ackId}${JSON.stringify([null, buildResponse(correlation)])}`
    );
    if (result?.category === correlation.response_category) {
      matchedCorrelations += 1;
    }
  }

  const snapshot = detector.snapshot();
  return {
    correlations: parsed.correlations.length,
    matchedCorrelations,
    complete: snapshot.complete,
    categories: snapshot.categories,
    pendingRequests: snapshot.pendingRequests
  };
}

function parseFixture(value: unknown): SnapshotFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid sanitized snapshot fixture");
  }
  const correlations = (value as Record<string, unknown>)["correlations"];
  if (!Array.isArray(correlations)) {
    throw new Error("invalid sanitized snapshot fixture");
  }
  return { correlations: correlations as SnapshotFixtureCorrelation[] };
}

function buildResponse(correlation: SnapshotFixtureCorrelation): unknown {
  const items = Array.from({ length: correlation.response_count }, () =>
    Object.fromEntries(correlation.response_item_keys.map((key) => [key, null]))
  );
  if (correlation.response_category === "device_cards") {
    return Object.fromEntries(
      (correlation.response_keys ?? ["data"]).map((key) => [key, key === "data" ? items : null])
    );
  }
  return items;
}

function runCli(): void {
  const fixturePath = resolve(
    process.argv[2] ?? "protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json"
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  process.stdout.write(`${JSON.stringify(replaySanitizedSnapshotFixture(fixture), null, 2)}\n`);
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (executedPath && import.meta.url === executedPath) {
  runCli();
}

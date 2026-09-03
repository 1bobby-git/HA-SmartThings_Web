const MAX_AGGREGATE_BYTES = 64 * 1_024;

const SOURCE_KEYS = new Set([
  "playwrightRequest",
  "playwrightResponse",
  "playwrightWebsocket",
  "playwrightServiceWorker",
  "cdpResponseBody"
]);
const ORIGIN_KEYS = new Set([
  "publicSmartThingsApi",
  "consumerSmartThingsWeb",
  "samsungAccount",
  "otherSamsung",
  "otherNetwork",
  "invalidOrMissing"
]);
const AGGREGATE_KEYS = new Set([
  "schemaVersion",
  "observationScope",
  "firstCapturedAt",
  "lastCapturedAt",
  "totalCaptureRowCount",
  "analyzedCaptureRowCount",
  "urlBearingCaptureRowCount",
  "sourceCounts",
  "originCounts"
]);

export type CaptureOriginClassification =
  | "consumer_web_only_observed"
  | "public_smartthings_api_only_observed"
  | "mixed_consumer_web_and_public_api_observed"
  | "inconclusive_no_relevant_url";

export type CaptureOriginAuditResult =
  | "no_public_api_observed"
  | "public_api_observed"
  | "inconclusive";

export interface CaptureOriginSourceCounts {
  playwrightRequest: number;
  playwrightResponse: number;
  playwrightWebsocket: number;
  playwrightServiceWorker: number;
  cdpResponseBody: number;
}

export interface CaptureOriginCounts {
  publicSmartThingsApi: number;
  consumerSmartThingsWeb: number;
  samsungAccount: number;
  otherSamsung: number;
  otherNetwork: number;
  invalidOrMissing: number;
}

export interface CaptureOriginAuditAggregate {
  schemaVersion: 1;
  observationScope: "retained_sanitized_capture_history";
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  totalCaptureRowCount: number;
  analyzedCaptureRowCount: number;
  urlBearingCaptureRowCount: number;
  sourceCounts: CaptureOriginSourceCounts;
  originCounts: CaptureOriginCounts;
}

export interface CaptureOriginAuditSummary extends CaptureOriginAuditAggregate {
  result: CaptureOriginAuditResult;
  classification: CaptureOriginClassification;
  checks: {
    consumerSmartThingsWebObserved: boolean;
    publicSmartThingsApiObserved: boolean;
  };
  limitations: readonly [
    "retained_capture_history_not_complete_network_history",
    "url_records_can_double_count_one_network_exchange"
  ];
}

export const CAPTURE_ORIGIN_AUDIT_SCRIPT = String.raw`
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/bridge.sqlite", { readOnly: true });
const sourceCounts = {
  playwrightRequest: 0,
  playwrightResponse: 0,
  playwrightWebsocket: 0,
  playwrightServiceWorker: 0,
  cdpResponseBody: 0
};
const originCounts = {
  publicSmartThingsApi: 0,
  consumerSmartThingsWeb: 0,
  samsungAccount: 0,
  otherSamsung: 0,
  otherNetwork: 0,
  invalidOrMissing: 0
};
const sourceKey = {
  "playwright-request": "playwrightRequest",
  "playwright-response": "playwrightResponse",
  "playwright-websocket": "playwrightWebsocket",
  "playwright-service-worker": "playwrightServiceWorker",
  "cdp-response-body": "cdpResponseBody"
};
const totalCaptureRowCount = Number(
  db.prepare("SELECT COUNT(*) AS count FROM captures").get().count
);
const rows = db.prepare(
  "SELECT source, received_at AS receivedAt, payload_json AS payloadJson " +
  "FROM captures WHERE source IN (" +
  "'playwright-request','playwright-response','playwright-websocket'," +
  "'playwright-service-worker','cdp-response-body') ORDER BY id"
);
let analyzedCaptureRowCount = 0;
let urlBearingCaptureRowCount = 0;
let firstCapturedAt = null;
let lastCapturedAt = null;
for (const row of rows.iterate()) {
  analyzedCaptureRowCount += 1;
  const key = sourceKey[row.source];
  if (!key) {
    throw new Error("capture_origin_source_invalid");
  }
  sourceCounts[key] += 1;
  if (firstCapturedAt === null) {
    firstCapturedAt = row.receivedAt;
  }
  lastCapturedAt = row.receivedAt;
  let category = "invalidOrMissing";
  try {
    const payload = JSON.parse(row.payloadJson);
    if (typeof payload.url === "string") {
      const parsed = new URL(payload.url);
      if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
        if (hostname === "api.smartthings.com" || hostname.endsWith(".api.smartthings.com")) {
          category = "publicSmartThingsApi";
        } else if (hostname === "my.smartthings.com") {
          category = "consumerSmartThingsWeb";
        } else if (hostname === "account.samsung.com") {
          category = "samsungAccount";
        } else if (hostname === "samsung.com" || hostname.endsWith(".samsung.com")) {
          category = "otherSamsung";
        } else {
          category = "otherNetwork";
        }
        urlBearingCaptureRowCount += 1;
      }
    }
  } catch {
    category = "invalidOrMissing";
  }
  originCounts[category] += 1;
}
db.close();
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  observationScope: "retained_sanitized_capture_history",
  firstCapturedAt,
  lastCapturedAt,
  totalCaptureRowCount,
  analyzedCaptureRowCount,
  urlBearingCaptureRowCount,
  sourceCounts,
  originCounts
}));
`;

export function buildCaptureOriginAuditRemoteCommand(input: {
  vmId: number;
  addonSlug: string;
}): string {
  if (!Number.isSafeInteger(input.vmId) || input.vmId <= 0) {
    throw new Error("capture_origin_audit_command_invalid");
  }
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(input.addonSlug)) {
    throw new Error("capture_origin_audit_command_invalid");
  }
  const encoded = Buffer.from(CAPTURE_ORIGIN_AUDIT_SCRIPT, "utf8").toString("base64");
  return `qm guest exec ${String(input.vmId)} -- docker exec app_${input.addonSlug} node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

export function parseCaptureOriginAuditAggregate(text: string): CaptureOriginAuditAggregate {
  if (Buffer.byteLength(text, "utf8") > MAX_AGGREGATE_BYTES) {
    throw new Error("capture_origin_audit_response_invalid");
  }
  try {
    const record = requireRecord(JSON.parse(text) as unknown);
    assertExactKeys(record, AGGREGATE_KEYS);
    const parsedSourceCounts = parseCounts(record.sourceCounts, SOURCE_KEYS);
    const parsedOriginCounts = parseCounts(record.originCounts, ORIGIN_KEYS);
    const sourceCounts: CaptureOriginSourceCounts = {
      playwrightRequest: parsedSourceCounts.playwrightRequest ?? 0,
      playwrightResponse: parsedSourceCounts.playwrightResponse ?? 0,
      playwrightWebsocket: parsedSourceCounts.playwrightWebsocket ?? 0,
      playwrightServiceWorker: parsedSourceCounts.playwrightServiceWorker ?? 0,
      cdpResponseBody: parsedSourceCounts.cdpResponseBody ?? 0
    };
    const originCounts: CaptureOriginCounts = {
      publicSmartThingsApi: parsedOriginCounts.publicSmartThingsApi ?? 0,
      consumerSmartThingsWeb: parsedOriginCounts.consumerSmartThingsWeb ?? 0,
      samsungAccount: parsedOriginCounts.samsungAccount ?? 0,
      otherSamsung: parsedOriginCounts.otherSamsung ?? 0,
      otherNetwork: parsedOriginCounts.otherNetwork ?? 0,
      invalidOrMissing: parsedOriginCounts.invalidOrMissing ?? 0
    };
    const aggregate: CaptureOriginAuditAggregate = {
      schemaVersion: 1,
      observationScope: "retained_sanitized_capture_history",
      firstCapturedAt: nullableTimestamp(record.firstCapturedAt),
      lastCapturedAt: nullableTimestamp(record.lastCapturedAt),
      totalCaptureRowCount: nonNegativeInteger(record.totalCaptureRowCount),
      analyzedCaptureRowCount: nonNegativeInteger(record.analyzedCaptureRowCount),
      urlBearingCaptureRowCount: nonNegativeInteger(record.urlBearingCaptureRowCount),
      sourceCounts,
      originCounts
    };
    if (
      record.schemaVersion !== 1 ||
      record.observationScope !== aggregate.observationScope ||
      aggregate.totalCaptureRowCount < aggregate.analyzedCaptureRowCount ||
      sumCounts(sourceCounts) !== aggregate.analyzedCaptureRowCount ||
      sumCounts(originCounts) !== aggregate.analyzedCaptureRowCount ||
      aggregate.urlBearingCaptureRowCount !==
        aggregate.analyzedCaptureRowCount - originCounts.invalidOrMissing ||
      (aggregate.analyzedCaptureRowCount === 0 &&
        (aggregate.firstCapturedAt !== null || aggregate.lastCapturedAt !== null)) ||
      (aggregate.analyzedCaptureRowCount > 0 &&
        (aggregate.firstCapturedAt === null || aggregate.lastCapturedAt === null)) ||
      (aggregate.firstCapturedAt !== null &&
        aggregate.lastCapturedAt !== null &&
        Date.parse(aggregate.firstCapturedAt) > Date.parse(aggregate.lastCapturedAt))
    ) {
      throw new Error("invalid aggregate");
    }
    return aggregate;
  } catch {
    throw new Error("capture_origin_audit_response_invalid");
  }
}

export function createCaptureOriginAuditSummary(
  aggregate: CaptureOriginAuditAggregate
): CaptureOriginAuditSummary {
  const parsed = parseCaptureOriginAuditAggregate(JSON.stringify(aggregate));
  const consumerObserved = parsed.originCounts.consumerSmartThingsWeb > 0;
  const publicApiObserved = parsed.originCounts.publicSmartThingsApi > 0;
  const classification: CaptureOriginClassification = publicApiObserved
    ? consumerObserved
      ? "mixed_consumer_web_and_public_api_observed"
      : "public_smartthings_api_only_observed"
    : consumerObserved
      ? "consumer_web_only_observed"
      : "inconclusive_no_relevant_url";
  const result: CaptureOriginAuditResult = publicApiObserved
    ? "public_api_observed"
    : consumerObserved
      ? "no_public_api_observed"
      : "inconclusive";
  return {
    ...parsed,
    result,
    classification,
    checks: {
      consumerSmartThingsWebObserved: consumerObserved,
      publicSmartThingsApiObserved: publicApiObserved
    },
    limitations: [
      "retained_capture_history_not_complete_network_history",
      "url_records_can_double_count_one_network_exchange"
    ]
  };
}

function parseCounts(value: unknown, keys: ReadonlySet<string>): Record<string, number> {
  const record = requireRecord(value);
  assertExactKeys(record, keys);
  return Object.fromEntries([...keys].map((key) => [key, nonNegativeInteger(record[key])]));
}

function sumCounts(record: object): number {
  return Object.values(record as Record<string, number>).reduce(
    (total, value) => total + value,
    0
  );
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("invalid timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("invalid timestamp");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("invalid integer");
  }
  return Number(value);
}

function assertExactKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): void {
  if (Object.keys(record).length !== keys.size || Object.keys(record).some((key) => !keys.has(key))) {
    throw new Error("unexpected keys");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

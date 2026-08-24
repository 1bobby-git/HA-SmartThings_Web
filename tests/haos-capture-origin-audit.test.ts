import { describe, expect, it } from "vitest";

import {
  buildCaptureOriginAuditRemoteCommand,
  CAPTURE_ORIGIN_AUDIT_SCRIPT,
  createCaptureOriginAuditSummary,
  parseCaptureOriginAuditAggregate,
  type CaptureOriginAuditAggregate
} from "../tools/haos-capture-origin-audit-core.js";

describe("HAOS retained capture origin audit", () => {
  it("builds a fixed read-only in-container aggregate command", () => {
    const command = buildCaptureOriginAuditRemoteCommand({
      vmId: 100,
      addonSlug: "local_smartthings_web_bridge"
    });

    expect(command).toMatch(
      /^qm guest exec 100 -- docker exec app_local_smartthings_web_bridge node -e /u
    );
    expect(CAPTURE_ORIGIN_AUDIT_SCRIPT).toContain(
      'new DatabaseSync("/data/bridge.sqlite", { readOnly: true })'
    );
    expect(CAPTURE_ORIGIN_AUDIT_SCRIPT).toContain('hostname === "api.smartthings.com"');
    expect(CAPTURE_ORIGIN_AUDIT_SCRIPT).toContain('hostname === "my.smartthings.com"');
    expect(CAPTURE_ORIGIN_AUDIT_SCRIPT).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|REPLACE\s+INTO|VACUUM)\b/iu
    );
    expect(CAPTURE_ORIGIN_AUDIT_SCRIPT).not.toContain("payloadJson:");
  });

  it("rejects command argument injection", () => {
    expect(() =>
      buildCaptureOriginAuditRemoteCommand({ vmId: 0, addonSlug: "safe" })
    ).toThrowError("capture_origin_audit_command_invalid");
    expect(() =>
      buildCaptureOriginAuditRemoteCommand({ vmId: 100, addonSlug: "safe; reboot" })
    ).toThrowError("capture_origin_audit_command_invalid");
  });

  it("accepts exact internally consistent aggregate output", () => {
    const aggregate = baseAggregate();

    expect(parseCaptureOriginAuditAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
  });

  it("classifies consumer-web-only evidence without claiming complete history", () => {
    const summary = createCaptureOriginAuditSummary(baseAggregate());

    expect(summary.result).toBe("no_public_api_observed");
    expect(summary.classification).toBe("consumer_web_only_observed");
    expect(summary.checks).toEqual({
      consumerSmartThingsWebObserved: true,
      publicSmartThingsApiObserved: false
    });
    expect(summary.limitations).toContain("retained_capture_history_not_complete_network_history");
  });

  it.each([
    [1, 0, "public_api_observed", "public_smartthings_api_only_observed"],
    [1, 1, "public_api_observed", "mixed_consumer_web_and_public_api_observed"],
    [0, 0, "inconclusive", "inconclusive_no_relevant_url"]
  ] as const)("classifies public=%i consumer=%i", (publicCount, consumerCount, result, classification) => {
    const analyzed = Math.max(1, publicCount + consumerCount);
    const aggregate = baseAggregate({
      analyzedCaptureRowCount: analyzed,
      urlBearingCaptureRowCount: analyzed,
      sourceCounts: {
        playwrightRequest: analyzed,
        playwrightResponse: 0,
        playwrightWebsocket: 0,
        playwrightServiceWorker: 0,
        cdpResponseBody: 0
      },
      originCounts: {
        publicSmartThingsApi: publicCount,
        consumerSmartThingsWeb: consumerCount,
        samsungAccount: 0,
        otherSamsung: 0,
        otherNetwork: analyzed - publicCount - consumerCount,
        invalidOrMissing: 0
      }
    });

    const summary = createCaptureOriginAuditSummary(aggregate);
    expect(summary.result).toBe(result);
    expect(summary.classification).toBe(classification);
  });

  it("rejects expanded, inconsistent, or invalid aggregate output", () => {
    const aggregate = baseAggregate();
    expect(() =>
      parseCaptureOriginAuditAggregate(JSON.stringify({ ...aggregate, rawUrls: ["secret"] }))
    ).toThrowError("capture_origin_audit_response_invalid");
    expect(() =>
      parseCaptureOriginAuditAggregate(
        JSON.stringify({ ...aggregate, analyzedCaptureRowCount: 999 })
      )
    ).toThrowError("capture_origin_audit_response_invalid");
    expect(() =>
      parseCaptureOriginAuditAggregate(
        JSON.stringify({ ...aggregate, firstCapturedAt: "2026-08-24T99:00:00.000Z" })
      )
    ).toThrowError("capture_origin_audit_response_invalid");
  });
});

function baseAggregate(
  override: Partial<CaptureOriginAuditAggregate> = {}
): CaptureOriginAuditAggregate {
  return {
    schemaVersion: 1,
    observationScope: "retained_sanitized_capture_history",
    firstCapturedAt: "2026-08-24T04:00:00.000Z",
    lastCapturedAt: "2026-08-24T05:00:00.000Z",
    totalCaptureRowCount: 100,
    analyzedCaptureRowCount: 10,
    urlBearingCaptureRowCount: 8,
    sourceCounts: {
      playwrightRequest: 3,
      playwrightResponse: 3,
      playwrightWebsocket: 1,
      playwrightServiceWorker: 1,
      cdpResponseBody: 2
    },
    originCounts: {
      publicSmartThingsApi: 0,
      consumerSmartThingsWeb: 4,
      samsungAccount: 1,
      otherSamsung: 1,
      otherNetwork: 2,
      invalidOrMissing: 2
    },
    ...override
  };
}

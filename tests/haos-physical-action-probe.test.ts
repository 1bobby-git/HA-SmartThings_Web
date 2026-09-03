import { describe, expect, test } from "vitest";

import {
  buildPhysicalProbeRemoteCommand,
  parsePhysicalProbeGuestResponse
} from "../tools/haos-physical-action-probe-core.js";

describe("HAOS physical-action probe operator", () => {
  test("builds a fixed read-only status command for the Supervisor container", () => {
    const command = buildPhysicalProbeRemoteCommand({
      vmId: 100,
      addonSlug: "local_smartthings_web_bridge",
      operation: { kind: "status" }
    });

    expect(command).toContain("docker exec app_local_smartthings_web_bridge");
    expect(command).toContain("http://127.0.0.1:8098/probe/physical-action");
    expect(command).not.toContain("--data-binary");
  });

  test("builds only validated arm JSON and rejects command injection", () => {
    const command = buildPhysicalProbeRemoteCommand({
      vmId: 100,
      addonSlug: "local_smartthings_web_bridge",
      operation: {
        kind: "arm",
        actionType: "contact_open",
        targetDeviceAlias: "dev_001",
        windowSeconds: 60
      }
    });

    expect(command).toContain("/probe/physical-action/arm");
    expect(command).toContain(
      `'${JSON.stringify({
        actionType: "contact_open",
        targetDeviceAlias: "dev_001",
        windowSeconds: 60
      })}'`
    );
    expect(() =>
      buildPhysicalProbeRemoteCommand({
        vmId: 100,
        addonSlug: "local_smartthings_web_bridge",
        operation: {
          kind: "arm",
          actionType: "contact_open",
          targetDeviceAlias: "dev_001';whoami",
          windowSeconds: 60
        }
      })
    ).toThrowError("probe_command_invalid");
    expect(() =>
      buildPhysicalProbeRemoteCommand({
        vmId: 100,
        addonSlug: "unsafe;whoami",
        operation: { kind: "status" }
      })
    ).toThrowError("probe_command_invalid");
  });

  test("reconstructs only allowlisted probe evidence", () => {
    const response = parsePhysicalProbeGuestResponse(
      guestResponse(
        {
          ...validSnapshot(),
          authorization: "Bearer raw-secret-token",
          rawUrl: "https://example.invalid/?token=raw-secret-token",
          candidates: [
            {
              deviceAlias: "dev_001",
              component: "main",
              capability: "contactSensor",
              attribute: "contact",
              valueType: "string",
              unitPresent: false,
              stateChange: true,
              expectedValueMatched: true,
              identitySource: "event_id",
              logicalEventHash: "a".repeat(64),
              uniqueLogicalEventCount: 1,
              deliveryCount: 2,
              receiveAfterArmMs: 250,
              sourceAfterArmMs: 200,
              rawValue: "open",
              rawDeviceId: "raw-device-id"
            }
          ],
          candidateCount: 1
        },
        200
      )
    );

    expect(response).toMatchObject({
      ok: true,
      httpStatus: 200,
      snapshot: {
        state: "pass",
        actionType: "contact_open",
        targetDeviceAlias: "dev_001",
        candidateCount: 1,
        candidates: [
          {
            deviceAlias: "dev_001",
            capability: "contactSensor",
            logicalEventHash: "a".repeat(64),
            deliveryCount: 2
          }
        ]
      }
    });
    expect(JSON.stringify(response)).not.toMatch(
      /raw-secret-token|example\.invalid|raw-device-id|rawValue|rawDeviceId|authorization/i
    );
  });

  test("returns only fixed HTTP errors and drops extra response content", () => {
    const response = parsePhysicalProbeGuestResponse(
      guestResponse({ error: "not_found", detail: "raw-secret-token" }, 404)
    );

    expect(response).toEqual({ ok: false, httpStatus: 404, error: "not_found" });
    expect(JSON.stringify(response)).not.toContain("raw-secret-token");
  });

  test("rejects unknown errors and unsafe candidate evidence without echoing it", () => {
    expect(() =>
      parsePhysicalProbeGuestResponse(
        guestResponse({ error: "raw-secret-token", detail: "another-secret" }, 500)
      )
    ).toThrowError("probe_response_invalid");
    expect(() =>
      parsePhysicalProbeGuestResponse(
        guestResponse(
          {
            ...validSnapshot(),
            candidateCount: 1,
            candidates: [
              {
                deviceAlias: "raw-device-id",
                component: "main",
                capability: "contactSensor",
                attribute: "contact",
                valueType: "string",
                unitPresent: false,
                stateChange: true,
                expectedValueMatched: true,
                identitySource: "event_id",
                logicalEventHash: "raw-event-key",
                uniqueLogicalEventCount: 1,
                deliveryCount: 1,
                receiveAfterArmMs: 10
              }
            ]
          },
          200
        )
      )
    ).toThrowError("probe_response_invalid");
  });

  test("rejects unsuccessful guest execution and malformed HTTP framing", () => {
    expect(() =>
      parsePhysicalProbeGuestResponse(
        JSON.stringify({ exitcode: 1, exited: 1, "out-data": "raw-secret-token" })
      )
    ).toThrowError("probe_command_failed");
    expect(() => parsePhysicalProbeGuestResponse(guestExec("{}"))).toThrowError(
      "probe_response_invalid"
    );
  });
});

function validSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    state: "pass",
    actionType: "contact_open",
    targetDeviceAlias: "dev_001",
    windowSeconds: 60,
    elapsedMs: 60_000,
    remainingMs: 0,
    live: true,
    ready: true,
    runtimeState: "CONNECTED",
    browserIsolated: true,
    baseline: counters(100, 50, 50),
    current: counters(102, 51, 51),
    candidateCount: 0,
    reasons: [],
    candidates: []
  };
}

function counters(decoded: number, unique: number, duplicate: number): Record<string, number> {
  return {
    observedDeviceCount: 213,
    decodedDeviceEventCount: decoded,
    uniqueLogicalEventCount: unique,
    duplicateEventCount: duplicate,
    protocolInvalidFrameCount: 2,
    protocolChangeCount: 0,
    restartCount: 0
  };
}

function guestResponse(body: unknown, status: number): string {
  return guestExec(`${JSON.stringify(body)}\n${String(status)}`);
}

function guestExec(output: string): string {
  return JSON.stringify({
    exitcode: 0,
    exited: 1,
    "out-data": output,
    "out-truncated": 0
  });
}

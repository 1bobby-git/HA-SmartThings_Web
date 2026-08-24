import { describe, expect, test } from "vitest";

import type { DeviceEventSummary } from "../../src/inspector/device-event-summary.js";
import {
  PHYSICAL_ACTION_PRESETS,
  PhysicalActionCorrelationProbe,
  type ProbeRuntimeEvidence
} from "../../src/inspector/physical-action-correlation-probe.js";

describe("PhysicalActionCorrelationProbe", () => {
  test("remains armed before expiry and excludes a new event at the exact deadline", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    expect(probe.arm({ actionType: "contact_open", windowSeconds: 15 }, healthyEvidence()).ok).toBe(
      true
    );

    clock.advance(14_999);
    expect(probe.snapshot(healthyEvidence()).state).toBe("armed");

    clock.advance(1);
    probe.observe(newResult("deadline-key", contactEvent("dev_007", "open", true)));

    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 }))).toMatchObject({
      state: "fail",
      candidateCount: 0,
      reasons: ["no_match"]
    });
  });

  test("passes only after one matching new event expires", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 15 }, healthyEvidence());
    clock.advance(500);
    probe.observe(newResult("event_id:identifier_deadbeef0000", contactEvent("dev_007", "open", true)));

    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 })).state).toBe("armed");

    clock.advance(14_500);
    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 }))).toMatchObject({
      state: "pass",
      actionType: "contact_open",
      candidateCount: 1,
      candidates: [
        {
          deviceAlias: "dev_007",
          component: "main",
          capability: "contactSensor",
          attribute: "contact",
          valueType: "string",
          unitPresent: false,
          stateChange: true,
          expectedValueMatched: true,
          identitySource: "event_id",
          uniqueLogicalEventCount: 1,
          deliveryCount: 1,
          receiveAfterArmMs: 500
        }
      ]
    });
  });

  test("increments delivery count for in-window duplicates and ignores orphan duplicates", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 1 }, healthyEvidence());
    clock.advance(50);
    probe.observe(duplicateResult("event_id:orphan", contactEvent("dev_001", "open", true)));
    clock.advance(50);
    probe.observe(newResult("event_id:known", contactEvent("dev_001", "open", true)));
    clock.advance(50);
    probe.observe(duplicateResult("event_id:known", contactEvent("dev_001", "open", true), 2));
    clock.advance(850);

    expect(
      probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51, duplicateEventCount: 52 }))
    ).toMatchObject({
      state: "pass",
      candidateCount: 1,
      candidates: [{ deliveryCount: 2, receiveAfterArmMs: 100 }]
    });
  });

  test("returns ambiguous for two matching logical keys", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "motion_active", windowSeconds: 1 }, healthyEvidence());
    probe.observe(newResult("event_id:first", motionEvent("dev_001", true)));
    probe.observe(newResult("event_id:second", motionEvent("dev_002", true)));
    clock.advance(1_000);

    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 52 }))).toMatchObject({
      state: "ambiguous",
      candidateCount: 2,
      reasons: ["multiple_candidates"]
    });
  });

  test("filters candidates by target alias before verdict", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm(
      { actionType: "contact_close", targetDeviceAlias: "dev_002", windowSeconds: 1 },
      healthyEvidence()
    );
    probe.observe(newResult("event_id:first", contactEvent("dev_001", "closed", true)));
    probe.observe(newResult("event_id:second", contactEvent("dev_002", "closed", true)));
    clock.advance(1_000);

    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 52 }))).toMatchObject({
      state: "pass",
      targetDeviceAlias: "dev_002",
      candidateCount: 1,
      candidates: [{ deviceAlias: "dev_002" }]
    });
  });

  test("fails when no matching event arrives", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "switch_manual_on", windowSeconds: 1 }, healthyEvidence());
    probe.observe(newResult("event_id:off", switchEvent("dev_001", "off", true)));
    clock.advance(1_000);

    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 }))).toMatchObject({
      state: "fail",
      candidateCount: 0,
      reasons: ["no_match"]
    });
  });

  test.each([
    ["live loss", { live: false }, "runtime_not_ready"],
    ["readiness loss", { ready: false }, "runtime_not_ready"],
    ["state disconnect", { state: "DISCONNECTED" }, "runtime_not_ready"],
    ["browser isolation loss", { browserIsolated: false }, "browser_not_isolated"],
    ["protocol change", { protocolChangeCount: 1 }, "protocol_changed"],
    ["restart", { restartCount: 1 }, "runtime_restarted"],
    ["invalid frame increase", { protocolInvalidFrameCount: 3 }, "invalid_frame_increase"],
    ["observed counter regression", { observedDeviceCount: 212 }, "counter_regression"],
    ["decoded counter regression", { decodedDeviceEventCount: 99 }, "counter_regression"],
    ["unique counter regression", { uniqueLogicalEventCount: 49 }, "counter_regression"],
    ["duplicate counter regression", { duplicateEventCount: 49 }, "counter_regression"]
  ] as const)("fails closed on %s", (_name, overrides, reason) => {
    const probe = createProbe(createClock());

    probe.arm({ actionType: "contact_open" }, healthyEvidence());

    expect(probe.snapshot(healthyEvidence(overrides))).toMatchObject({
      state: "fail",
      reasons: [reason]
    });
  });

  test("candidate 33 fails with overflow and stores only 32 candidates", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 60 }, healthyEvidence());
    for (let index = 1; index <= 33; index += 1) {
      probe.observe(
        newResult(`event_id:${index}`, contactEvent(`dev_${String(index).padStart(3, "0")}`, "open", true))
      );
    }

    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 83 }))).toMatchObject({
      state: "fail",
      candidateCount: 32,
      reasons: ["candidate_overflow"]
    });
  });

  test("unsafe summary and explicit failures affect only active armed windows", () => {
    const probe = createProbe(createClock());

    probe.observeUnsafeEvent();
    expect(probe.snapshot(healthyEvidence()).state).toBe("idle");

    probe.arm({ actionType: "contact_open" }, healthyEvidence());
    probe.observeUnsafeEvent();
    expect(probe.snapshot(healthyEvidence())).toMatchObject({
      state: "fail",
      reasons: ["unsafe_event"]
    });

    probe.fail("runtime_restarted");
    expect(probe.snapshot(healthyEvidence())).toMatchObject({
      state: "fail",
      reasons: ["unsafe_event"]
    });
  });

  test("unsafe event at the exact deadline cannot replace no-match expiry", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 1 }, healthyEvidence());
    clock.advance(1_000);
    probe.observeUnsafeEvent();

    expect(probe.snapshot(healthyEvidence())).toMatchObject({
      state: "fail",
      reasons: ["no_match"],
      candidateCount: 0
    });
  });

  test("records browser isolation loss during an active window", () => {
    const probe = createProbe(createClock());

    probe.recordBrowserIsolation(false);
    expect(probe.snapshot(healthyEvidence()).state).toBe("idle");

    probe.arm({ actionType: "contact_open" }, healthyEvidence());
    probe.recordBrowserIsolation(false);

    expect(probe.snapshot(healthyEvidence())).toMatchObject({
      state: "fail",
      reasons: ["browser_not_isolated"]
    });
  });

  test("browser isolation loss at the exact deadline cannot replace a pass", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 1 }, healthyEvidence());
    probe.observe(newResult("event_id:one", contactEvent("dev_001", "open", true)));
    clock.advance(1_000);
    probe.recordBrowserIsolation(false);

    expect(probe.snapshot(healthyEvidence())).toMatchObject({
      state: "pass",
      reasons: [],
      candidateCount: 1
    });
  });

  test("explicit failure at the exact deadline cannot replace a pass", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 1 }, healthyEvidence());
    probe.observe(newResult("event_id:one", contactEvent("dev_001", "open", true)));
    clock.advance(1_000);
    probe.fail("runtime_restarted");

    expect(probe.snapshot(healthyEvidence())).toMatchObject({
      state: "pass",
      reasons: [],
      candidateCount: 1
    });
  });

  test("reset lifecycle voids evidence and supports later replacement", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    expect(probe.reset(healthyEvidence())).toMatchObject({ state: "idle", reasons: [] });

    probe.arm({ actionType: "contact_open" }, healthyEvidence());
    expect(probe.reset(healthyEvidence())).toMatchObject({
      state: "voided",
      reasons: ["manual_reset"],
      candidateCount: 0,
      candidates: []
    });

    expect(probe.arm({ actionType: "contact_open" }, healthyEvidence()).ok).toBe(true);
    probe.observe(newResult("event_id:one", contactEvent("dev_001", "open", true)));
    clock.advance(60_000);
    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 })).state).toBe("pass");

    expect(probe.reset(healthyEvidence())).toMatchObject({
      state: "voided",
      reasons: ["manual_reset"],
      candidateCount: 0,
      candidates: []
    });
    expect(probe.arm({ actionType: "button_push" }, healthyEvidence()).ok).toBe(true);
  });

  test("rejects active arm conflicts but replaces expired armed windows", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 10 }, healthyEvidence());
    expect(probe.arm({ actionType: "contact_close" }, healthyEvidence())).toEqual({
      ok: false,
      error: "probe_conflict"
    });

    clock.advance(10_000);
    const replacement = probe.arm({ actionType: "contact_close" }, healthyEvidence());

    expect(replacement).toMatchObject({
      ok: true,
      snapshot: { state: "armed", actionType: "contact_close" }
    });
  });

  test("arm prerequisites return fixed errors and leave existing completed state unchanged", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    expect(probe.arm({ actionType: "contact_open" }, healthyEvidence({ browserIsolated: false }))).toEqual({
      ok: false,
      error: "browser_not_isolated"
    });
    expect(probe.snapshot(healthyEvidence()).state).toBe("idle");

    expect(probe.arm({ actionType: "contact_open" }, healthyEvidence({ observedDeviceCount: 0 }))).toEqual({
      ok: false,
      error: "not_ready"
    });

    probe.arm({ actionType: "contact_open", windowSeconds: 1 }, healthyEvidence());
    probe.observe(newResult("event_id:one", contactEvent("dev_001", "open", true)));
    clock.advance(1_000);
    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 })).state).toBe("pass");

    expect(probe.arm({ actionType: "contact_open" }, healthyEvidence({ ready: false }))).toEqual({
      ok: false,
      error: "not_ready"
    });
    expect(probe.snapshot(healthyEvidence()).state).toBe("pass");
  });

  test("wall clock jumps do not expire an armed window", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 60 }, healthyEvidence());
    clock.advanceWallOnly(3_600_000);

    expect(probe.snapshot(healthyEvidence())).toMatchObject({
      state: "armed",
      elapsedMs: 0,
      remainingMs: 60_000
    });
  });

  test("omits skewed source timestamp and includes valid source delta", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm({ actionType: "contact_open", windowSeconds: 1 }, healthyEvidence());
    clock.advance(100);
    probe.observe(
      newResult("event_id:skewed", contactEvent("dev_001", "open", true, clock.wall - 1_000))
    );
    clock.advance(100);
    probe.observe(
      newResult("event_id:valid", contactEvent("dev_002", "open", true, clock.wall - 50))
    );
    clock.advance(800);

    const snapshot = probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 52 }));
    expect(snapshot.state).toBe("ambiguous");
    expect(snapshot.candidates[0]).not.toHaveProperty("sourceAfterArmMs");
    expect(snapshot.candidates[1]).toMatchObject({ sourceAfterArmMs: 150 });
  });

  test("serialized public snapshot is allowlisted and hashes logical keys", () => {
    const clock = createClock();
    const probe = createProbe(clock);

    probe.arm(
      { actionType: "switch_manual_on", targetDeviceAlias: "dev_007", windowSeconds: 1 },
      healthyEvidence()
    );
    probe.observe(
      newResult(
        "event_id:identifier_deadbeef0000?token=secret",
        switchEvent("dev_007", "on", true, clock.wall)
      )
    );
    clock.advance(1_000);

    const snapshot = probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 }));
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.candidates[0]?.logicalEventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.candidates[0]?.logicalEventHash).not.toContain("event_id");
    expect(serialized).not.toMatch(
      /identifier_deadbeef|event_id:|fingerprint:|token|secret|https?:\/\/|headers|payload|open|closed|pushed|event_time/i
    );
    expect(serialized).toContain("dev_007");
  });

  test("all fixed presets match expected actions and button does not require state change", () => {
    expect(PHYSICAL_ACTION_PRESETS).toEqual({
      contact_open: {
        capability: "contactSensor",
        attribute: "contact",
        value: "open",
        requireStateChange: true
      },
      contact_close: {
        capability: "contactSensor",
        attribute: "contact",
        value: "closed",
        requireStateChange: true
      },
      motion_active: {
        capability: "motionSensor",
        attribute: "motion",
        value: "active",
        requireStateChange: true
      },
      switch_manual_on: {
        capability: "switch",
        attribute: "switch",
        value: "on",
        requireStateChange: true
      },
      switch_manual_off: {
        capability: "switch",
        attribute: "switch",
        value: "off",
        requireStateChange: true
      },
      button_push: {
        capability: "button",
        attribute: "button",
        value: "pushed",
        requireStateChange: false
      }
    });

    const clock = createClock();
    const probe = createProbe(clock);
    probe.arm({ actionType: "button_push", windowSeconds: 1 }, healthyEvidence());
    probe.observe(newResult("event_id:button", buttonEvent("dev_001", false)));
    clock.advance(1_000);

    expect(probe.snapshot(evidenceAfter({ uniqueLogicalEventCount: 51 }))).toMatchObject({
      state: "pass",
      candidateCount: 1,
      candidates: [{ stateChange: false }]
    });
  });
});

interface TestClock {
  monotonic: number;
  wall: number;
  advance(ms: number): void;
  advanceWallOnly(ms: number): void;
}

function createClock(): TestClock {
  return {
    monotonic: 0,
    wall: Date.parse("2026-08-24T06:00:00.000Z"),
    advance(ms: number) {
      this.monotonic += ms;
      this.wall += ms;
    },
    advanceWallOnly(ms: number) {
      this.wall += ms;
    }
  };
}

function createProbe(clock: TestClock): PhysicalActionCorrelationProbe {
  return new PhysicalActionCorrelationProbe({
    monotonicNow: () => clock.monotonic,
    wallClockNow: () => clock.wall
  });
}

function healthyEvidence(overrides: Partial<ProbeRuntimeEvidence> = {}): ProbeRuntimeEvidence {
  return {
    live: true,
    ready: true,
    state: "CONNECTED",
    browserIsolated: true,
    observedDeviceCount: 213,
    decodedDeviceEventCount: 100,
    uniqueLogicalEventCount: 50,
    duplicateEventCount: 50,
    protocolInvalidFrameCount: 2,
    protocolChangeCount: 0,
    restartCount: 0,
    ...overrides
  };
}

function evidenceAfter(overrides: Partial<ProbeRuntimeEvidence> = {}): ProbeRuntimeEvidence {
  return healthyEvidence(overrides);
}

function newResult(
  key: string,
  event: DeviceEventSummary | null,
  identitySource: "event_id" | "fingerprint" = "event_id"
) {
  return {
    kind: "new" as const,
    key,
    identitySource,
    occurrence: 1,
    event
  };
}

function duplicateResult(
  key: string,
  event: DeviceEventSummary | null,
  occurrence = 2,
  identitySource: "event_id" | "fingerprint" = "event_id"
) {
  return {
    kind: "duplicate" as const,
    key,
    identitySource,
    occurrence,
    event
  };
}

function contactEvent(
  deviceAlias: string,
  value: string,
  stateChange: boolean,
  sourceEventAtMs?: number
): DeviceEventSummary {
  return eventSummary({
    deviceAlias,
    capability: "contactSensor",
    attribute: "contact",
    value,
    stateChange,
    ...(sourceEventAtMs === undefined ? {} : { sourceEventAtMs })
  });
}

function motionEvent(deviceAlias: string, stateChange: boolean): DeviceEventSummary {
  return eventSummary({
    deviceAlias,
    capability: "motionSensor",
    attribute: "motion",
    value: "active",
    stateChange
  });
}

function switchEvent(
  deviceAlias: string,
  value: string,
  stateChange: boolean,
  sourceEventAtMs?: number
): DeviceEventSummary {
  return eventSummary({
    deviceAlias,
    capability: "switch",
    attribute: "switch",
    value,
    stateChange,
    ...(sourceEventAtMs === undefined ? {} : { sourceEventAtMs })
  });
}

function buttonEvent(deviceAlias: string, stateChange: boolean): DeviceEventSummary {
  return eventSummary({
    deviceAlias,
    capability: "button",
    attribute: "button",
    value: "pushed",
    stateChange
  });
}

function eventSummary(options: {
  deviceAlias: string;
  capability: string;
  attribute: string;
  value: string;
  stateChange: boolean;
  sourceEventAtMs?: number;
}): DeviceEventSummary {
  return {
    safe: Object.freeze({
      deviceAlias: options.deviceAlias,
      component: "main",
      capability: options.capability,
      attribute: options.attribute,
      valueType: "string",
      unitPresent: false,
      stateChange: options.stateChange,
      ...(options.sourceEventAtMs === undefined ? {} : { sourceEventAtMs: options.sourceEventAtMs })
    }),
    matchesExpectedValue: (expected) => options.value === expected
  };
}

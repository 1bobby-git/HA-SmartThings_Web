# Physical-Action Correlation Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded, in-memory Phase 1 probe that correlates one safe human physical action with one sanitized, deduplicated SmartThings Web `DEVICE_EVENT` without sending commands or retaining raw values and identifiers.

**Architecture:** Extend the existing protocol analyzer with a non-serializable value matcher plus a safe event summary, feed those results into an isolated `PhysicalActionCorrelationProbe`, and expose only safe arm/status/reset JSON through the existing Bridge HTTP server. Runtime arming is gated on health plus exactly one settled `/location` keeper page; deployment is held until the active 0.1.25 soak is sealed.

**Tech Stack:** Node.js 24, TypeScript 7, Vitest 4, Playwright-core 1.62.1, built-in Node HTTP/crypto/performance APIs, existing Home Assistant add-on and Ingress wiring.

---

## File map

- Create `bridge/src/inspector/device-event-summary.ts`: parse an already-sanitized `DEVICE_EVENT` into safe enumerable metadata plus a closure-based expected-value matcher.
- Create `bridge/src/inspector/physical-action-correlation-probe.ts`: own arm/observe/snapshot/void lifecycle and verdict rules.
- Create `bridge/src/browser/probe-browser-isolation.ts`: prove exactly one non-closed settled keeper page is present.
- Modify `bridge/src/browser/keeper-page.ts`: expose the active keeper identity without exposing its URL through the probe API.
- Modify `bridge/src/inspector/protocol-analyzer.ts`: attach safe summaries and dedupe metadata to new/duplicate results.
- Modify `bridge/src/server/http-server.ts`: add bounded no-store GET/arm/reset endpoints with fixed errors.
- Modify `bridge/src/runtime.ts`: construct and feed the probe, supply runtime/browser prerequisites, and fail active evidence on context reset.
- Add focused tests under `bridge/tests/inspector`, `bridge/tests/browser`, `bridge/tests/server`, and `bridge/tests/runtime.test.ts`.
- Update version surfaces and Phase 1 documents only after behavior is green.

### Task 1: Safe normalized device-event summaries

**Files:**
- Create: `bridge/src/inspector/device-event-summary.ts`
- Test: `bridge/tests/inspector/device-event-summary.test.ts`

- [ ] **Step 1: Write the failing extraction and serialization tests**

Create tests that call the wished-for API:

```ts
import { describe, expect, test } from "vitest";
import { extractDeviceEventSummary } from "../../src/inspector/device-event-summary.js";

function deviceEvent(deviceAlias: string): unknown {
  return {
    data: {
      event_type: "DEVICE_EVENT",
      device_event: {
        device_id: deviceAlias,
        component: "main",
        capability: "contactSensor",
        attribute: "contact",
        value: "open",
        state_change: true
      }
    }
  };
}

describe("extractDeviceEventSummary", () => {
  test("keeps safe semantic metadata and a non-serializable value matcher", () => {
    const summary = extractDeviceEventSummary({
      data: {
        event_type: "DEVICE_EVENT",
        device_event: {
          event_id: "identifier_deadbeef0000",
          device_id: "dev_007",
          component: "main",
          capability: "contactSensor",
          attribute: "contact",
          value: "open",
          unit: null,
          event_time: "2026-08-24T06:00:00.000Z",
          state_change: true
        }
      }
    });

    expect(summary?.safe).toEqual({
      deviceAlias: "dev_007",
      component: "main",
      capability: "contactSensor",
      attribute: "contact",
      valueType: "string",
      unitPresent: false,
      stateChange: true,
      sourceEventAtMs: Date.parse("2026-08-24T06:00:00.000Z")
    });
    expect(summary?.matchesExpectedValue("open")).toBe(true);
    expect(summary?.matchesExpectedValue("closed")).toBe(false);
    expect(JSON.stringify(summary)).not.toMatch(/open|event_id|identifier_deadbeef0000/i);
  });

  test.each(["raw-device-id", "dev_1", "dev_001?token=x"])(
    "rejects unsafe device alias %s",
    (deviceAlias) => {
      expect(extractDeviceEventSummary(deviceEvent(deviceAlias))).toBeNull();
    }
  );
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm test -- bridge/tests/inspector/device-event-summary.test.ts`

Expected: FAIL because `device-event-summary.js` does not exist.

- [ ] **Step 3: Implement the minimal safe extractor**

Implement these public types and function:

```ts
export interface SafeDeviceEventSummary {
  deviceAlias: string;
  component: string;
  capability: string;
  attribute: string;
  valueType: "null" | "boolean" | "number" | "string" | "array" | "object";
  unitPresent: boolean;
  stateChange: boolean | null;
  sourceEventAtMs?: number;
}

export interface DeviceEventSummary {
  safe: Readonly<SafeDeviceEventSummary>;
  matchesExpectedValue(expected: string): boolean;
}

export function extractDeviceEventSummary(input: unknown): DeviceEventSummary | null {
  const delivery = asRecord(input);
  const data = asRecord(delivery?.data);
  const event = asRecord(data?.device_event ?? data?.deviceEvent);
  if (readString(data, "event_type", "eventType") !== "DEVICE_EVENT" || !event) return null;
  const deviceAlias = readString(event, "device_id", "deviceId");
  const component = readToken(event, "component", "componentId");
  const capability = readToken(event, "capability");
  const attribute = readToken(event, "attribute");
  if (!deviceAlias || !/^dev_[0-9]{3,}$/u.test(deviceAlias) || !component || !capability || !attribute) {
    return null;
  }
  const value = event.value;
  const sourceEventAtMs = parseOptionalIso(readString(event, "event_time", "eventTime"));
  const safe: SafeDeviceEventSummary = {
    deviceAlias,
    component,
    capability,
    attribute,
    valueType: valueType(value),
    unitPresent: event.unit !== undefined && event.unit !== null,
    stateChange: readBoolean(event, "state_change", "stateChange"),
    ...(sourceEventAtMs === undefined ? {} : { sourceEventAtMs })
  };
  return Object.freeze({
    safe: Object.freeze(safe),
    matchesExpectedValue: (expected: string) => typeof value === "string" && value === expected
  });
}
```

Keep `asRecord`, `readString`, `readToken`, `readBoolean`, `parseOptionalIso`, and `valueType` private, bounded, and free of logging. `readToken` must accept only `/^[A-Za-z0-9_.:-]{1,128}$/u`; `parseOptionalIso` must accept only a finite `Date.parse` result. Add negative tests for overlong and newline-bearing protocol tokens, a non-string value, and an invalid source timestamp. The internal `sourceEventAtMs` may exist in `safe`, but no public probe snapshot may copy the absolute value.

- [ ] **Step 4: Run the extractor tests and verify GREEN**

Run: `npm test -- bridge/tests/inspector/device-event-summary.test.ts`

Expected: 1 file passes with no warnings.

- [ ] **Step 5: Commit the completed extraction slice**

```powershell
git add bridge/src/inspector/device-event-summary.ts bridge/tests/inspector/device-event-summary.test.ts
git commit -m 'Keep correlation values out of serialized evidence' -m 'Constraint: DEVICE_EVENT values may be compared only inside the Bridge process' -m 'Confidence: high' -m 'Scope-risk: narrow' -m 'Tested: npm test -- bridge/tests/inspector/device-event-summary.test.ts' -m 'Not-tested: Live SmartThings event shape'
```

### Task 2: Protocol analyzer correlation metadata

**Files:**
- Modify: `bridge/src/inspector/protocol-analyzer.ts`
- Modify: `bridge/tests/inspector/protocol-analyzer.test.ts`

- [ ] **Step 1: Write failing analyzer tests for new and duplicate deliveries**

Add assertions that both observer paths return the safe summary. Define a purpose-built switch delivery instead of relying on the existing fine-dust fixture. The analyzer result intentionally retains the internal dedupe key for in-process correlation, so privacy assertions serialize only `result.event`; public-key non-disclosure is tested at the probe and HTTP boundaries:

```ts
const delivery = {
  data: {
    event_type: "DEVICE_EVENT",
    device_event: {
      event_id: "identifier_deadbeef0000",
      device_id: "dev_001",
      component: "main",
      capability: "switch",
      attribute: "switch",
      value: "value_raw",
      state_change: true
    }
  }
};
const first = analyzer.observe(deviceEventRecord(delivery));
const duplicate = analyzer.observe(cdpDeviceEventRecord(delivery));

expect(first).toMatchObject({
  kind: "new",
  key: expect.stringMatching(/^event_id:/),
  identitySource: "event_id",
  occurrence: 1,
  event: { safe: { deviceAlias: "dev_001", capability: "switch", attribute: "switch" } }
});
expect(duplicate).toMatchObject({ kind: "duplicate", occurrence: 2 });
expect(JSON.stringify(first?.kind === "new" ? first.event : null)).not.toMatch(
  /value_raw|event_id|identifier_deadbeef0000/i
);
```

Also add a test where an unsafe device alias returns `event: null` while existing protocol counters still update.

- [ ] **Step 2: Run the analyzer test and verify RED**

Run: `npm test -- bridge/tests/inspector/protocol-analyzer.test.ts`

Expected: FAIL because the result lacks `identitySource` and `event`.

- [ ] **Step 3: Extend only the event result variant**

Change the result union to:

```ts
export type ProtocolAnalysisResult =
  | {
      kind: "new" | "duplicate";
      key: string;
      identitySource: "event_id" | "fingerprint";
      occurrence: number;
      event: DeviceEventSummary | null;
    }
  | { kind: "snapshot"; requestEvent: string; category: SnapshotCategory; count: number }
  | { kind: "protocol_changed"; surface: ProtocolMismatchSurface };
```

After deduplication, call `extractDeviceEventSummary(decoded.args[0])` and return `identitySource: result.source`. Do not change snapshot or mismatch semantics.

- [ ] **Step 4: Run analyzer and dedupe regressions**

Run: `npm test -- bridge/tests/inspector/protocol-analyzer.test.ts bridge/tests/inspector/event-deduplicator.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit the analyzer slice**

```powershell
git add bridge/src/inspector/protocol-analyzer.ts bridge/tests/inspector/protocol-analyzer.test.ts
git commit -m 'Give the Phase 1 probe deduplicated semantic events' -m 'Constraint: Internal dedupe keys stay inside runtime wiring' -m 'Confidence: high' -m 'Scope-risk: narrow' -m 'Tested: protocol analyzer and event deduplicator tests' -m 'Not-tested: Runtime probe integration'
```

### Task 3: In-memory correlation state machine

**Files:**
- Create: `bridge/src/inspector/physical-action-correlation-probe.ts`
- Test: `bridge/tests/inspector/physical-action-correlation-probe.test.ts`

- [ ] **Step 1: Write failing tests for lifecycle and verdicts**

Use injected monotonic and wall clocks. Define concrete helpers in the test file so the example compiles:

```ts
import type { DeviceEventSummary } from "../../src/inspector/device-event-summary.js";
import type { ProbeRuntimeEvidence } from "../../src/inspector/physical-action-correlation-probe.js";

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

function contactEvent(
  deviceAlias: string,
  value: string,
  stateChange: boolean
): DeviceEventSummary {
  return {
    safe: Object.freeze({
      deviceAlias,
      component: "main",
      capability: "contactSensor",
      attribute: "contact",
      valueType: "string",
      unitPresent: false,
      stateChange
    }),
    matchesExpectedValue: (expected) => value === expected
  };
}

let monotonicNow = 0;
let wallClockNow = Date.parse("2026-08-24T06:00:00.000Z");
const probe = new PhysicalActionCorrelationProbe({
  monotonicNow: () => monotonicNow,
  wallClockNow: () => wallClockNow
});
probe.arm({ actionType: "contact_open", windowSeconds: 15 }, healthyEvidence());
monotonicNow += 500;
wallClockNow += 500;
probe.observe({
  kind: "new",
  key: "event_id:identifier_deadbeef0000",
  identitySource: "event_id",
  occurrence: 1,
  event: contactEvent("dev_007", "open", true)
});

monotonicNow += 14_501;
wallClockNow += 14_501;
expect(probe.snapshot(healthyEvidence())).toMatchObject({
  state: "pass",
  actionType: "contact_open",
  candidateCount: 1,
  candidates: [{
    deviceAlias: "dev_007",
    expectedValueMatched: true,
    deliveryCount: 1,
    receiveAfterArmMs: 500
  }]
});
```

Additional tests must prove: result stays `armed` before expiry; duplicate increments `deliveryCount`; two matching logical keys become `ambiguous`; target alias filters candidates; no match becomes `fail`; invalid/protocol/restart/counter/readiness/isolation regression becomes `fail`; 33rd matching logical candidate becomes `fail`; unsafe event summary becomes `fail`; reset while armed and reset after completion each produce `voided`; reset while idle is an idempotent `idle`; a new arm replaces `voided` but conflicts with `armed`. Also prove an event at the deadline is excluded, a wall-clock jump cannot end the window, an unavailable/skewed source timestamp omits `sourceAfterArmMs`, and serialized snapshots contain no absolute timestamp.

- [ ] **Step 2: Run the state-machine test and verify RED**

Run: `npm test -- bridge/tests/inspector/physical-action-correlation-probe.test.ts`

Expected: FAIL because the probe module does not exist.

- [ ] **Step 3: Implement presets, safe output, and fail-closed evaluation**

Define fixed presets and evidence types:

```ts
export const PHYSICAL_ACTION_PRESETS = {
  contact_open: { capability: "contactSensor", attribute: "contact", value: "open", requireStateChange: true },
  contact_close: { capability: "contactSensor", attribute: "contact", value: "closed", requireStateChange: true },
  motion_active: { capability: "motionSensor", attribute: "motion", value: "active", requireStateChange: true },
  switch_manual_on: { capability: "switch", attribute: "switch", value: "on", requireStateChange: true },
  switch_manual_off: { capability: "switch", attribute: "switch", value: "off", requireStateChange: true },
  button_push: { capability: "button", attribute: "button", value: "pushed", requireStateChange: false }
} as const;

export interface ProbeRuntimeEvidence {
  live: boolean;
  ready: boolean;
  state: string;
  browserIsolated: boolean;
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  protocolInvalidFrameCount: number;
  protocolChangeCount: number;
  restartCount: number;
}

export type ProbeState = "idle" | "armed" | "pass" | "ambiguous" | "fail" | "voided";

export type ProbeResultReason =
  | "manual_reset"
  | "no_match"
  | "multiple_candidates"
  | "browser_not_isolated"
  | "runtime_not_ready"
  | "protocol_changed"
  | "runtime_restarted"
  | "invalid_frame_increase"
  | "counter_regression"
  | "unsafe_event"
  | "candidate_overflow"
  | "internal_failure";

export type ProbeFailureReason = Exclude<
  ProbeResultReason,
  "manual_reset" | "no_match" | "multiple_candidates"
>;

export interface ProbeArmRequest {
  actionType: keyof typeof PHYSICAL_ACTION_PRESETS;
  targetDeviceAlias?: string;
  windowSeconds?: number;
}

export interface ProbeCandidateSnapshot {
  deviceAlias: string;
  component: string;
  capability: string;
  attribute: string;
  valueType: SafeDeviceEventSummary["valueType"];
  unitPresent: boolean;
  stateChange: boolean | null;
  expectedValueMatched: boolean;
  identitySource: "event_id" | "fingerprint";
  logicalEventHash: string;
  uniqueLogicalEventCount: 1;
  deliveryCount: number;
  receiveAfterArmMs: number;
  sourceAfterArmMs?: number;
}

export interface ProbeCounterSnapshot {
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  protocolInvalidFrameCount: number;
  protocolChangeCount: number;
  restartCount: number;
}

export interface PhysicalActionProbeSnapshot {
  schemaVersion: 1;
  state: ProbeState;
  actionType?: keyof typeof PHYSICAL_ACTION_PRESETS;
  targetDeviceAlias?: string;
  windowSeconds?: number;
  elapsedMs: number;
  remainingMs: number;
  live: boolean;
  ready: boolean;
  runtimeState: string;
  browserIsolated: boolean;
  baseline?: ProbeCounterSnapshot;
  current: ProbeCounterSnapshot;
  candidateCount: number;
  reasons: ProbeResultReason[];
  candidates: ProbeCandidateSnapshot[];
}
```

Implement `arm`, `observe`, `observeUnsafeEvent`, `recordBrowserIsolation`, `fail`, `reset`, and `snapshot`. `observe` reads the injected monotonic and wall clocks at delivery time; window membership and expiry use only the monotonic clock. Hash the internal dedupe key with full SHA-256 before storing a candidate; do not retain the key after hashing. Build every public snapshot from a fresh allowlisted object. Capture the full baseline evidence at arm, compare all monotonic counters against it at every snapshot, and fail an active probe immediately on browser isolation loss, protocol change, restart, invalid-frame increase, counter regression, readiness loss, non-`CONNECTED` state, or explicit runtime failure. Only preset-matching logical events count toward the 32-candidate limit.

Use this explicit public call contract so the HTTP adapter never parses thrown exception text:

```ts
export type ProbeArmError = "probe_conflict" | "browser_not_isolated" | "not_ready";

export type ProbeArmResult =
  | { ok: true; snapshot: PhysicalActionProbeSnapshot }
  | { ok: false; error: ProbeArmError };

arm(request: ProbeArmRequest, evidence: ProbeRuntimeEvidence): ProbeArmResult;
observe(result: Extract<ProtocolAnalysisResult, { kind: "new" | "duplicate" }>): void;
observeUnsafeEvent(): void;
recordBrowserIsolation(isolated: boolean): void;
fail(reason: ProbeFailureReason): void;
reset(evidence: ProbeRuntimeEvidence): PhysicalActionProbeSnapshot;
snapshot(evidence: ProbeRuntimeEvidence): PhysicalActionProbeSnapshot;
```

`arm` returns `not_ready` unless all non-browser prerequisites in the design are satisfied, `browser_not_isolated` only for the page gate, and `probe_conflict` only while the current state is `armed`. It never throws for an expected domain outcome. `reset` is `idle` when already idle; otherwise it returns a fresh `voided` allowlist with `manual_reset`. `observe` immediately hashes and drops `result.key`. Include `sourceAfterArmMs` only when `sourceEventAtMs >= armWallClockMs` and `sourceEventAtMs <= receiveWallClockMs + 5_000`; otherwise omit it as unavailable.

- [ ] **Step 4: Run the state-machine tests and verify GREEN**

Run: `npm test -- bridge/tests/inspector/physical-action-correlation-probe.test.ts`

Expected: all probe tests pass and serialized snapshots contain none of `event_id:`, `fingerprint:`, raw values, tokens, URLs, or payload text.

- [ ] **Step 5: Commit the state machine**

```powershell
git add bridge/src/inspector/physical-action-correlation-probe.ts bridge/tests/inspector/physical-action-correlation-probe.test.ts
git commit -m 'Make action correlation bounded and fail closed' -m 'Constraint: One in-memory window and at most 32 logical candidates' -m 'Rejected: Permanent event journal | Phase 2 remains closed' -m 'Confidence: high' -m 'Scope-risk: moderate' -m 'Tested: physical-action correlation probe tests' -m 'Not-tested: HTTP and live runtime wiring'
```

### Task 4: Enforce one settled keeper page

**Files:**
- Create: `bridge/src/browser/probe-browser-isolation.ts`
- Create: `bridge/tests/browser/probe-browser-isolation.test.ts`
- Modify: `bridge/src/browser/keeper-page.ts`
- Modify: `bridge/tests/browser/keeper-page.test.ts`

- [ ] **Step 1: Write failing identity and isolation tests**

Add `KeeperPageManager.currentKeeper()` tests and isolation cases. Reuse the existing fake-page shape but provide the extra mutable context helper in the new test file:

```ts
import type { BrowserContextLike, BrowserPageLike } from "../../src/browser/keeper-page.js";

class FakePage implements BrowserPageLike {
  #closed = false;

  constructor(private currentUrl: string) {}

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

class FakeContext implements BrowserContextLike {
  readonly existingPages: FakePage[] = [];

  pages(): FakePage[] {
    return this.existingPages;
  }

  addPage(page: FakePage): void {
    this.existingPages.push(page);
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage("about:blank");
    this.addPage(page);
    return page;
  }
}

const context = new FakeContext();
const keeper = new FakePage("https://my.smartthings.com/location");
context.addPage(keeper);
const manager = new KeeperPageManager(context);
await manager.ensureKeeper();
expect(isProbeBrowserIsolated(context, manager)).toBe(true);
context.addPage(new FakePage("https://my.smartthings.com/advanced"));
expect(isProbeBrowserIsolated(context, manager)).toBe(false);
```

Separate cases must reject login, `about:blank`, device/detail, arbitrary origin, closed keeper, and a different location page object. Tests must assert returned data is boolean only and contains no URL.

- [ ] **Step 2: Run browser tests and verify RED**

Run: `npm test -- bridge/tests/browser/keeper-page.test.ts bridge/tests/browser/probe-browser-isolation.test.ts`

Expected: FAIL because `currentKeeper` and `isProbeBrowserIsolated` do not exist.

- [ ] **Step 3: Add the read-only keeper accessor and isolation function**

```ts
// keeper-page.ts
currentKeeper(): BrowserPageLike | undefined {
  return this.#keeper && !this.#keeper.isClosed() ? this.#keeper : undefined;
}

// probe-browser-isolation.ts
export function isProbeBrowserIsolated(
  context: BrowserContextLike | undefined,
  keeperManager: KeeperPageManager | undefined
): boolean {
  const keeper = keeperManager?.currentKeeper();
  if (!context || !keeper) return false;
  const openPages = context.pages().filter((page) => !page.isClosed());
  return openPages.length === 1 && openPages[0] === keeper && isSettledLocationUrl(keeper.url());
}
```

Keep `isSettledLocationUrl` private and require `https://my.smartthings.com/location` or `/location/<id>` with no search/hash.

- [ ] **Step 4: Run browser tests and verify GREEN**

Run: `npm test -- bridge/tests/browser/keeper-page.test.ts bridge/tests/browser/probe-browser-isolation.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit browser isolation**

```powershell
git add bridge/src/browser/keeper-page.ts bridge/src/browser/probe-browser-isolation.ts bridge/tests/browser/keeper-page.test.ts bridge/tests/browser/probe-browser-isolation.test.ts
git commit -m 'Require an isolated keeper before physical evidence' -m 'Constraint: Probe responses expose only a boolean isolation result' -m 'Confidence: high' -m 'Scope-risk: narrow' -m 'Tested: keeper and probe browser isolation tests' -m 'Not-tested: Runtime page-event wiring'
```

### Task 5: Bounded internal HTTP API

**Files:**
- Modify: `bridge/src/server/http-server.ts`
- Modify: `bridge/tests/server/http-server.test.ts`

- [ ] **Step 1: Write failing route, body-limit, and privacy tests**

Construct a real probe with a fixed evidence callback and prove:

```ts
const arm = await fetch(`${baseUrl}/probe/physical-action/arm`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ actionType: "contact_open", windowSeconds: 60 })
});
expect(arm.status).toBe(201);
expect(await arm.json()).toMatchObject({ state: "armed", actionType: "contact_open" });
expect((await fetch(`${baseUrl}/probe/physical-action`)).status).toBe(200);
```

Add separate tests for malformed JSON, arrays/primitives instead of an object, unknown key, unsupported action, unsafe alias, 14/121-second windows, content-type mismatch, body over 4096 bytes (with and without `content-length`), second arm conflict, unsupported method, and reset-to-voided. Assert response bodies do not echo sent secrets, raw values, aliases from malformed bodies, URLs, headers, `event_id:`, or `fingerprint:`. Assert `GET` does not consume a request body and existing health/status method behavior is unchanged.

- [ ] **Step 2: Run HTTP tests and verify RED**

Run: `npm test -- bridge/tests/server/http-server.test.ts`

Expected: FAIL with 404 for the new routes.

- [ ] **Step 3: Implement probe options and bounded JSON parsing**

Extend `BridgeHttpServerOptions` with:

```ts
physicalActionProbe?: PhysicalActionCorrelationProbe;
getProbeEvidence?: () => ProbeRuntimeEvidence;
```

Handle only the exact probe methods/routes. Make the request handler async behind a single catch that emits the fixed `internal_error` token only when headers have not already been sent. Implement `readJsonBody(request, 4096)` using `for await (const chunk of request)`, pre-reject an oversized valid `content-length`, stop accumulating as soon as the streamed byte limit is crossed, require exactly `application/json` (an optional charset is allowed), require one non-array JSON object, reject unknown keys, and map fixed domain errors to 400/409/413/415. Discard remaining bytes without logging or echoing them. Keep existing health/status routes unchanged and apply the current no-store/nosniff headers to every response.

Use this complete fixed error contract; every error body is exactly `{ "error": "<code>" }` and contains no detail field:

| Code | HTTP status | Produced by |
| --- | ---: | --- |
| `invalid_json` | 400 | JSON parse failure |
| `invalid_body` | 400 | empty body, array, primitive, or invalid field type |
| `unknown_key` | 400 | any property outside the three arm fields |
| `unsupported_action` | 400 | action type outside the fixed preset names |
| `unsafe_target_alias` | 400 | alias outside `^dev_[0-9]{3,}$` |
| `window_out_of_range` | 400 | non-integer or outside 15–120 seconds |
| `browser_not_isolated` | 409 | domain arm rejection for page isolation |
| `probe_conflict` | 409 | arm attempted while already armed |
| `method_not_allowed` | 405 | recognized probe path with another method |
| `body_too_large` | 413 | declared or streamed body exceeds 4096 bytes |
| `content_type_unsupported` | 415 | arm/reset POST without JSON content type |
| `not_ready` | 503 | domain arm rejection for a health/runtime prerequisite |
| `probe_unavailable` | 503 | server constructed without both probe options |
| `internal_error` | 500 | unexpected handler failure before headers are sent |

Return 201 plus the allowlisted snapshot for a successful arm, 200 for GET/reset, and 404/`not_found` for an unknown path. Reset requires JSON content type and exactly an empty JSON object; any property is `unknown_key`.

- [ ] **Step 4: Run HTTP and status-page tests**

Run: `npm test -- bridge/tests/server/http-server.test.ts bridge/tests/server/status-page.test.ts`

Expected: both files pass with no response leakage.

- [ ] **Step 5: Commit the HTTP surface**

```powershell
git add bridge/src/server/http-server.ts bridge/tests/server/http-server.test.ts
git commit -m 'Expose only bounded physical-probe controls' -m 'Constraint: Existing Ingress is the only access boundary and request bodies are never logged' -m 'Confidence: high' -m 'Scope-risk: moderate' -m 'Tested: HTTP server and status-page tests' -m 'Not-tested: Live Ingress routing'
```

### Task 6: Runtime integration and reset safety

**Files:**
- Modify: `bridge/src/runtime.ts`
- Modify: `bridge/tests/runtime.test.ts`

- [ ] **Step 1: Write failing runtime integration tests**

Using existing fake contexts and sanitized Socket.IO helpers, add concrete calls through the real runtime HTTP server and prove:

1. `POST /probe/physical-action/arm` with one keeper returns 201/`armed`, while keeper plus `/advanced` returns 409/`browser_not_isolated`;
2. after arming, a new Playwright delivery plus duplicate CDP delivery and an expired clock becomes one candidate with two deliveries from `GET /probe/physical-action`;
3. an unsafe normalized event fails an armed probe without logging event content;
4. context close invokes the pipeline reset path and leaves `GET` in fixed `fail`/`runtime_restarted` evidence until reset;
5. opening an extra page during an armed window records `browser_not_isolated` even if it later closes;
6. runtime logs contain only fixed tokens and never aliases, values, event summaries, URLs, headers, request bodies, or payloads.

Use the existing `FakeContext.emit`, real server port, and synthetic sanitized-frame helpers. Inject probe clocks through a new optional internal runtime dependency only if the tests cannot deterministically cross the deadline; do not add a production route or timer just for tests.

- [ ] **Step 2: Run the runtime tests and verify RED**

Run: `npm test -- bridge/tests/runtime.test.ts`

Expected: FAIL because the runtime does not construct or feed the probe.

- [ ] **Step 3: Wire the probe without changing SmartThings traffic**

In `createBridgeRuntime`, declare the context/keeper references and construct the probe before starting the HTTP server so its callback closes over initialized variables:

```ts
const physicalActionProbe = new PhysicalActionCorrelationProbe();
let currentContext: ObservableContext | undefined;
let currentKeeperManager: KeeperPageManager | undefined;
const getProbeEvidence = () => probeEvidenceFrom(
  createHealthReport(status.getSnapshot()),
  isProbeBrowserIsolated(currentContext, currentKeeperManager)
);

function probeEvidenceFrom(
  report: HealthReport,
  browserIsolated: boolean
): ProbeRuntimeEvidence {
  return {
    live: report.live,
    ready: report.ready,
    state: report.details.state,
    browserIsolated,
    observedDeviceCount: report.details.observedDeviceCount,
    decodedDeviceEventCount: report.details.decodedDeviceEventCount,
    uniqueLogicalEventCount: report.details.uniqueLogicalEventCount,
    duplicateEventCount: report.details.duplicateEventCount,
    protocolInvalidFrameCount: report.details.protocolInvalidFrameCount,
    protocolChangeCount: report.details.protocolChangeCount,
    restartCount: report.details.restartCount
  };
}
```

Pass the probe and evidence callback to the HTTP server. Pass the probe into `createStatusCapturePipeline`; for only `new`/`duplicate` event results call `observe` when `event` is present and `observeUnsafeEvent` otherwise. Before analyzer reset, call `physicalActionProbe.fail("runtime_restarted")`. Pass a fixed page-open callback into `attachContext`; on every new page event, re-evaluate the same context/manager identity and call `recordBrowserIsolation(false)` when it fails. The HTTP evidence adapter must copy only the exact `ProbeRuntimeEvidence` fields from health/status and the isolation boolean. Do not add routes, page clicks, SmartThings requests, WebSocket clients, or persistence.

- [ ] **Step 4: Run focused runtime and protocol tests**

Run: `npm test -- bridge/tests/runtime.test.ts bridge/tests/inspector/protocol-analyzer.test.ts bridge/tests/server/http-server.test.ts`

Expected: all focused files pass.

- [ ] **Step 5: Commit runtime integration**

```powershell
git add bridge/src/runtime.ts bridge/tests/runtime.test.ts
git commit -m 'Correlate only events from the existing browser pipeline' -m 'Constraint: No browser input, SmartThings request, or new persistence is allowed' -m 'Confidence: high' -m 'Scope-risk: moderate' -m 'Tested: runtime, protocol analyzer, and HTTP tests' -m 'Not-tested: Updated HAOS add-on deployment or physical action'
```

### Task 7: Version, documentation, packaging, and deployment hold

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `protocol/version.json`
- Modify: `addon/smartthings_web_bridge/config.yaml`
- Modify: `addon/smartthings_web_bridge/CHANGELOG.md`
- Modify: `bridge/src/runtime.ts`
- Modify: `README.md`
- Modify: `MANUAL_TEST.md`
- Modify: `docs/feasibility-report.md`
- Modify: `docs/protocol-report.md`
- Modify: `docs/session-behavior.md`
- Modify: `tests/documentation-gate.test.ts`
- Modify: `tests/protocol-version-contract.test.ts`

- [ ] **Step 1: Write failing version and documentation assertions**

Require only the Bridge/add-on/package version surfaces to equal `0.1.26`: `package.json.version`, the root and root-package versions in `package-lock.json`, `protocol/version.json.bridge_version`, `addon/smartthings_web_bridge/config.yaml` `version`, and `bridge/src/runtime.ts` `bridgeVersion`. Keep `protocol/version.json.protocol_version` at `1` because the observed SmartThings protocol contract is unchanged; do not modify Playwright, Chromium, or Node version metadata. Require docs to state: probe implemented but not yet deployed; physical action remains unverified; 0.1.25 soak must finish before update; `DECISION: LIMITED`; no command/DOM/API/entity/event-journal scope. Add explicit assertions for those exact facts to the existing version/documentation tests rather than relying on prose inspection.

- [ ] **Step 2: Run version/documentation tests and verify RED**

Run: `npm test -- tests/protocol-version-contract.test.ts tests/documentation-gate.test.ts`

Expected: FAIL because current version is `0.1.25` and the implementation status text is absent.

- [ ] **Step 3: Update version surfaces and honest docs**

Set the package/add-on/runtime version to `0.1.26`. Add changelog entries for safe presets, in-memory-only evidence, browser isolation, dedupe-aware candidates, and fixed error responses. Do not claim live correlation or deploy completion.

- [ ] **Step 4: Run the complete local verification matrix**

Run sequentially:

```powershell
npm test -- --maxWorkers=1
npm run typecheck
npm run build
npm run audit:api-free
npm run audit:secrets
npm run audit:fixtures
npm run protocol:replay
npm run snapshot:replay
npm audit --audit-level=moderate
npm run package:addon
git diff --check
```

Expected: 0 failures; API/secret/fixture audits silent; protocol replay remains 1 logical event from 3 deliveries; snapshot replay remains 6/6 complete; dependency audit reports 0 vulnerabilities; package manifest verifies.

- [ ] **Step 5: Run independent privacy and scope review**

Search the changed production paths for direct SmartThings API strings, DOM state scraping, browser click/fill/evaluate calls, persistent event tables/files, raw values, raw IDs, event key prefixes, and unsafe logging. Reviewer must return no critical/high finding before publication.

- [ ] **Step 6: Commit and push the packaged-but-not-deployed candidate**

```powershell
git add -A
git commit -m 'Prepare one safe physical-action proof without opening Phase 2' -m 'Constraint: HAOS deployment waits for the active 0.1.25 72-hour soak to finish' -m 'Rejected: Commands, DOM state, direct SmartThings APIs, entities, or a permanent event journal | outside Phase 1' -m 'Confidence: high' -m 'Scope-risk: moderate' -m 'Directive: Do not claim physical correlation until a real user action produces a unique passing result' -m 'Tested: full tests, typecheck, build, audits, replays, dependency audit, add-on packaging' -m 'Not-tested: HAOS 0.1.26 deployment and real physical action'
git push origin main
```

- [ ] **Step 7: Verify publication and preserve the deployment hold**

Confirm local HEAD, `git ls-remote`, and GitHub API SHA match; confirm repository remains private and the worktree is clean. Re-read the external 0.1.25 soak `status.json`. Do not copy or install 0.1.26 while that run is `pending`; the next deployment task begins only after its final summary and SHA are sealed.

## Execution decision

The user has a standing instruction to choose the recommended option. Execute this plan with **subagent-driven development**, one task at a time with implementation review and specification review between tasks. Keep the active soak monitor independent and do not deploy or request a physical action during Tasks 1–7.

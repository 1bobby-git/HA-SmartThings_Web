# Semantic Protocol Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a privacy-safe semantic protocol fingerprint and fail readiness closed only when known SmartThings snapshot or DEVICE_EVENT contracts become incompatible.

**Architecture:** `ProtocolAnalyzer` emits semantic surfaces and explicit incompatibilities. A small atomic JSON store persists the baseline/current fingerprint and mismatch count under `/data`; runtime maps incompatibility to the existing `PROTOCOL_CHANGED` state, and the existing status page renders a clear safe warning.

**Tech Stack:** Node.js 24 filesystem/crypto, TypeScript 7, Vitest 4, existing Socket.IO decoder/runtime health stack.

---

### Task 1: Create the required private data files

**Files:**
- Modify: `bridge/src/security/data-paths.ts`
- Modify: `bridge/tests/security/data-paths.test.ts`

- [ ] **Step 1: Write failing path and permission assertions**

Require:

```ts
expect(paths.protocolFingerprintPath).toBe(join(root, "protocol-fingerprint.json"));
expect(paths.settingsPath).toBe(join(root, "settings.json"));
expect(JSON.parse(readFileSync(paths.settingsPath, "utf8"))).toEqual({ schema_version: 1 });
expect(JSON.parse(readFileSync(paths.protocolFingerprintPath, "utf8"))).toEqual({
  schema_version: 1,
  protocol_contract_version: 1,
  baseline: null,
  current: null,
  change_count: 0,
  last_mismatch: null
});
expect(mode(paths.settingsPath)).toBe(0o600);
expect(mode(paths.protocolFingerprintPath)).toBe(0o600);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run bridge/tests/security/data-paths.test.ts`

Expected: FAIL because the two paths do not exist.

- [ ] **Step 3: Implement create-if-missing bootstrap**

Extend `BridgeDataPaths`, write the exact defaults with `flag:"wx"`, and always reapply `0600`. Existing files must never be truncated.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npx vitest run bridge/tests/security/data-paths.test.ts`

Expected: PASS.

### Task 2: Make generic shape hashing stable for arrays

**Files:**
- Modify: `bridge/src/inspector/protocol-fingerprint.ts`
- Create: `bridge/tests/inspector/protocol-fingerprint.test.ts`

- [ ] **Step 1: Write failing shape-hash tests**

Require object key ordering, array ordering, and duplicate array member counts not to affect the digest, while a required key removal does:

```ts
expect(protocolFingerprint([{ id: "a", state: true }, { id: "b", state: false }]))
  .toBe(protocolFingerprint([{ state: false, id: "c" }]));
expect(protocolFingerprint([{ id: "a" }]))
  .not.toBe(protocolFingerprint([{ id: "a", state: true }]));
```

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run bridge/tests/inspector/protocol-fingerprint.test.ts`

Expected: FAIL because arrays currently preserve order and count.

- [ ] **Step 3: Implement unique sorted member shapes**

Represent arrays as:

```ts
{ arrayOf: [...new Set(value.map((item) => stableString(shapeOf(item))))].sort() }
```

Primitive values remain represented only by their type.

- [ ] **Step 4: Run and confirm GREEN**

Run: `npx vitest run bridge/tests/inspector/protocol-fingerprint.test.ts`

Expected: PASS.

### Task 3: Make known snapshot incompatibility explicit

**Files:**
- Modify: `bridge/src/inspector/snapshot-detector.ts`
- Modify: `bridge/tests/inspector/snapshot-detector.test.ts`

- [ ] **Step 1: Write failing mismatch tests**

Change the desired result contract to:

```ts
type SnapshotObservation =
  | { kind: "snapshot"; requestEvent: string; category: SnapshotCategory; count: number }
  | { kind: "protocol_changed"; surface: `snapshot:${SnapshotCategory}:response_shape` }
  | null;
```

Assert that a recognized `api/room` ACK with a location-shaped response produces `protocol_changed`, while an unknown `get` ACK still returns null.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run bridge/tests/inspector/snapshot-detector.test.ts`

Expected: FAIL because known shape mismatches currently return null.

- [ ] **Step 3: Return a safe mismatch surface**

After a pending recognized request is consumed, return `protocol_changed` when classification is null or conflicts with the request hint. Never include raw ACK arguments.

- [ ] **Step 4: Update successful snapshot expectations and run GREEN**

Run: `npx vitest run bridge/tests/inspector/snapshot-detector.test.ts`

Expected: all snapshot tests pass.

### Task 4: Track semantic surfaces in ProtocolAnalyzer

**Files:**
- Modify: `bridge/src/inspector/protocol-analyzer.ts`
- Modify: `bridge/tests/inspector/protocol-analyzer.test.ts`

- [ ] **Step 1: Write failing semantic-completion tests**

Require analyzer snapshots to expose:

```ts
protocolComplete: boolean;
protocolFingerprint?: string;
protocolMismatchCount: number;
protocolMismatchSurface?: string;
```

Replay all six snapshot categories and one valid DEVICE_EVENT. Expect exactly seven sorted semantic surfaces, a complete fingerprint, and zero mismatches.

- [ ] **Step 2: Write failing known-event incompatibility test**

Feed `api/subscription DEVICE_EVENT` with an object that lacks an extractable identity. Expect:

```ts
{ kind: "protocol_changed", surface: "event:device_event:identity" }
```

Unrelated events must remain null.

- [ ] **Step 3: Run and confirm RED**

Run: `npx vitest run bridge/tests/inspector/protocol-analyzer.test.ts`

Expected: FAIL on the new result/snapshot fields.

- [ ] **Step 4: Implement surface tracking**

Add fixed surfaces for successful snapshot categories and valid DEVICE_EVENT. Compute the digest only when all seven are present. Clear epoch surfaces and mismatch fields in `reset()`.

- [ ] **Step 5: Run and confirm GREEN**

Run: `npx vitest run bridge/tests/inspector/protocol-analyzer.test.ts`

Expected: PASS.

### Task 5: Persist the semantic baseline atomically

**Files:**
- Create: `bridge/src/state/protocol-integrity-store.ts`
- Create: `bridge/tests/state/protocol-integrity-store.test.ts`

- [ ] **Step 1: Write failing first-baseline, match, mismatch, and corruption tests**

Use the wished-for API:

```ts
const store = new ProtocolIntegrityStore(path, { contractVersion: 1, now: () => 1000 });
expect(store.observeCompleteFingerprint("sha256:aaa")).toMatchObject({ compatible: true });
expect(store.observeCompleteFingerprint("sha256:aaa")).toMatchObject({ compatible: true });
expect(store.observeCompleteFingerprint("sha256:bbb")).toMatchObject({ compatible: false, changeCount: 1 });
expect(store.recordMismatch("snapshot:rooms:response_shape")).toMatchObject({ changeCount: 2 });
```

Also assert repeated identical mismatch keys do not increment again and corrupt JSON throws a fixed-category error without including file content.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run bridge/tests/state/protocol-integrity-store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement schema validation and atomic writes**

Write to `${path}.tmp`, set `0600`, close it, then rename over the target. Store only version, digests, counts, timestamps, and a safe mismatch surface.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npx vitest run bridge/tests/state/protocol-integrity-store.test.ts`

Expected: PASS.

### Task 6: Integrate fail-closed state and warning UI

**Files:**
- Modify: `bridge/src/runtime.ts`
- Modify: `bridge/tests/runtime.test.ts`
- Modify: `bridge/src/server/status-page.ts`
- Create: `bridge/tests/server/status-page.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Require a fixture-complete epoch to persist a fingerprint and set `protocolVersion` to `1:<16 hex>`. Require a known incompatible ACK to set:

```ts
{
  state: "PROTOCOL_CHANGED",
  parserHealthy: false,
  protocolChangeCount: 1
}
```

Then assert `createHealthReport(...).ready === false` while liveness remains true.

- [ ] **Step 2: Write failing status-page tests**

Require visible text for compatible, discovering, and changed states. Assert the HTML never includes a supplied raw URL, token-like string, identifier, or payload.

- [ ] **Step 3: Run and confirm RED**

Run:

```text
npx vitest run bridge/tests/runtime.test.ts bridge/tests/server/status-page.test.ts
```

Expected: FAIL because runtime/store/UI integration is absent.

- [ ] **Step 4: Wire the store into `createBridgeRuntime` and the capture pipeline**

Create the store from `paths.protocolFingerprintPath`. On complete fingerprints call `observeCompleteFingerprint`. On `protocol_changed` call `recordMismatch`, set `PROTOCOL_CHANGED`, and return before any healthy/connected update can overwrite it.

- [ ] **Step 5: Render the safe protocol evidence panel**

Use only `state`, `protocolVersion`, `protocolChangeCount`, `protocolInvalidFrameCount`, `parserHealthy`, and `ready` to render the warning.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```text
npx vitest run bridge/tests/runtime.test.ts bridge/tests/server/status-page.test.ts
```

Expected: PASS.

### Task 7: Document, package, and verify the finished gate

**Files:**
- Modify: `README.md`
- Modify: `docs/protocol-report.md`
- Modify: `docs/session-behavior.md`
- Modify: `docs/security.md`
- Modify: `MANUAL_TEST.md`
- Modify: `tests/documentation-gate.test.ts`
- Modify after runtime evidence: `protocol/fixtures/2026-08-20-addon-smoke-summary.json`
- Modify after runtime evidence: adjacent SHA-256 file

- [ ] **Step 1: Add failing documentation assertions**

Require the two `/data` files, semantic fail-closed policy, recovery via reviewed protocol-version bump, and explicit continued `LIMITED` decision.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run tests/documentation-gate.test.ts`

Expected: FAIL on missing integrity documentation.

- [ ] **Step 3: Update documentation without opening Phase 2**

State exactly what is persisted, what triggers a block, what does not trigger a block, and what remains unverified.

- [ ] **Step 4: Generate and build the self-contained add-on package**

Run `npm run package:addon`, then build using only `dist-addon/smartthings_web_bridge` as context.

- [ ] **Step 5: Run full verification**

Run:

```text
npm test
npm run typecheck
npm run build
npm run audit:api-free
npm run audit:secrets
npm run protocol:replay
npm run snapshot:replay
git diff --check
```

Expected: all pass, fixture hashes match, and docs still end with `DECISION: LIMITED`.

## Self-review

- The blocking decision uses semantic compatibility, not raw or inventory-sensitive shape hashes.
- Unknown unrelated traffic cannot trigger a mismatch.
- Persistent JSON contains no payloads, identifiers, URLs, or secrets.
- Liveness remains available during protocol failure; readiness fails closed.
- Recovery requires a reviewed numeric protocol contract version bump.
- No Phase 2 entity, WebSocket pairing, or command code is introduced.
- Git commit/push steps are intentionally omitted because current repository instructions require explicit Git authorization.

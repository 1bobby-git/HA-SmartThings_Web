# Complete SmartThings Web Live Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the observed switch, refresh-button, and scene false-failure paths without weakening SmartThings Web safety, deploy the next release, prove the realtime Bridge-to-Home-Assistant chain, and start the remaining 72-hour durability gate.

**Architecture:** Keep state-changing controls fail-closed on exact observed controls plus post-command SmartThings state. Refine bounded detail discovery so unrelated controls do not hide a missing primary toggle. For stateless Refresh and an already-satisfied scene, require the exact web action followed by one bounded authoritative post-command device snapshot; never treat a bare dispatcher ACK as confirmation. Keep Bridge confirmation below the Home Assistant client timeout and make the ingress proxy timeout explicit.

**Tech Stack:** TypeScript, Vitest, Python 3.11, Home Assistant custom integration, Playwright-backed headed Chromium, Socket.IO/SSE, nginx, HAOS add-on packaging.

---

### Task 1: Make detail discovery aware of missing primary toggles

**Files:**
- Modify: `bridge/src/browser/device-detail-discovery.ts`
- Test: `bridge/tests/browser/device-detail-discovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Add one inventory fixture containing a pushed primary `switch` state plus an unrelated non-refresh button, and another fixture with the same state plus an exact matching toggle. Add tests with this contract:

```ts
test("keeps the bounded detail sweep active when a primary switch lacks its exact toggle", async () => {
  const inspectDeviceDetails = vi.fn(async () => undefined);
  const discovery = new DeviceDetailDiscovery({
    inventory: () => switchWithUnrelatedButtonInventory(),
    inspector: { inspectDeviceDetails },
    canInspect: () => true,
    maxAttempts: 2
  });

  expect(await discovery.runOne()).toBe("inspected");
  expect(await discovery.runOne()).toBe("inspected");
  expect(await discovery.runOne()).toBe("idle");
  expect(inspectDeviceDetails).toHaveBeenCalledTimes(2);
});

test("stops inspecting once every pushed primary switch has an exact toggle", async () => {
  const inspectDeviceDetails = vi.fn(async () => undefined);
  const discovery = new DeviceDetailDiscovery({
    inventory: () => switchWithExactToggleInventory(),
    inspector: { inspectDeviceDetails },
    canInspect: () => true
  });

  expect(await discovery.runOne()).toBe("inspected");
  expect(await discovery.runOne()).toBe("idle");
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npx vitest run bridge/tests/browser/device-detail-discovery.test.ts --fileParallelism=false
```

Expected: the unrelated-button case stops after one inspection instead of using both bounded attempts.

- [ ] **Step 3: Implement exact primary-toggle completion**

Replace the generic completion predicate with a predicate that also checks each pushed `attribute === "switch"` state:

```ts
function hasExactPrimaryToggle(device: BridgeDevice): boolean {
  const controls = device.controls ?? [];
  return device.states
    .filter((state) => state.attribute === "switch")
    .every((state) => {
      const matches = controls.filter(
        (control) =>
          control.kind === "toggle" &&
          control.component === state.component &&
          control.capability === state.capability &&
          control.attribute === state.attribute
      );
      const actionMatches = matches.filter((control) => control.id.startsWith("action:"));
      return matches.length === 1 || (matches.length > 1 && actionMatches.length === 1);
    });
}

function discoveryComplete(device: BridgeDevice): boolean {
  return hasActionableControl(device) && hasExactPrimaryToggle(device);
}
```

Use `discoveryComplete(device)` only for post-first-attempt completion. Keep the existing `maxAttempts`, preemption handling, refresh/camera priorities, and dangerous-control enforcement unchanged.

- [ ] **Step 4: Verify GREEN and regressions**

```powershell
npx vitest run bridge/tests/browser/device-detail-discovery.test.ts bridge/tests/runtime.test.ts --fileParallelism=false
npm run typecheck
```

- [ ] **Step 5: Commit with Lore trailers**

Commit only the two task files.

---

### Task 2: Confirm stateless Refresh only from a post-command authoritative snapshot

**Files:**
- Modify: `bridge/src/command/command-service.ts`
- Modify: `bridge/src/runtime.ts`
- Test: `bridge/tests/command/command-service.test.ts`
- Test: `bridge/tests/runtime.test.ts`

- [ ] **Step 1: Lock the current failure with a RED test**

Add a test where a safe observed Refresh button dispatch succeeds, no state event arrives, and `resync()` succeeds with the target device still present. Desired behavior:

```ts
test("confirms refresh from the bounded post-command authoritative snapshot", async () => {
  const store = readyRefreshDeviceStore();
  const resync = vi.fn(async () => ({ observed: true }));
  const service = new SafeCommandService({
    devices: store,
    status: connectedStatus(),
    executor: { executeDeviceAction: vi.fn(async () => undefined) },
    timeoutMs: 50,
    resyncAfterMs: 0,
    resync
  });

  await expect(service.execute(refreshCommand())).resolves.toMatchObject({
    status: "confirmed",
    confirmation: "inventory_snapshot"
  });
  expect(resync).toHaveBeenCalledTimes(1);
});
```

Also add tests proving:

- a generic non-refresh `press` still times out without a newer repeated button/state event;
- `on`, `off`, sliders, media, covers, and options never use this stateless snapshot policy;
- a failed/unavailable resync still yields `command_confirmation_timeout`;
- executor failure still yields `command_execution_failed`.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run bridge/tests/command/command-service.test.ts --fileParallelism=false
```

Expected: Refresh has no snapshot-only confirmation path.

- [ ] **Step 3: Return explicit snapshot evidence from the runtime resync**

Change the command resync dependency from `Promise<unknown>` to an explicit non-secret result:

```ts
interface CommandResyncEvidence {
  authoritativeSnapshot: boolean;
}
```

After `fetchAdvancedDeviceSnapshots()` returns at least one same-origin snapshot and every snapshot has been processed by `DeviceStore`, return `{ authoritativeSnapshot: true }`. Preserve the current failure behavior when no snapshot is available.

- [ ] **Step 4: Add a Refresh-only waiter**

Keep `press` on `waitForAnyDeviceEvent()`. For exact `command === "refresh"`, use a waiter that accepts either a newer state event for the same device or successful authoritative post-command resync. Do not resolve from the native dispatcher ACK alone.

The snapshot path must run only after `executeDeviceAction()` returns and must report `confirmation: "inventory_snapshot"`. It must not mutate DeviceStore state or Home Assistant state optimistically.

- [ ] **Step 5: Verify GREEN and state-changing regressions**

```powershell
npx vitest run bridge/tests/command/command-service.test.ts bridge/tests/runtime.test.ts bridge/tests/server/http-server.test.ts --fileParallelism=false
npm run typecheck
```

- [ ] **Step 6: Commit with Lore trailers**

Commit only the command/runtime files and tests.

---

### Task 3: Confirm already-satisfied scenes after execution and align proxy timeouts

**Files:**
- Modify: `bridge/src/command/command-service.ts`
- Modify: `addon/smartthings_web_bridge/rootfs/etc/nginx/nginx.conf`
- Test: `bridge/tests/command/command-service.test.ts`
- Test: `tests/addon-config.test.ts`

- [ ] **Step 1: Add scene RED tests**

Add a test where all expected states match before activation. The exact scene must still execute once. After executor completion, one authoritative resync must occur; if the post-command snapshot still matches every expected state, return `confirmed` with `inventory_snapshot` without waiting for a newer sequence.

```ts
test("confirms an already-satisfied scene only after execution and authoritative resync", async () => {
  const executeScene = vi.fn(async () => undefined);
  const resync = vi.fn(async () => ({ authoritativeSnapshot: true }));
  const service = sceneService({ executeScene, resync, alreadySatisfied: true });

  await expect(service.execute(sceneCommand())).resolves.toMatchObject({
    status: "confirmed",
    confirmation: "inventory_snapshot"
  });
  expect(executeScene).toHaveBeenCalledTimes(1);
  expect(resync).toHaveBeenCalledTimes(1);
});
```

Add companion tests proving:

- if any expected state is not satisfied after resync, the normal newer-event waiter remains active;
- executor failure cancels confirmation and no success is returned;
- scenes without parsed expected states remain fail-closed;
- unrelated same-location traffic cannot confirm a scene.

- [ ] **Step 2: Verify scene RED**

```powershell
npx vitest run bridge/tests/command/command-service.test.ts --fileParallelism=false
```

- [ ] **Step 3: Implement post-execution snapshot validation**

Extract a pure helper that checks every `BridgeSceneExpectedState` against one `BridgeInventory`. In `#executeScene()`:

1. record whether the pre-action snapshot already satisfies all expected states;
2. subscribe before interaction as today;
3. execute the exact scene once;
4. when pre-satisfied, run one authoritative resync and re-check the current snapshot;
5. return `confirmed(..., "inventory_snapshot")` only when that post-command snapshot matches;
6. otherwise start the existing 30-second event/snapshot timeout path.

- [ ] **Step 4: Add explicit ingress timeouts**

The Bridge confirmation timeout is 30 seconds and the HA client timeout is 90 seconds. Set explicit nginx proxy read/send timeouts to 85 seconds in both Bridge proxy locations:

```nginx
proxy_read_timeout 85s;
proxy_send_timeout 85s;
```

Do not alter noVNC websocket locations.

Add assertions in `tests/addon-config.test.ts` that both Bridge proxy blocks contain the explicit timeout and that the value remains below the HA client's 90-second request boundary.

- [ ] **Step 5: Verify GREEN**

```powershell
npx vitest run bridge/tests/command/command-service.test.ts tests/addon-config.test.ts --fileParallelism=false
npm run typecheck
```

- [ ] **Step 6: Commit with Lore trailers**

Commit only scene/timeout files and tests.

---

### Task 4: Release, deploy, and prove immediate live behavior

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `protocol/version.json`
- Modify: `bridge/src/runtime.ts`
- Modify: `addon/smartthings_web_bridge/config.yaml`
- Modify: `custom_components/smartthings_web/manifest.json`
- Modify: `addon/smartthings_web_bridge/CHANGELOG.md`
- Modify: `tests/addon-config.test.ts`
- Modify: `tests/protocol-version-contract.test.ts`
- Update: `docs/my-smartthings-actual-behavior.md`
- Update: `docs/feasibility-report.md`

- [x] **Step 1: Bump every release surface to 0.1.138, then prepare the restart parser repair as 0.1.139 and the restored-pruning repair as 0.1.140**

Add a changelog entry covering exact-primary-toggle discovery, Refresh post-snapshot confirmation, scene post-snapshot confirmation, and explicit ingress timeouts. Keep the API-free/cookie-free safety statement.

Live 0.1.138 restart testing exposed one additional observed-shape gap: `api/device/status` can report plural `actions` with `commands` or `supportedCommands` lists. Preserve only observed on/off switch commands from that shape and package the repair as 0.1.139 so deployment evidence remains version-exact.

Live 0.1.139 restart testing reached live, ready, `CONNECTED` operation, but the immediate post-restart status response covered 206 IDs and omitted the safe target; the restored target device remained present without controls. Package the follow-up as 0.1.140: defer restored-device pruning until both complete consumer and exact whole Advanced snapshots agree inside the same epoch, preserve restored exact controls when the consumer snapshot omits a device still present in Advanced, preserve actual fallback URLs, and reset epoch flags.

- [x] **Step 2: Run the complete local gate**

```powershell
npm test
python -m unittest discover -s custom_components\smartthings_web\tests
npm run typecheck
npm run build
npm run audit:api-free
npm run audit:secrets
npm run audit:fixtures
npm run package:addon
git diff --check
```

- [x] **Step 3: Run spec and code-quality reviews**

Use a fresh spec-compliance reviewer, then a fresh code-quality reviewer. Resolve every important finding and re-run targeted/full tests.

Fresh independent spec and code-quality reviews approved the 0.1.139 parser and release diff. The complete 0.1.139 local gate passed with 766 JavaScript tests and 207 Home Assistant tests. The 0.1.140 release-preparation gate passed with 775 JavaScript tests, 207 Home Assistant tests, typecheck, build, API-free audit, secret scan, fixture audit, add-on packaging, and diff check.

- [ ] **Step 4: Merge to main, push, and deploy with backup**

Fast-forward `main` only after the worktree is clean and reviewed. HAOS currently has 0.1.139 installed. Back up `/addons/smartthings_web_bridge` under `/config/.smartthings_web_backups/`, install 0.1.140, rebuild, and verify the running package version and source hash.

- [ ] **Step 5: Verify realtime and command behavior on HAOS**

Required immediate evidence:

- `live=true`, `ready=true`, `state=CONNECTED`, `urlCategory=smartthings_location`;
- actual noVNC SmartThings dashboard remains logged in;
- exact target switch inventory now contains one acceptable toggle or one unique `action:` alias;
- safe allowlisted switch proof completes with final OFF using an SSE subscription anchored before the command, newer Bridge inventory timestamps, newer HA `last_updated`, and a monotonic observed sequence;
- Refresh button returns confirmed from post-command authoritative snapshot when no state delta occurs;
- one safe, exact scene executes without a frontend `connection lost` only when its complete action set is proven non-security and non-dangerous; otherwise record the exact safety gate instead of actuating it;
- a Bridge/add-on restart repopulates the full inventory and later state updates reach HA `last_updated`.

Do not execute lock, door, garage, valve, security-arm, or broad 60+ action scenes as test targets.

- [ ] **Step 6: Commit live evidence documentation**

Record only sanitized aggregate timings, sequence evidence, versions, and target class. Do not commit raw IDs, cookies, tokens, screenshots containing account details, or command payloads.

---

### Task 5: Start and monitor the remaining 72-hour durability gate

**Files:**
- No repository source change unless verification uncovers a bug.
- Runtime artifacts: `/data/soak/20260831-0.1.140-72h`

- [ ] **Step 1: Check for an existing collector**

Inside the HAOS add-on host, verify there is no live `haos-soak.js` process and no other active run directory. Do not remove a live lock.

- [ ] **Step 2: Start the local collector after all control tests finish**

```sh
node dist/tools/haos-soak.js --local-bridge \
  --duration-hours 72 \
  --interval-seconds 300 \
  --output-dir /data/soak/20260831-0.1.140-72h
```

Run it detached without restarting the add-on. Confirm `run.json`, `status.json`, `.collector.lock`, and the first successful sample. If the add-on restarts, resume only the same directory with the same arguments.

- [ ] **Step 3: Seal and evaluate after 72 hours**

Require at least 865 successful samples, no failures, stable inventory, non-regressing sequences/counters, acceptable gaps/memory growth, `final-summary.json`, and matching `final-summary.json.sha256`.

```sh
node dist/tools/haos-soak-deployment-gate.js \
  --run-dir /data/soak/20260831-0.1.140-72h
```

- [ ] **Step 4: Report the proof boundary**

Only a sealed passing run proves long-idle durability. Immediate functional completion and a running collector must not be reported as a completed 72-hour gate.

---

## Self-review

- Every observed user error maps to a task and a live acceptance check.
- State-changing actions still require exact SmartThings state evidence.
- Bare native ACKs do not count as success.
- Discovery remains bounded and dangerous controls remain excluded.
- The 72-hour gate is explicitly separated from immediate functional completion.
- No placeholder/TODO steps remain.

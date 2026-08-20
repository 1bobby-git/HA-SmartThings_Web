# SmartThings Web Bridge Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a tested Phase 1 add-on and standalone inspector that keeps a manually authenticated headed SmartThings Web Chromium session alive and records only sanitized, read-only network evidence.

**Architecture:** A TypeScript bridge owns Playwright persistent Chromium, one keeper page, read-only BrowserContext/CDP observers, centralized HMAC/SQLite pseudonymization, and built-in HTTP health/status endpoints. An Ubuntu Playwright image adds s6, Xvfb, Openbox, x11vnc, noVNC/websockify, and nginx for Home Assistant Ingress.

**Tech Stack:** Node.js 24, TypeScript 7, Vitest 4, `playwright-core` 1.62.1, Node SQLite, Ubuntu Resolute Playwright image, s6-overlay 3.2.3.2, nginx, Xvfb, Openbox, x11vnc, noVNC/websockify.

---

### Task 1: Repository metadata and immutable baselines

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `upstream-baselines.yaml`
- Create: `LICENSE`
- Create: `NOTICE`
- Create: `docs/provenance.md`

- [ ] **Step 1:** Pin the exact npm toolchain and add scripts for unit tests, integration tests, typecheck, build, API-free audit, and secret scan.
- [ ] **Step 2:** Record Home Assistant `2026.8.2@3fb456fa1fe4abbe6b89367b98f282043e9b02dd` and `smartthings_customize@6373c7ed22d6d2f46bb551e9e31955893264554f` with license status.
- [ ] **Step 3:** Install dependencies and verify the lock file resolves the pinned versions.
- [ ] **Step 4:** Do not commit until the user explicitly authorizes a Git commit.

### Task 2: Deterministic redaction and secure data bootstrap

**Files:**
- Test: `bridge/tests/security/redactor.test.ts`
- Test: `bridge/tests/security/data-paths.test.ts`
- Create: `bridge/src/security/alias-store.ts`
- Create: `bridge/src/security/redactor.ts`
- Create: `bridge/src/security/data-paths.ts`

- [ ] **Step 1:** Write a failing test that feeds raw Authorization, Cookie, CSRF, token, password, MFA, CAPTCHA, IP, location ID, device ID, account ID, nested JSON, URL query, and WebSocket JSON values into the desired redactor API.
- [ ] **Step 2:** Run `npm run test:unit -- bridge/tests/security/redactor.test.ts` and confirm failure because the modules do not exist.
- [ ] **Step 3:** Implement `SqliteAliasStore`, `Redactor.redact(value)`, `Redactor.redactUrl(url)`, and secure `/data`/secret/profile initialization using HMAC digests and modes `0700`/`0600`.
- [ ] **Step 4:** Run the focused tests and verify no raw fixture value appears in serialized output.

### Task 3: Runtime state and health contracts

**Files:**
- Test: `bridge/tests/state/runtime-state.test.ts`
- Test: `bridge/tests/server/health.test.ts`
- Create: `bridge/src/state/runtime-state.ts`
- Create: `bridge/src/server/health.ts`

- [ ] **Step 1:** Write failing tests for all fourteen approved state strings, legal state updates, liveness independent from login/browser state, readiness requiring browser+keeper+login+push+snapshot+parser, and sanitized details.
- [ ] **Step 2:** Run focused tests and confirm missing-module failures.
- [ ] **Step 3:** Implement a small observable `RuntimeStatusStore` and pure health-response builders.
- [ ] **Step 4:** Run focused tests and the unit suite.

### Task 4: Headed persistent Chromium and keeper invariant

**Files:**
- Test: `bridge/tests/browser/persistent-context.test.ts`
- Test: `bridge/tests/browser/keeper-page.test.ts`
- Create: `bridge/src/browser/persistent-context.ts`
- Create: `bridge/src/browser/keeper-page.ts`
- Create: `bridge/src/browser/browser-supervisor.ts`

- [ ] **Step 1:** Write failing tests for `/data/chromium-profile`, `headless:false`, rejection of desktop Chrome profiles, exactly one `/location` keeper, duplicate cleanup, closed/navigated recovery, and separate `/advanced` interactive pages.
- [ ] **Step 2:** Run the focused tests and confirm expected RED failures.
- [ ] **Step 3:** Implement dependency-injected Playwright launch and keeper reconciliation so tests use fakes without launching a browser.
- [ ] **Step 4:** Implement bounded browser restarts that end in `BROWSER_FAILED` while leaving the daemon alive.
- [ ] **Step 5:** Run browser tests and the unit suite.

### Task 5: Read-only network observers and sanitized persistence

**Files:**
- Test: `bridge/tests/inspector/browser-observer.test.ts`
- Test: `bridge/tests/inspector/cdp-network.test.ts`
- Test: `bridge/tests/state/capture-store.test.ts`
- Create: `bridge/src/inspector/browser-observer.ts`
- Create: `bridge/src/inspector/cdp-network.ts`
- Create: `bridge/src/inspector/protocol-fingerprint.ts`
- Create: `bridge/src/state/capture-store.ts`

- [ ] **Step 1:** Write failing tests for request/response/WebSocket/service-worker records, CDP WebSocket/EventSource/XHR records, binary-frame length/digest handling, body-size limits, and redaction before the store receives data.
- [ ] **Step 2:** Run focused tests and confirm the observer modules are missing.
- [ ] **Step 3:** Implement event listeners only; do not install Playwright routes or alter request/response data.
- [ ] **Step 4:** Implement SQLite capture storage accepting only branded sanitized records.
- [ ] **Step 5:** Run focused tests, unit tests, and the source API-free audit.

### Task 6: HTTP status UI and bridge composition

**Files:**
- Test: `bridge/tests/server/http-server.test.ts`
- Create: `bridge/src/server/http-server.ts`
- Create: `bridge/src/server/status-page.ts`
- Create: `bridge/src/config.ts`
- Create: `bridge/src/main.ts`

- [ ] **Step 1:** Write failing local HTTP tests for `/`, `/health/live`, `/health/ready`, `/health/details`, JSON content types, 200/503 semantics, and absence of raw URLs/IDs/secrets.
- [ ] **Step 2:** Run the server test and confirm the missing-module failure.
- [ ] **Step 3:** Implement the built-in HTTP server and an accessible diagnostic page using only actual runtime fields.
- [ ] **Step 4:** Compose data bootstrap, SQLite, redactor, status server, browser supervisor, keeper, and observers in `main.ts`.
- [ ] **Step 5:** Run integration tests, typecheck, and build.

### Task 7: Home Assistant add-on and standalone container

**Files:**
- Test: `tests/addon-config.test.ts`
- Create: `addon/smartthings_web_bridge/config.yaml`
- Create: `addon/smartthings_web_bridge/Dockerfile`
- Create: `addon/smartthings_web_bridge/apparmor.txt`
- Create: `addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/*`
- Create: `addon/smartthings_web_bridge/rootfs/etc/nginx/nginx.conf`
- Create: `addon/smartthings_web_bridge/DOCS.md`
- Create: `addon/smartthings_web_bridge/README.md`
- Create: `addon/smartthings_web_bridge/CHANGELOG.md`
- Create: `repository.yaml`
- Create: `docker/Dockerfile`
- Create: `docker/compose.example.yaml`

- [ ] **Step 1:** Write a failing metadata test requiring the approved slug, Ingress `8099`, watchdog `/health/live`, `amd64/aarch64`, no public ports, no host network/full access/Docker API/privileged mode, and architecture-specific pinned base digests.
- [ ] **Step 2:** Run the metadata test and confirm missing-file failure.
- [ ] **Step 3:** Implement the pinned container, s6 services, Xvfb/Openbox/x11vnc/noVNC/nginx wiring, data permissions, and internal-only VNC ports.
- [ ] **Step 4:** Run metadata tests. If Docker is available, build the image and smoke-test live=true/ready=false before login; otherwise record the exact Docker-daemon blocker.

### Task 8: Evidence-only documentation and audit gates

**Files:**
- Test: `tests/documentation-gate.test.ts`
- Create: `tools/api-free-audit.ts`
- Create: `tools/secret-scan.ts`
- Create: `MANUAL_TEST.md`
- Create: `docs/architecture.md`
- Create: `docs/feasibility-report.md`
- Create: `docs/protocol-report.md`
- Create: `docs/session-behavior.md`
- Create: `docs/api-free-audit.md`
- Create: `docs/official-parity-matrix.md`
- Create: `docs/customize-compatibility.md`
- Create: `docs/security.md`
- Create: `protocol/fixtures/README.md`

- [ ] **Step 1:** Write failing tests requiring exact decision footer syntax, explicit real-account gaps, no synthetic SmartThings payloads, and no Phase 2 completion claims.
- [ ] **Step 2:** Run the documentation gate and confirm missing-file failure.
- [ ] **Step 3:** Implement static audits and evidence templates populated only with verified local facts and upstream SHAs.
- [ ] **Step 4:** Run unit, integration, metadata, documentation, typecheck, build, API-free audit, secret scan, and repository status checks.
- [ ] **Step 5:** Keep the feasibility gate closed until a manual capture supports `DECISION: GO`.

## Self-review

- Scope covers all twelve currently requested Phase 1 items and explicitly excludes Phase 2.
- No task invents SmartThings protocol payloads or claims real-account evidence.
- Module names and interfaces are consistent across tasks.
- Container smoke testing is conditional only on the Docker daemon, while all source and configuration checks remain mandatory.
- Git commit and push are excluded because the request authorized private repository creation, not publication of local changes.

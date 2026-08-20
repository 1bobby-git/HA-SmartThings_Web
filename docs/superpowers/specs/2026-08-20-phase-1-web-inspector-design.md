# SmartThings Web Bridge Phase 1 Design

## Status

This design implements only the Phase 1 scope explicitly approved in the supplied project specification. It does not implement Home Assistant entity platforms, SmartThings commands, entity-ID migration, or a stable release. Phase 2 remains blocked until a real Samsung account and real devices produce enough sanitized evidence for `DECISION: GO`.

## Goal

Build a runnable, read-only SmartThings Web inspector that keeps one headed Chromium session open, lets the user log in manually through Home Assistant Ingress/noVNC, records the network surfaces already used by `my.smartthings.com`, removes secrets and personal identifiers before persistence, and reports separate liveness and readiness states.

## Non-negotiable boundaries

- The bridge never calls `api.smartthings.com` directly.
- The bridge has no PAT, OAuth client, SmartApp, webhook, subscription, or `pysmartthings` code.
- Device state is never derived from DOM text, CSS selectors, colors, icons, screenshots, or periodic DOM comparison.
- Network observation is copy-only. No request routing, interception, fulfillment, aborting, header injection, cookie replay, or direct SmartThings socket connection is permitted.
- Samsung credentials, MFA values, CAPTCHA values, cookies, authorization headers, CSRF values, tokens, raw account/user/location/device identifiers, and IP addresses are redacted before logs, SQLite, fixtures, diagnostics, or reports.
- Chromium uses a dedicated persistent profile under `/data/chromium-profile`; a desktop Chrome profile is rejected.
- Exactly one keeper page targets `https://my.smartthings.com/location`. Interactive `/advanced` pages are separate.
- CAPTCHA and MFA are handled only by the user in the real browser.

## Approaches considered

### 1. Ubuntu Playwright image plus s6-overlay — selected

Use the multi-architecture `mcr.microsoft.com/playwright:v1.62.1-resolute` image pinned by digest, add s6-overlay, Xvfb, Openbox, x11vnc, noVNC/websockify, and nginx, then run a TypeScript bridge with `playwright-core@1.62.1`.

This matches the required Debian/Ubuntu family, keeps the Playwright/Chromium pairing official, and supports both `amd64` and `aarch64`. The cost is a larger image and custom s6 installation.

### 2. Home Assistant Alpine base plus system Chromium — rejected

This integrates naturally with add-on s6 conventions and is smaller, but violates the explicit Debian/Ubuntu-family requirement and relies on an untested Playwright-core/system-Chromium pairing.

### 3. Chromium inside the Home Assistant custom component — rejected

This would couple browser lifetime to Home Assistant Core and integration reloads, complicate headed login, and violate the approved runtime boundary.

## Runtime architecture

```text
Home Assistant Ingress :8099
        |
        v
nginx ingress proxy
   |                |
   v                v
Bridge HTTP :8098   noVNC/websockify :6080
   |                |
   |                v
   |             x11vnc :5900
   |                |
   v                v
TypeScript bridge -> Xvfb :99 + Openbox
        |
        v
Playwright persistent Chromium
        |
        +-- exactly one /location keeper page
        +-- optional /advanced interactive pages
        |
        v
read-only BrowserContext + CDP observers
        |
        v
central redactor -> SQLite + bounded sanitized capture files
```

s6 supervises Xvfb, Openbox, x11vnc, noVNC/websockify, nginx, and the bridge daemon. The bridge daemon owns the Playwright persistent context and keeps serving health/status when Chromium fails. Its browser supervisor retries Chromium a bounded number of times and then exposes `BROWSER_FAILED` instead of terminating the daemon.

## TypeScript module boundaries

- `bridge/src/security/alias-store.ts`: HMAC-backed stable pseudonym allocation. SQLite stores only HMAC digests and aliases, never raw identifiers.
- `bridge/src/security/redactor.ts`: recursive redaction of objects, headers, URLs, JSON/text frames, identifiers, and IP addresses.
- `bridge/src/state/runtime-state.ts`: the exact approved runtime states and observable status snapshot.
- `bridge/src/state/capture-store.ts`: SQLite schema and sanitized capture persistence.
- `bridge/src/browser/persistent-context.ts`: dedicated profile validation and headed persistent-context launch.
- `bridge/src/browser/keeper-page.ts`: one-keeper invariant and separate interactive pages.
- `bridge/src/browser/browser-supervisor.ts`: bounded restart loop without killing the HTTP daemon.
- `bridge/src/inspector/browser-observer.ts`: Playwright request/response/WebSocket/service-worker metadata.
- `bridge/src/inspector/cdp-network.ts`: CDP WebSocket frames, EventSource messages, and bounded XHR/fetch response bodies.
- `bridge/src/inspector/protocol-fingerprint.ts`: hashes sanitized transport shapes without inventing a SmartThings schema.
- `bridge/src/server/health.ts`: `/health/live`, `/health/ready`, and `/health/details` response construction.
- `bridge/src/server/http-server.ts`: status UI and health routing.
- `bridge/src/main.ts`: creates data permissions, secret, SQLite, server, supervisor, keeper, and observers.

## Redaction design

The redactor is the only path into persistence and logging. It handles:

- sensitive key names such as authorization, cookie, password, token, secret, CSRF, MFA, and CAPTCHA;
- raw IP addresses in strings and URLs;
- `location_id`/`locationId` as `loc_001`, `loc_002`, and so on;
- `device_id`/`deviceId` as `dev_001`, `dev_002`, and so on;
- account/user identifiers as stable HMAC labels;
- nested JSON and JSON carried in WebSocket/SSE text frames;
- URL query values whose names are sensitive.

The bridge secret is generated once with mode `0600`. `/data` and the profile directory use `0700`. Stable aliases survive restart because SQLite stores `HMAC(secret, raw identifier)` and the allocated alias.

## Observation design

The inspector listens to the browser's existing traffic only:

- Playwright BrowserContext request and response events;
- Playwright WebSocket open/frame/close events;
- service-worker creation and closure;
- CDP Network WebSocket sent/received frames;
- CDP EventSource messages;
- bounded XHR/fetch response bodies after `Network.loadingFinished`;
- console errors and page lifecycle/crash events with sanitization.

No route handlers are installed. Response-body capture is capped, textual only, and passed through the redactor before storage. Unknown binary frames are represented only by length and a digest.

## Runtime states

The bridge exposes the approved states unchanged:

`STARTING`, `BROWSER_STARTING`, `LOGIN_REQUIRED`, `AUTHENTICATING`, `PAGE_LOADING`, `DISCOVERING_PROTOCOL`, `SYNCING`, `CONNECTED`, `STALE`, `RECONNECTING`, `REAUTH_REQUIRED`, `PROTOCOL_CHANGED`, `BROWSER_FAILED`, `FATAL`.

Phase 1 can reach `DISCOVERING_PROTOCOL` after the user reaches SmartThings Web. It must not claim `CONNECTED` until a push transport and initial snapshot are identified from real sanitized traffic.

## Health semantics

- `/health/live` returns success when the HTTP daemon, event loop, and SQLite are responsive. Samsung logout and Chromium failure do not fail liveness.
- `/health/ready` returns success only when Chromium is running, the keeper page exists, login is complete, a push transport is connected, the initial snapshot is confirmed, and the parser/observer is healthy.
- `/health/details` returns only versions, URL category, state, counts, and event ages. It never returns raw URLs, query strings, headers, identifiers, IPs, or secrets.

The Supervisor watchdog targets `/health/live`, preventing a logout/restart loop.

## Ingress user interface

The status page uses a compact industrial diagnostic layout. It displays real bridge/browser/session/transport timestamps and counts, a clear manual-login status, a protocol-evidence warning, and an embedded noVNC link. It does not reproduce SmartThings cards or derive state from the screen.

Phase 1 actions are limited to opening the actual browser view and requesting keeper-page recovery. SmartThings control actions are absent.

## Upstream and provenance

- Home Assistant fallback baseline: `home-assistant/core` release `2026.8.2`, commit `3fb456fa1fe4abbe6b89367b98f282043e9b02dd`, Apache-2.0.
- `oukene/smartthings_customize` baseline: `main` commit `6373c7ed22d6d2f46bb551e9e31955893264554f`, with no repository license detected.

Phase 1 copies no Home Assistant platform code and no `smartthings_customize` code. The latter is used only to document public compatibility behavior. Future source ports from Home Assistant must preserve Apache-2.0 notices and modification provenance.

## Test design

Production modules follow red-green-refactor order. Automated tests cover:

- stable aliases and secret removal across nested objects, headers, URLs, and frames;
- source-tree rejection of forbidden API/client/interception patterns;
- dedicated headed persistent-context launch options;
- one keeper tab and separate interactive tabs;
- observer copy-only behavior and redaction-before-write;
- exact state names and liveness/readiness separation;
- ingress/add-on security fields and absence of public ports/privileged flags;
- HTTP health/status behavior with a local browser-free test harness;
- required manual evidence and a closed Phase 2 gate.

Container build and headed Chromium/noVNC smoke tests are attempted only when a Docker daemon is available. Samsung login, real device traffic, session restoration, and feasibility classification remain manual evidence.

## Acceptance criteria

Phase 1 implementation is locally acceptable when:

1. Unit, integration, typecheck, build, source-audit, and secret-scan commands pass.
2. The add-on metadata uses Ingress on `8099`, watchdog `/health/live`, and no public noVNC port or broad privileges.
3. The bridge can start without login and returns live=true, ready=false, with a non-secret reason.
4. The browser launch path is headed, persistent, dedicated, and supervised.
5. Network records cannot reach storage without redaction.
6. `MANUAL_TEST.md` gives a real-account procedure without requesting credentials.
7. Feasibility documents state that Phase 2 remains closed until real traffic yields `DECISION: GO`.

## Explicitly deferred

- `custom_components/smartthings_web` runtime implementation;
- inventory/snapshot/event semantic adapters;
- local authenticated Bridge WebSocket and pairing;
- Home Assistant entities and parity mapping;
- YAML import runtime;
- SmartThings commands;
- entity-ID migration;
- alpha/beta/stable release claims.

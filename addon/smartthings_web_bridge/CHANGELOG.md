# Changelog

## 0.1.29

- Add a safe authenticated switch command endpoint that serializes per device and succeeds only after a newer push event confirms the requested state.
- Keep command activity in a separate browser page while the keeper page remains observation-only.
- Add Home Assistant switch and fail-closed light entities without optimistic state updates.

## 0.1.28

- Keep physical-action correlation armed for valid component-less physical-action events by recording an explicit safe `unspecified` component.
- Accept the observed epoch-millisecond source timestamps in privacy-safe physical-action evidence.

## 0.1.27

- Restore live sensor and binary-sensor updates by reconciling component-less push events with the normalized snapshot state identity.
- Normalize epoch-millisecond event timestamps and reject older state events before they can overwrite newer snapshot values.
- Re-fetch and atomically merge Bridge inventory on SSE connection markers, sequence gaps, and Bridge sequence resets without adding SmartThings polling.

## 0.1.26

- Route the authenticated Bridge API to Home Assistant Core on internal port 8100 while allowing only the Core container address.
- Register 213 observed devices and 352 read-only entities on Home Assistant 2026.8.3, using state attributes that remain stable after capability identifiers are privacy-aliased.
- Permit cached inventory startup during a browser re-login window and use Home Assistant's supported illuminance unit constant.
- Add an authenticated local inventory API, one-time Ingress pairing codes, and an SSE state stream for the `smartthings_web` Home Assistant integration.
- Reconstruct all observed devices from the real SmartThings Web snapshot and update supported read-only sensor states from push events without SmartThings polling.
- Canonicalize generated package text as UTF-8/LF so equivalent cross-platform checkouts retain one manifest identity.
- Add a bounded in-memory physical-action correlation probe with fixed safe contact, motion, switch, and button presets.
- Require exactly one settled `/location` keeper page before arming and fail active evidence on browser isolation loss, protocol change, or runtime restart.
- Collapse Playwright/CDP duplicate deliveries into one logical candidate while exposing only safe metadata and an output-only SHA-256 logical-event hash.
- Add fixed no-store Ingress control responses with strict JSON validation, a 4 KiB request limit, and no request-body or raw-event logging.
- Keep commands, DOM state scraping, direct SmartThings APIs, and a persistent event journal outside the current limited alpha.
- Defer the interrupted 72-hour soak until after the first real Home Assistant device-registration result.

## 0.1.25

- Keep missing-event-ID deduplication source-independent by hashing the canonical sanitized Socket.IO delivery instead of an observer-specific capture envelope.
- Treat a changed value or event timestamp as a distinct fallback event while still collapsing the same delivery observed by Playwright and CDP.
- Align Phase 1 documentation with the already verified 0.1.24 add-on restart session and snapshot restore.
- Keep source backups outside `/addons` so duplicate local-app slugs cannot hide the newest package metadata.

## 0.1.24

- Attach Playwright and CDP network observers before keeper navigation, then reload an already restored authenticated SmartThings keeper once so restart-time snapshot requests cannot escape observation.
- Preserve Samsung login pages without automatic navigation and retain the 0.1.23 current-context readiness semantics.

## 0.1.23

- Keep readiness true for the current browser-context initial snapshot proof after the old 120-second snapshot TTL, while heartbeat freshness, recent push traffic, and current-context parser proof continue to gate readiness.
- Document the logged-in HAOS add-on validation that reached `CONNECTED`, observed 213 devices, decoded live device events, and kept `protocolChangeCount=0` and `restartCount=0`.
- Retain the owner-qualified `/proc` AppArmor write rule for Chromium's user-namespace setup and keep Phase 2 under the LIMITED evidence gate.

## 0.1.22

- Permit Chromium's HAOS user-namespace sandbox probe under enforced AppArmor with owner-qualified access to only the exact `/proc` map files it writes, while keeping the add-on's Docker privilege list empty and retaining `chromiumSandbox: true`.
- Allow the read-only GnuTLS configuration lookup observed during the same sandbox startup path.

## 0.1.21

- Allow HAOS Debian coreutils targets in the AppArmor profile so the `data-prep` oneshot can execute `chown` under enforced AppArmor.
- Run Openbox with temporary HOME/XDG cache paths to avoid root-home cache writes inside the confined add-on.

## 0.1.20

- Run the bridge and Chromium as the existing non-root `pwuser`, with a root-only data preparation oneshot for the add-on's private `/data` volume.
- Enable Playwright's Chromium sandbox explicitly and configure the pinned architecture-specific `chrome_sandbox` helper as `root:root` mode `4755`, without privileged mode, broad AppArmor access, a global sysctl change, or a `--no-sandbox` fallback.
- Add only the helper execution paths and the `chown`, `dac_override`, `setpcap`, and `sys_chroot` capabilities required by that fail-closed sandbox experiment.

## 0.1.19

- Run websockify in its standard proxy mode after live HAOS testing showed the distribution `--libserver` path accepted the WebSocket upgrade and then crashed on a missing `unix_listen` attribute.

## 0.1.18

- Keep the noVNC WebSocket URL relative to the `/novnc-ui/` Ingress page and proxy that exact path to websockify, preventing the duplicated `/novnc-ui/novnc/` route that completed an HTTP upgrade and then disconnected.

## 0.1.17

- Route the status-page login link through a fresh `/novnc-ui/` asset namespace and mark noVNC assets `no-store`, avoiding stale edge-cached MIME responses without requiring an external cache purge.

## 0.1.16

- Load nginx's standard MIME map so noVNC styles, ES modules, fonts, and images are served with browser-accepted content types through Ingress.
- Permit only the nginx MIME map plus the standard fontconfig and Openbox configuration trees required by the confined desktop session.

## 0.1.15

- Restore compatibility with the Home Assistant OS 18.2 AppArmor parser after it rejected the newer `userns` rule syntax.
- Serve noVNC static assets directly from nginx and run websockify on its thread-based library server so HTTP requests do not depend on per-request child processes under confinement.

## 0.1.14

- Allow user-namespace creation only inside the add-on's AppArmor profile so the pinned Chromium build can initialize its Linux sandbox without global sysctl or privileged-container changes.

## 0.1.13

- Allow read and executable mapping only for the pinned Playwright Chromium revision, with explicit amd64 and aarch64 browser and crash-handler entrypoints.

## 0.1.12

- Match the Supervisor-owned persistent data root as a directory (`/data/`) so AppArmor permits its metadata validation without broad file access.
- Use s6-overlay's bundled millisecond sleep utility while waiting for Xvfb readiness, avoiding ambiguous system `sleep` resolution under confinement.

## 0.1.11

- Permit only the `setgid` and `setuid` capabilities Xvfb needs to drop root privileges inside the AppArmor-confined container.
- Emit path-free initialization stage markers so startup permission failures can be isolated without exposing private data paths or contents.

## 0.1.10

- Reuse the existing `/tmp` directory for nginx and emit only an allowlisted startup error code for safe live diagnostics.
- Keep nginx's worker identity aligned with the already-root, AppArmor-confined service container so startup performs no ownership changes.

## 0.1.9

- Keep nginx temporary state in `/tmp`, let the bridge own `/data` initialization, and allow only the standard TLS configuration tree needed by Node.

## 0.1.8

- Allow nginx to read only its generated configuration and Xvfb to write only its keyboard-cache directory.

## 0.1.7

- Permit only the nginx binary under `/usr/sbin` and disable the unnecessary Xvfb lock file in the single-display container.

## 0.1.6

- Match both the pinned s6 bootstrap directories and their contents so s6 can enumerate its immutable service sources.

## 0.1.5

- Move the service bundle to s6-overlay's current `user-bundles.d` layout so startup does not rewrite the immutable image configuration.

## 0.1.4

- Declare the s6 user service bundle in the image so startup never needs to modify the read-only `/etc/s6-overlay` tree.

## 0.1.3

- Allow read access only to the pinned s6-overlay interpreter and bootstrap-data subtrees required by its verified startup chain.

## 0.1.2

- Allow the pinned s6-overlay `preinit` interpreter to be read without broadening the rest of `/package`.

## 0.1.1

- Reload the enforced Home Assistant AppArmor profile with read access for the s6 `/init` entrypoint.

## 0.1.0

- Initial Phase 1 inspector add-on skeleton.
- Added read-only protocol observation boundary, static API/secret audit gates, and a LIMITED evidence gate that keeps Phase 2 closed.

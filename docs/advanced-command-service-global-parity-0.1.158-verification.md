# SmartThings Web 0.1.158 Verification

Date: 2026-09-01
Scope: Advanced command POST execution plus global generated entity-ID convergence.

## Candidate

- Version: `0.1.158`
- Protocol contract: `5`
- Base: 0.1.157 same-origin Advanced POST CSRF fix.
- Follow-up: generated switch IDs and restore metadata use one idempotent rule across every device and location.

## Naming and Migration Contract

- A unique generated primary switch uses the device base ID without a redundant `_switch` suffix.
- Multi-switch devices may still have one primary power state when exactly one safe state matches the Web power control.
- The primary entity keeps the Web-visible `전원` name while its entity ID remains type-free.
- Same-name primary switches in different locations use deterministic location/room-qualified IDs instead of load-order `_2` suffixes or platform-type suffixes.
- Existing secondary IDs and user-named/custom rows are preserved.
- Generated leading and trailing slug feedback, including multi-thousand-character registry IDs, converges to a bounded canonical ID in one pass and remains stable over repeated migrations.

## Required Local Gates

- Full Python integration tests: `290 passed, 176 subtests passed`.
- Full JavaScript tests: `72 files, 1002 tests passed`.
- TypeScript typecheck and build: passed.
- Secret, API-free, and fixture audits: passed.
- Add-on packaging: passed.
- Package manifest SHA-256: `23a74f03639e4a48e9b6d0a12b48c09bbd5cf8ba8db4fdd87a261566aab988bc`.

## Required Live Gates

- Publish `v0.1.158` from the exact tested main SHA and make it the latest HACS release.
- Back up the installed HAOS add-on, integration, registries, and bridge data before activation.
- Deploy the exact packaged add-on and integration, restart Home Assistant Core, and wait for Bridge `CONNECTED` with two active connections.
- Verify Galaxy Home Mini `smartthings_web.speak` succeeds through Advanced POST.
- Verify generated switch IDs have no redundant type suffix and same-name collisions use stable location/room qualification.
- Verify the refrigerator's overlong generated IDs are repaired and remain bounded after another Core restart.
- Verify multi-outlet Web labels, refrigerator icon, rattan/mood light controls, bathroom switch, and live parity audit.

## Status

Local and live evidence are recorded after the final candidate SHA is verified.

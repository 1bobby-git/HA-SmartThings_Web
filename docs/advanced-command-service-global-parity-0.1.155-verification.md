# SmartThings Web 0.1.155 Local Verification

Date: 2026-09-01
Scope: local release preparation only. GitHub release publication, HAOS deployment, Home Assistant restart, and live device proof are pending outside this commit.

## Release Context

- Base merge HEAD: `79abb5ad8dc8f21974b5d9941420146a2e123ebf`
- Previous concurrent release: `0.1.154` security/recovery release is preserved verbatim in `addon/smartthings_web_bridge/CHANGELOG.md`.
- This candidate version: `0.1.155`
- Protocol contract version: `5`
- Machine-readable version surfaces updated:
  - `package.json`
  - `package-lock.json`
  - `addon/smartthings_web_bridge/config.yaml`
  - `custom_components/smartthings_web/manifest.json`
  - `protocol/version.json`
  - `bridge/src/runtime.ts`
  - `bridge/src/inspector/protocol-contract.ts`

## RED / GREEN Evidence

- RED: `npx vitest run tests/addon-package.test.ts -t "copies only addon package sources"` failed before implementation because `tools/smartthings-web-parity-audit.ts` was not included in the generated add-on package.
- GREEN: package source allowlist now includes `tools/smartthings-web-parity-audit.ts` and `tools/smartthings-web-parity-audit-core.ts`.
- GREEN: generated package root resolves `npm run audit:web-parity` with explicit fixture files and returns a zero-failure report.
- RED: `npx vitest run bridge/tests/security/volatile-identifier-map.test.ts bridge/tests/advanced/command-catalog.test.ts bridge/tests/state/device-store.test.ts tests/smartthings-web-parity-audit.test.ts` failed before implementation because aliased `speechSynthesis` descriptors had no safe capability role, DeviceStore dropped that role, the audit rejected the new field, and the role allowlist did not include `speechsynthesis`.
- RED: `python custom_components/smartthings_web/tests/test_bridge_client.py; python custom_components/smartthings_web/tests/test_services.py` failed before implementation because `BridgeCommandDescriptor` did not accept `capability_role`, and `speak` could only match literal `speechSynthesis`.
- GREEN: command descriptors now carry optional allowlisted `capabilityRole: speechsynthesis` from the observed volatile identifier role, persist it across DeviceStore restart, expose it through HTTP/catalog and HA models, and route `smartthings_web.speak` through the exact aliased component/capability descriptor.
- RED: `npx vitest run tests/smartthings-web-parity-audit.test.ts` failed before implementation because the audit accepted a non-emitted top-level `deviceAliases` map.
- GREEN: `deviceAliases` is no longer accepted in the audit input envelope, and the full-envelope fixture uses only fields emitted by `/api/v1/inventory`.

## Local Verification

- Targeted JS: `npx vitest run bridge/tests/security/volatile-identifier-map.test.ts bridge/tests/advanced/command-catalog.test.ts bridge/tests/state/device-store.test.ts bridge/tests/server/http-server.test.ts tests/smartthings-web-parity-audit.test.ts` -> 5 files, 158 tests passed.
- Targeted parity audit: `npx vitest run tests/smartthings-web-parity-audit.test.ts` -> 1 file, 30 tests passed.
- Targeted Python: `python custom_components/smartthings_web/tests/test_bridge_client.py; python custom_components/smartthings_web/tests/test_services.py` -> 15 tests passed.
- Full JS: `npx vitest run --maxWorkers=1` -> 72 files, 994 tests passed.
- Full Python: `python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_*.py'` -> 278 tests passed.
- TypeScript: `npm run typecheck` -> passed.
- Build: `npm run build` -> passed.
- Secret audit: `npm run audit:secrets` -> passed.
- API-free audit: `npm run audit:api-free` -> passed.
- Fixture audit: `npm run audit:fixtures` -> passed.
- Web parity CLI: `npm run audit:web-parity -- --inventory <sanitized temp inventory> --projection <sanitized temp projection>` -> zero-failure report.
- Add-on package: `npm run package:addon` -> passed.
- Diff check: `git diff --check` -> passed.

## Package Output

- Package directory: `dist-addon/smartthings_web_bridge`
- Package manifest SHA-256: `bec18d35168a0e9a1042cce7a3cb74c69fb615315155028c426e62162b733586`
- Package manifest includes both parity audit files:
  - `tools/smartthings-web-parity-audit.ts`
  - `tools/smartthings-web-parity-audit-core.ts`

## Local Review / Deslop

- Scope: release-prep files plus parity audit packaging surface.
- Behavior lock: targeted version/package/parity/runtime/protocol tests and full JS/Python suites were run before final review.
- Fallback-like scan: no masking fallback, temporary workaround, bypass, debug, TODO, or stale protocol-4 assertion remained in the scoped files.
- Expected retained `0.1.154` references: changelog section for the published security/recovery release and tests asserting that section is preserved.
- Cleanup applied: normalized the top-level `bridgeVersion` declaration in `bridge/src/runtime.ts` to column 1.

## Pending External Evidence

- GitHub release and HACS latest publication are pending.
- HAOS add-on/integration upload, Home Assistant Core config check, restart, and recovery wait are pending.
- Live acceptance checks are pending: Galaxy Home Mini `speechSynthesis.speak`, rattan and mood light on/off restore, multi-outlet labels/channels, refrigerator generic icon, bathroom composite regression, realtime/liveness checks, and full live parity audit.

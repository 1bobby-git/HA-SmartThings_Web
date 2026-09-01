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

## Local Verification

- Targeted JS: `npx vitest run tests/addon-package.test.ts tests/addon-config.test.ts tests/protocol-version-contract.test.ts tests/smartthings-web-parity-audit.test.ts tests/runtime-hardening.test.ts bridge/tests/inspector/protocol-analyzer.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism` -> 6 files, 72 tests passed.
- Full JS: `npm test` -> 72 files, 989 tests passed.
- Full Python: `python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_*.py'` -> 277 tests passed.
- TypeScript: `npm run typecheck` -> passed.
- Build: `npm run build` -> passed.
- Secret audit: `npm run audit:secrets` -> passed.
- API-free audit: `npm run audit:api-free` -> passed.
- Fixture audit: `npm run audit:fixtures` -> passed.
- Add-on package: `npm run package:addon` -> passed.
- Diff check: `git diff --check` -> passed.

## Package Output

- Package directory: `dist-addon/smartthings_web_bridge`
- Package manifest SHA-256: `0f5ce7a18ea24eb2cad29365fdba37771907024ca3b946fd71910190c6d6a9cf`
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

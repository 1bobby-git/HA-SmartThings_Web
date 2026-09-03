# SmartThings Web 0.1.157 Patch Verification

Date: 2026-09-01
Scope: patch release preparation for Advanced command execution and generated entity-ID convergence.

## Live Failure Evidence From 0.1.156

- Environment: Home Assistant Core 2026.8.3 with SmartThings Web 0.1.156 deployed.
- `smartthings_web.list_commands` returned HTTP 200 and exposed one Galaxy Home Mini `speechSynthesis.speak` descriptor with the live bounded phrase schema.
- `smartthings_web.speak` still returned HTTP 500 through Home Assistant.
- Core traceback normalized the Bridge failure as `command_execution_failed`.
- Bridge stayed healthy, which isolated the fault to the Advanced command POST execution boundary rather than service registration, command catalog generation, entity projection, or realtime liveness.
- Code cause: the same-origin Advanced page fetch added JSON `content-type` for POST bodies but did not include the SmartThings page CSRF header required by Advanced command POST.

## Patch

- Version: `0.1.157`
- Protocol contract version: `5`
- Fix: Advanced same-origin POST now reads the SmartThings CSRF token only inside the browser page context and sends it as `x-csrf-token`.
- Safety: GET requests keep no body and no CSRF header. Missing, empty, overlong, or control-character CSRF values fail before fetch without returning the token in logs, diagnostics, or response data.
- Follow-up fix: generated entity object IDs collapse repeated canonical device prefixes such as `fridge_fridge_temperature` back to `fridge_temperature`.
- Follow-up fix: migration repairs existing generated registry rows with repeated device slugs once and keeps subsequent restart passes stable.

## RED / GREEN Evidence

- RED: `npm test -- bridge/tests/advanced/authenticated-session.test.ts` failed before the fix because Advanced POST fetch options contained only `content-type` and no `x-csrf-token`.
- RED: the same test also proved missing CSRF still executed fetch before the fix.
- GREEN: after the fix, `bridge/tests/advanced/authenticated-session.test.ts` passed with POST CSRF, GET no-CSRF, and no token returned in result data.
- RED: `python custom_components/smartthings_web/tests/test_entity.py -k repeated -v` failed before the naming fix because `fridge_fridge_temperature` stayed repeated.
- RED: `python custom_components/smartthings_web/tests/test_init.py -k repeated_device_slug -v` failed before the migration fix because stale registry metadata stayed `fridge_fridge_temperature`.
- GREEN: both repeated-slug tests passed after the fix.

## Local Verification

- Targeted JS session test: `npm test -- bridge/tests/advanced/authenticated-session.test.ts` -> passed.
- Targeted Python naming test: `python custom_components/smartthings_web/tests/test_entity.py -k repeated -v` -> passed.
- Targeted Python migration test: `python custom_components/smartthings_web/tests/test_init.py -k repeated_device_slug -v` -> passed.
- Targeted release metadata: `npm test -- tests/protocol-version-contract.test.ts tests/addon-config.test.ts` -> `2 files, 16 tests passed`.
- Targeted Python entity/init/models: `python custom_components/smartthings_web/tests/test_entity.py -v`; `python custom_components/smartthings_web/tests/test_init.py -v`; `python custom_components/smartthings_web/tests/test_models.py -v` -> `17 + 59 + 96 tests passed`.
- Targeted JS Advanced/command/state/release: `npx vitest run bridge/tests/advanced/authenticated-session.test.ts bridge/tests/advanced/command-adapter.test.ts bridge/tests/command/advanced-first-executor.test.ts bridge/tests/state/device-store.test.ts tests/protocol-version-contract.test.ts tests/addon-config.test.ts --maxWorkers=1` -> `6 files, 114 tests passed`.
- Full Python: `$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'; python -m pytest custom_components/smartthings_web/tests -q -p pytest_asyncio.plugin` -> `286 passed, 176 subtests passed`.
- Full JavaScript: `npx vitest run --maxWorkers=1` -> `72 files, 1002 tests passed`.
- TypeScript: `npm run typecheck` -> passed.
- Build: `npm run build` -> passed.
- Secret audit: `npm run audit:secrets` -> passed.
- API-free audit: `npm run audit:api-free` -> passed.
- Fixture audit: `npm run audit:fixtures` -> passed.
- Add-on package: `npm run package:addon` -> passed.

## Package Output

- Package directory: `dist-addon/smartthings_web_bridge`
- Package manifest SHA-256: `b1bf74c3f61aa1edfffe78c757bb92691daa0b0d85516931b0005da40e587dfb`

## Pending External Evidence

- GitHub release and HACS latest publication are pending.
- HAOS add-on/integration upload, Home Assistant Core restart, and live device proof are pending.
- Live acceptance checks are pending: Galaxy Home Mini `speechSynthesis.speak`, Advanced switch/button POST, fish generated switch ID, repeated refrigerator entity-ID convergence, multi-outlet labels, rattan/mood light on/off, bathroom switch, bridge health, and packaged parity audit.

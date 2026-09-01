# SmartThings Web 0.1.156 Patch Verification

Date: 2026-09-01
Scope: local patch release preparation only. GitHub release publication, HAOS deployment, Home Assistant restart, and live device proof are pending outside this commit.

## Live Failure Evidence From 0.1.155

- Environment: Home Assistant Core 2026.8.3 with SmartThings Web 0.1.155 deployed.
- Failing call: `POST /api/services/smartthings_web/list_commands?return_response`.
- Observed result: HTTP 500.
- Core traceback root cause: `HomeAssistantError: Failed to process the returned action response data, expected a dictionary, but got <class 'coroutine'>`.
- Code cause: `async_setup_services` registered each service through a synchronous lambda that returned the async handler coroutine instead of an HA-recognized coroutine function.

## Patch

- Version: `0.1.156`
- Protocol contract version: `5`
- Fix: service registration now uses a true async wrapper per handler, preserving the bound handler and Home Assistant response-support behavior.
- Compatibility: `list_commands` still registers `supports_response=ONLY`; `execute_command`, `speak`, `reload_inventory`, `refresh_device`, and `reconnect_realtime` keep their existing handler behavior.

## RED / GREEN Evidence

- RED: `python -m pytest custom_components/smartthings_web/tests/test_services.py -k awaitable -q -p pytest_asyncio.plugin` failed before the fix because every registered service handler was not `inspect.iscoroutinefunction(handler)`.
- GREEN: the same focused test passed after the async wrapper fix: `1 passed, 15 deselected, 6 subtests passed`.
- GREEN: full service tests passed after the fix: `16 passed, 13 subtests passed`.

## Local Verification

- Targeted Python: `python -m pytest custom_components/smartthings_web/tests/test_bridge_client.py custom_components/smartthings_web/tests/test_services.py -q -p pytest_asyncio.plugin` -> `44 passed, 52 subtests passed`.
- Targeted JS/version/package: `npx vitest run bridge/tests/server/http-server.test.ts tests/addon-config.test.ts tests/protocol-version-contract.test.ts tests/addon-package.test.ts tests/smartthings-web-parity-audit.test.ts` -> `5 files, 103 tests passed`.
- Full Python: `python -m pytest custom_components/smartthings_web/tests -q -p pytest_asyncio.plugin` -> `279 passed, 173 subtests passed`.
- Full JS: `npx vitest run --maxWorkers=1` -> `72 files, 994 tests passed`.
- TypeScript: `npm run typecheck` -> passed.
- Build: `npm run build` -> passed.
- Secret audit: `npm run audit:secrets` -> passed.
- API-free audit: `npm run audit:api-free` -> passed.
- Fixture audit: `npm run audit:fixtures` -> passed.
- Add-on package: `npm run package:addon` -> passed.
- Package-root parity smoke: from `dist-addon/smartthings_web_bridge`, `node --import tsx tools\smartthings-web-parity-audit.ts --inventory <safe fixture> --projection <safe fixture>` -> zero-failure report.

## Package Output

- Package directory: `dist-addon/smartthings_web_bridge`
- Package manifest SHA-256: `96e1171e7da7afac5e25f549104c8fa9ba0d69fab88b8aa200eb79063087c46b`

## Pending External Evidence

- GitHub release and HACS latest publication are pending.
- HAOS add-on/integration upload, Home Assistant Core config check, restart, and recovery wait are pending.
- Live acceptance checks are pending: Galaxy Home Mini `speechSynthesis.speak`, rattan and mood light on/off restore, multi-outlet labels/channels, refrigerator generic icon, bathroom composite regression, realtime/liveness checks, and full live parity audit.

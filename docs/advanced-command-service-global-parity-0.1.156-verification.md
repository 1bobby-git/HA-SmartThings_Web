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
- Follow-up fix: Advanced public command schema now preserves bounded integer `minLength`/`maxLength` keys, so Galaxy Home Mini `speechSynthesis.speak(phrase)` with live `maxLength: 1000` is no longer omitted as `schema_invalid`.
- Follow-up fix: a single reversible switch state with semantic `componentRole=Switch` is treated as the generated primary switch, so stale generated IDs such as `switch.eohang_switch` migrate to `switch.eohang` while user-named/custom entity IDs are preserved.
- Follow-up fix: when one state has both an observed Web detail toggle and one catalog-owned Advanced toggle, execution selects the exact Advanced control while generated names continue to use the Web-visible labels. This restores same-component multi-channel switches without weakening duplicate-control safety.
- Documentation: `docs/smartthings-web-services-ui-guide.md` documents Home Assistant Developer Tools -> Actions usage for command and maintenance services.

## RED / GREEN Evidence

- RED: `python -m pytest custom_components/smartthings_web/tests/test_services.py -k awaitable -q -p pytest_asyncio.plugin` failed before the fix because every registered service handler was not `inspect.iscoroutinefunction(handler)`.
- GREEN: the same focused test passed after the async wrapper fix: `1 passed, 15 deselected, 6 subtests passed`.
- GREEN: full service tests passed after the fix: `16 passed, 13 subtests passed`.
- RED: `npx vitest run bridge/tests/advanced/command-catalog.test.ts bridge/tests/state/device-store.test.ts bridge/tests/command/command-service.test.ts` failed before the schema fix because `maxLength` was outside the public schema contract and descriptor execution was rejected.
- RED: `python custom_components/smartthings_web/tests/test_models.py` and `python custom_components/smartthings_web/tests/test_init.py` failed before the naming fix because a sole `componentRole=Switch` state was treated as secondary and `switch.eohang_switch` was not renamed.
- GREEN: the focused schema/naming/docs/parity tests passed after the fix.

## Local Verification

- Targeted JS schema/naming/docs/parity: `npx vitest run bridge/tests/advanced/command-catalog.test.ts bridge/tests/state/device-store.test.ts bridge/tests/command/command-service.test.ts tests/smartthings-web-parity-audit.test.ts tests/documentation-gate.test.ts` -> `5 files, 232 tests passed`.
- Targeted Python parser/naming/migration: `python custom_components/smartthings_web/tests/test_bridge_client.py`; `python custom_components/smartthings_web/tests/test_models.py`; `python custom_components/smartthings_web/tests/test_init.py` -> `all passed`.
- Full Python: `$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'; python -m pytest custom_components/smartthings_web/tests -q -p pytest_asyncio.plugin` -> `284 passed`.
- Full JS: `npx vitest run --maxWorkers=1` -> `72 files, 999 tests passed`.
- TypeScript: `npm run typecheck` -> passed.
- Build: `npm run build` -> passed.
- Secret audit: `npm run audit:secrets` -> passed.
- API-free audit: `npm run audit:api-free` -> passed.
- Fixture audit: `npm run audit:fixtures` -> passed.
- Add-on package: `npm run package:addon` -> passed.
- Package-root parity smoke: from `dist-addon/smartthings_web_bridge`, `node --import tsx tools/smartthings-web-parity-audit.ts --inventory <safe fixture> --projection <safe fixture>` with a `maxLength: 1000` speech descriptor -> `safeCommands=1`, `failures=[]`.
- Documentation reader test: PASS for device picker/YAML alias usage, response-panel copy flow, `execute_command`, `speak`, maintenance services, length limits, safety boundaries, and common errors.

## Package Output

- Package directory: `dist-addon/smartthings_web_bridge`
- Package manifest SHA-256: `556e80d2d9a0f9213b8dfa1e300b9e54a7c12ae7fcda954f8267afc49d1aac20`

## Pending External Evidence

- GitHub release and HACS latest publication are pending.
- HAOS add-on/integration upload, Home Assistant Core config check, restart, and recovery wait are pending.
- Live acceptance checks are pending: Galaxy Home Mini `speechSynthesis.speak`, rattan and mood light on/off restore, multi-outlet labels/channels, refrigerator generic icon, bathroom composite regression, realtime/liveness checks, and full live parity audit.

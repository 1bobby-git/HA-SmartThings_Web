# Provenance

This repository contains MIT-licensed project code for Home Assistant and SmartThings web observation work.

## Project Code

- License: MIT
- Runtime browser dependency: `playwright-core@1.62.1`
- Node.js requirement: `>=24.15 <25`
- Package manager: `npm@11.12.1`
- Local bootstrap verification runtime: Node.js `v24.15.0`

## Upstream Baselines

| Source | Version or branch | Commit | License | Use |
| --- | --- | --- | --- | --- |
| Home Assistant Core | 2026.8.2 | `3fb456fa1fe4abbe6b89367b98f282043e9b02dd` | Apache-2.0 | Compatibility baseline |
| smartthings_customize | main | `6373c7ed22d6d2f46bb551e9e31955893264554f` | No license declared | Behavioral reference only |

The `smartthings_customize` baseline is not a code source for this repository. It is retained only to document observed behavior and compatibility assumptions.

## Production Modules

Phase 1 production bridge modules live under `bridge/src`: browser supervisor, persistent context, keeper page, runtime orchestration, CDP/browser observers, capture store, redactor, data-path policy, health routes, HTTP server, and status page.

The emitted build is `dist/bridge/src/**/*.js` from `npm run build`. It is a bridge-only build; test files, docs, and audit tools are not emitted into `dist`.

SmartThings web behavior is treated as an observed private web contract, not as a guaranteed API surface. The Phase 1 tests cover runtime state, health gates, browser keeper, persistent context, network observers, capture storage, redaction boundaries, add-on metadata, package build shape, documentation gates, and static audit tools.

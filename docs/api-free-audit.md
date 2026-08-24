# API-Free Audit

Local static checks prohibit direct source references to `api.smartthings.com`, SmartThings `/v1` endpoint construction, PAT, OAuth, API Access App, SmartApp, installedApp, subscription, webhook, official SmartThings SDK clients, bridge-owned direct HTTP clients, polling-style SmartThings calls, and Playwright/CDP network mutation APIs.

Runtime traffic separation is sampled by `npm run audit:api-free:runtime`. The external read-only collector maps the HAOS add-on process tree to host `/proc` socket ownership, checks the Bridge listener and established TCP owners, and stores only role-level counts and booleans outside the repository. It never retains remote addresses, ports, process IDs, socket identifiers, command output, or packet contents.

Current static result: `npm run audit:api-free` is the production-source gate for Phase 1. It does not prove browser traffic classification; it only proves the checked production roots do not contain forbidden direct API implementation patterns.

Current bounded runtime sample: no `api.smartthings.com` request was observed in 111 controlled Chrome reload requests. This is a useful sampled result, not complete paid/public API independence proof.

On 2026-08-24, 4/4 process-socket samples passed over 19.597 seconds on the live 0.1.25 HAOS add-on. The Bridge HTTP listener was present in every sample, Bridge-owned external TCP connections remained zero, and Chromium-owned external TCP connections were observed in every sample. The reviewed aggregate is `protocol/fixtures/2026-08-24-runtime-api-audit-summary.json` with SHA-256 `947c876be837c7188d6d295fecb6ae4f3748639d7f472cdde0e6f618ae7d54cc`.

This proves process ownership separation only for the bounded observation window. It does not retain or classify destination hostnames and does not prove complete network history, so the broader API-independence gate remains limited to observed samples.

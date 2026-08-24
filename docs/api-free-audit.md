# API-Free Audit

Local static checks prohibit direct source references to `api.smartthings.com`, SmartThings `/v1` endpoint construction, PAT, OAuth, API Access App, SmartApp, installedApp, subscription, webhook, official SmartThings SDK clients, bridge-owned direct HTTP clients, polling-style SmartThings calls, and Playwright/CDP network mutation APIs.

Runtime traffic separation is sampled by `npm run audit:api-free:runtime`. The external read-only collector maps the HAOS add-on process tree to host `/proc` socket ownership, checks the Bridge listener and established TCP owners, and stores only role-level counts and booleans outside the repository. It never retains remote addresses, ports, process IDs, socket identifiers, command output, or packet contents.

Retained sanitized browser captures are classified by `npx tsx tools/haos-capture-origin-audit.ts`. The fixed command opens `/data/bridge.sqlite` read-only inside the add-on container, parses URL-bearing capture rows there, and returns only fixed source/origin counts and the capture time range. Raw URLs, hostnames, payloads, IDs, headers, and database rows never leave the container. A public SmartThings API observation or an inconclusive result exits nonzero.

Current static result: `npm run audit:api-free` is the production-source gate for Phase 1. It does not prove browser traffic classification; it only proves the checked production roots do not contain forbidden direct API implementation patterns.

Current bounded runtime sample: no `api.smartthings.com` request was observed in 111 controlled Chrome reload requests. This is a useful sampled result, not complete paid/public API independence proof.

On 2026-08-24, 4/4 process-socket samples passed over 19.597 seconds on the live 0.1.25 HAOS add-on. The Bridge HTTP listener was present in every sample, Bridge-owned external TCP connections remained zero, and Chromium-owned external TCP connections were observed in every sample. The reviewed aggregate is `protocol/fixtures/2026-08-24-runtime-api-audit-summary.json` with SHA-256 `947c876be837c7188d6d295fecb6ae4f3748639d7f472cdde0e6f618ae7d54cc`.

The retained-capture audit then reviewed all 1,999 URL-source rows held between `2026-08-24T04:37:49.268Z` and `2026-08-24T11:23:46.267Z`; 1,985 contained a valid HTTP(S) or WS(S) URL. It classified 12 consumer SmartThings Web records and zero public SmartThings API records, producing `consumer_web_only_observed`. The reviewed aggregate is `protocol/fixtures/2026-08-24-haos-capture-origin-audit-summary.json` with SHA-256 `86ef83c565173820307f8413a15424b52f7419dcafa69c2fed5afd607b60a2c1`.

Together these prove process ownership separation for the bounded socket window and no public SmartThings API URL among the retained sanitized URL records. URL records may double-count one exchange, existing sockets may lack a retained URL row, and the database is not guaranteed to contain complete network history. The broader API-independence gate therefore remains limited to observed retained samples.

# API-Free Audit

Local static checks prohibit direct source references to `api.smartthings.com`, SmartThings `/v1` endpoint construction, PAT, OAuth, API Access App, SmartApp, installedApp, subscription, webhook, official SmartThings SDK clients, bridge-owned direct HTTP clients, polling-style SmartThings calls, and Playwright/CDP network mutation APIs.

Runtime traffic separation still requires real add-on execution and outbound observation. Browser-owned SmartThings Web traffic must be classified separately from bridge-owned traffic.

Current static result: `npm run audit:api-free` is the production-source gate for Phase 1. It does not prove browser traffic classification; it only proves the checked production roots do not contain forbidden direct API implementation patterns.

Current bounded runtime sample: no `api.smartthings.com` request was observed in 111 controlled Chrome reload requests. This is a useful sampled result, not complete paid/public API independence proof.

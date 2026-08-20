# Security

The Phase 1 bridge follows these constraints:

- No Samsung password, MFA, CAPTCHA, cookie, CSRF, Authorization, or bridge token values in logs or fixtures.
- Dedicated Chromium profile only.
- noVNC is exposed through Home Assistant Ingress, not a public add-on port.
- `host_network`, `full_access`, `docker_api`, and privileged mode are not used.
- All capture persistence goes through the redaction boundary.

Threat boundaries:

- Samsung account authentication remains user-owned inside the headed browser. The bridge must not collect credentials or automate MFA/CAPTCHA.
- Browser-owned SmartThings Web traffic is observed read-only and must be separated from bridge-owned local health/WebSocket traffic.
- Add-on Ingress is admin-facing; noVNC is not exposed as a public port.
- Production source must not contain hardcoded session, access, refresh, client, authorization, CSRF, cookie, CAPTCHA, MFA, password, or bridge token material.

Known gap: live container AppArmor and Supervisor runtime enforcement have not been validated on a Home Assistant host. The static profile and add-on metadata are present, but container-level proof remains a manual Phase 1 evidence item.

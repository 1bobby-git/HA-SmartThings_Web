# Security

The Phase 1 bridge follows these constraints:

- No Samsung password, MFA, CAPTCHA, cookie, CSRF, Authorization, or bridge token values in logs or fixtures.
- Dedicated Chromium profile only.
- noVNC is exposed through Home Assistant Ingress, not a public add-on port.
- `host_network`, `full_access`, `docker_api`, and privileged mode are not used.
- All capture persistence goes through the redaction boundary.

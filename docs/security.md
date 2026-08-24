# Security

The Phase 1 bridge follows these constraints:

- No Samsung password, MFA, CAPTCHA, cookie, CSRF, Authorization, or bridge token values in logs or fixtures.
- Dedicated Chromium profile only.
- noVNC is exposed through Home Assistant Ingress, not a public add-on port.
- `host_network`, `full_access`, `docker_api`, and privileged mode are not used.
- All capture persistence goes through the redaction boundary.
- `/data/settings.json` and `/data/protocol-fingerprint.json` are persisted with 0600 permissions.
- A local Docker smoke test verified the Ingress allow/deny rule, internal-only VNC/noVNC ports, and 0700/0600 data permissions.
- Live Home Assistant OS 18.2 validation on 2026-08-24 confirmed the Supervisor-loaded AppArmor profile is enforced, `Privileged=false`, bridge networking, `full_access=false`, and an empty add-on privilege list. Chromium 151 ran as UID 1001 with its sandbox enabled, and the owner-qualified `/proc` rule was live-proven for Chromium user-namespace startup.

Threat boundaries:

- Samsung account authentication remains user-owned inside the headed browser. The bridge must not collect credentials or automate MFA/CAPTCHA.
- Browser-owned SmartThings Web traffic is observed read-only and must be separated from bridge-owned local health/WebSocket traffic.
- Add-on Ingress is admin-facing; noVNC is not exposed as a public port.
- The protocol safe mismatch surface may report `PROTOCOL_CHANGED`, category names, parser/readiness state, and version numbers, but must not expose payload bodies or account identifiers.
- Production source must not contain hardcoded session, access, refresh, client, authorization, CSRF, cookie, CAPTCHA, MFA, password, or bridge token material.

Known gaps: the live Supervisor runtime reports its platform-provided seccomp mode as unconfined, while the add-on's AppArmor profile remains enforced and Docker does not grant host `SYS_ADMIN`. The profile-wide AppArmor `sys_admin` allowance is required by Chromium inside its new user namespace because HAOS 18.2 lacks AppArmor's `userns` policy feature; Docker's capability bounding set still blocks host `SYS_ADMIN`. The owner-qualified `/proc` write rule is limited to `setgroups`, `uid_map`, `gid_map`, and `oom_score_adj`. Add-on restarts restore the login session and complete snapshot, and one targeted physical-action correlation is verified; host reboot recovery and long-idle durability remain separate Phase 1 evidence items.

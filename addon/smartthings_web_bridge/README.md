# SmartThings Web Bridge Add-on

Phase 1 add-on skeleton for a headed Chromium SmartThings Web inspector.

The add-on uses Home Assistant Ingress on port `8099`, keeps VNC/noVNC bound inside the container, and exposes `/health/live` for the Supervisor watchdog.

For a private repository install, run `npm ci`, then `npm run package:addon` from the repository root. Copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge` on the Home Assistant host.

Do not copy the raw `addon/smartthings_web_bridge` source folder to Home Assistant. It lacks generated monorepo build inputs that are included by `npm run package:addon`.

Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup containing the same slug can make an older version appear current.

Use the Ingress noVNC page to sign in manually. Do not store Samsung credentials, cookies, or tokens in add-on options. This release does not create Home Assistant entities and does not control SmartThings devices.

Live HAOS validation after manual VNC login reached `CONNECTED`, observed 213 devices, decoded safe live DEVICE_EVENT counters, and restored the session plus complete snapshot after one add-on restart. The evidence gate remains `DECISION: LIMITED` until host reboot recovery, physical-action correlation, long-idle durability, command behavior, and complete API independence are proven with sanitized evidence.

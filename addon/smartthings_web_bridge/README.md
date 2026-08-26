# SmartThings Web Bridge Add-on

Phase 1 add-on skeleton for a headed Chromium SmartThings Web inspector.

The add-on uses Home Assistant Ingress on port `8099`, keeps VNC/noVNC bound inside the container, exposes `/health/live` for the Supervisor watchdog, and provides a Core-only Bridge proxy on port `8100` restricted to the Home Assistant container.

For a private repository install, run `npm ci`, then `npm run package:addon` from the repository root. Copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge` on the Home Assistant host.

Do not copy the raw `addon/smartthings_web_bridge` source folder to Home Assistant. It lacks generated monorepo build inputs that are included by `npm run package:addon`.

Generated text is canonical UTF-8/LF. Equivalent Windows and Linux checkouts therefore produce the same package-manifest SHA-256 without rewriting monorepo source files.

Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup containing the same slug can make an older version appear current.

Use the Ingress noVNC page to sign in manually. Do not store Samsung credentials, cookies, or tokens in add-on options. After the Bridge reaches `CONNECTED`, generate a ten-minute pairing code and add the `SmartThings Web` integration. As of 0.1.79, the limited alpha registers observed devices, keeps official-integration gaps as diagnostic sensors, maps clear device roles to primary entities such as media players, fans, updates, events, covers, and climate entities, and preserves raw SmartThings Web content as attributes. It does not create synthetic refresh controls unless a real observed SmartThings Web button control exists.

Live Home Assistant 2026.8.3 registration produced 213 devices and 352 read-only entities from the observed inventory. Cached inventory remains loadable during a temporary browser re-login window, while live push updates resume only after the Bridge returns to `CONNECTED`.

Live HAOS validation of version 0.1.28 reached `CONNECTED`, observed 213 devices, delivered an inventory marker plus 30 consecutive SSE state events without a sequence gap, and restored the complete inventory after a Bridge-only sequence reset. A targeted manual contact-open action produced one passing component-less candidate and reached Home Assistant about 134 ms after its Bridge source time. The evidence gate remains `DECISION: LIMITED` until host reboot recovery, long-idle durability, command behavior, and complete API independence are proven with sanitized evidence.

# SmartThings Web Bridge

Home Assistant OS/Supervised users install this as a normal add-on. Supervisor manages the underlying container; no separate Docker installation or Docker commands are required on the Home Assistant host.

For the current private repository, build the local add-on package first:

```powershell
npm ci
npm run package:addon
```

Copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge`, then open **Settings → Apps → Install app**, choose **Check for updates**, and install **SmartThings Web Bridge** from **Local apps**. The configured slug is `smartthings_web_bridge`; Supervisor prefixes local apps, so the installed runtime slug is `local_smartthings_web_bridge`.

Do not copy the raw `addon/smartthings_web_bridge` source folder to Home Assistant. It lacks generated monorepo build inputs that are included by `npm run package:addon`.

Generated text is canonical UTF-8/LF. Equivalent Windows and Linux checkouts therefore produce the same package-manifest SHA-256 without rewriting monorepo source files.

Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup containing the same slug can make an older version appear current.

For a passive soak from inside the production-pruned add-on container, use the compiled local collector:

```sh
node dist/tools/haos-soak.js --local-bridge
```

The equivalent package script is `npm run soak:haos:addon`.

Open the add-on Ingress panel, use the noVNC browser view, and sign in to Samsung manually. The bridge keeps `https://my.smartthings.com/location` open and stores that login only in its dedicated `/data/chromium-profile`. Never copy cookies, CSRF values, user IDs, or other browser session material into the integration.

After the Bridge reaches `CONNECTED`, generate a ten-minute pairing code on its status page and add the `SmartThings Web` integration. Select the SmartThings location to add. As of 0.1.79, the limited alpha exposes all normalized pushed attributes plus binary sensors, switches, lights, buttons, numeric controls, fans, media players, updates, events, covers, climate entities, scenes, SmartThings Home Monitor, and refreshed camera stills. SmartThings Web-only state that the official integration does not model is kept as diagnostic sensors instead of being deleted. Clear domain values are grouped under their primary Home Assistant entities, while raw SmartThings Web content remains available as attributes. It never polls SmartThings state and never changes Home Assistant state optimistically; a command completes only after a newer SmartThings Web push confirms it. Synthetic refresh controls are not created unless a real observed SmartThings Web button control exists.

Live Home Assistant OS 18.2 validation on 2026-08-24 confirmed that the Supervisor-loaded AppArmor profile is enforced, the add-on remains non-privileged with bridge networking, and sandboxed Chromium 151 starts as the non-root browser user. The status page and noVNC Ingress rendered the Samsung Account login page.

After manual VNC login, the add-on reached `CONNECTED`, observed 213 devices, initially permitted readiness, decoded live DEVICE_EVENT counters, and kept `protocolChangeCount=0` and `restartCount=0`. Version 0.1.23 fixes the old 120-second readiness drop by treating the initial snapshot as a current browser-context proof; heartbeat freshness, recent push traffic, and current-context parser proof still gate readiness.

Version 0.1.28 was then verified on the same HAOS install: the persisted login session restored after add-on updates and Bridge-only restart, the complete inventory was reacquired after a local sequence reset, and readiness stayed true beyond the former 120-second boundary. A targeted manual contact-open action produced one passing component-less candidate and updated Home Assistant about 134 ms after its Bridge source time. Host-reboot recovery and long-idle durability remain unverified.

Home Assistant service usage for `smartthings_web.list_commands`, `smartthings_web.execute_command`, `smartthings_web.speak`, `smartthings_web.reload_inventory`, `smartthings_web.refresh_device`, and `smartthings_web.reconnect_realtime` is documented at `https://github.com/1bobby-git/HA-SmartThings_Web/blob/main/docs/smartthings-web-services-ui-guide.md`. Use Home Assistant Developer Tools -> Actions, select a SmartThings Web device, and copy the exact `commands[].component`, `commands[].capability`, and `commands[].command` values from `list_commands` before executing Advanced-only commands.

The current evidence gate is `DECISION: LIMITED`. Before Phase 2, collect sanitized evidence for long-idle delivery, keep-login behavior across a host reboot, network outage recovery, commands, and complete API independence. Keep Phase 2 closed until the gate reaches GO.

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

Open the add-on Ingress panel, use the noVNC browser view, and sign in to Samsung manually. The bridge keeps `https://my.smartthings.com/location` open and records only sanitized network metadata for feasibility review.

This Phase 1 build does not create Home Assistant entities and does not control devices.

Live Home Assistant OS 18.2 validation on 2026-08-24 confirmed that the Supervisor-loaded AppArmor profile is enforced, the add-on remains non-privileged with bridge networking, and sandboxed Chromium 151 starts as the non-root browser user. The status page and noVNC Ingress rendered the Samsung Account login page.

After manual VNC login, the add-on reached `CONNECTED`, observed 213 devices, initially permitted readiness, decoded live DEVICE_EVENT counters, and kept `protocolChangeCount=0` and `restartCount=0`. Version 0.1.23 fixes the old 120-second readiness drop by treating the initial snapshot as a current browser-context proof; heartbeat freshness, recent push traffic, and current-context parser proof still gate readiness.

Version 0.1.24 was then verified on the same HAOS install: the persisted login session restored after an add-on restart, the complete initial snapshot was reacquired after observers attached, and readiness stayed true beyond the former 120-second boundary. Host-reboot recovery and long-idle durability remain unverified.

The current evidence gate is `DECISION: LIMITED`. Before Phase 2, collect sanitized evidence for deliberate physical-event correlation, long-idle delivery, keep-login behavior across a host reboot, network outage recovery, Home Assistant Core restart, commands, and complete API independence. Keep Phase 2 closed until the gate reaches GO.

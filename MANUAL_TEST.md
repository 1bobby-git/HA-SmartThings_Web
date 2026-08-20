# SmartThings Web Bridge Phase 1 Manual Test

Do not enter Samsung credentials into this repository, a config file, an issue, or any chat. Enter credentials only in the real Chromium window exposed through the add-on Ingress noVNC view. Do not capture passwords, MFA codes, CAPTCHA values, cookies, CSRF values, Authorization headers, session tokens, or bridge tokens.

## Add-on and Standalone Paths

1. Home Assistant add-on: install `smartthings_web_bridge`, start it, open Ingress, and use the noVNC Chromium view.
2. Standalone bridge: run the built bridge with an isolated data directory and confirm no normal Chrome profile is used.
3. Confirm `/health/live` returns live and `/health/ready` stays unready until the keeper page and observation state are usable.
4. Confirm the keeper tab is `https://my.smartthings.com/location` and only temporary inspection tabs are opened.

## Login and Keep-Login

1. Sign in to Samsung manually in Chromium.
2. Enable any SmartThings Web keep-login option shown by the real site.
3. Record only sanitized evidence: login page visible, login complete page visible, cookie names and expiry classes without values, and local/session storage key names without values.
4. Close no credential dialogs by automation and do not attempt CAPTCHA or MFA bypass.

## Runtime Matrix

Run each scenario and record sanitized pass/fail evidence:

- location-only: keep only `/location` open and trigger a real device event.
- background tab: put Chromium/noVNC in the background and trigger a real device event.
- device matrix: contact, motion, leak, temperature/humidity, battery, plug, power plug, Edge device, Samsung Wi-Fi appliance, third-party cloud device, multi-component device, button, scene, and offline device where available.
- network outage: disconnect network for one minute, restore it, and record reconnect plus any snapshot gap.
- restart: restart Home Assistant Core only, then the add-on, then the host if safe for the environment.
- redaction evidence: verify exported captures contain aliases like `loc_001` and `dev_001`, never raw identifiers or secrets.

## Decision Rubric

This decision rubric is the only Phase 2 gate input.

- GO: full inventory, initial snapshot, location-wide push events, background delivery, reconnect snapshot, duplicate handling, and at least switch on/off feasibility are all proven without direct SmartThings API calls.
- LIMITED: read events work but control, device coverage, session restore, or snapshot completeness is partial.
- STOP: DOM text is the only state source, push is absent, only visible devices update, full inventory/snapshot is unavailable, direct paid/public SmartThings API is required, frames are not stably interpretable, automation is blocked, or CAPTCHA bypass would be needed.

Phase 2 remains closed until real sanitized traffic supports `DECISION: GO`.

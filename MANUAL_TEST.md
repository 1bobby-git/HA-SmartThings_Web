# SmartThings Web Bridge Phase 1 Manual Test

Do not enter Samsung credentials into this repository, a config file, an issue, or any chat. Enter credentials only in the real Chromium window exposed through the add-on Ingress noVNC view.

## Procedure

1. Install the SmartThings Web Bridge add-on.
2. Open the Ingress panel and then open the browser login view.
3. Sign in to Samsung manually and enable any SmartThings Web keep-login setting shown by the real page.
4. Confirm the keeper tab remains on `https://my.smartthings.com/location`.
5. Trigger at least one real device event, such as opening a contact sensor or toggling a plug physically.
6. Export only sanitized capture artifacts from `protocol/fixtures/`.
7. Record whether a push transport, initial full snapshot, and location-wide events are present without opening every device detail page.

## Required Evidence Before Phase 2

- Real account login completion visible through noVNC.
- A real device event linked to a sanitized network frame.
- Browser restart/session restore result.
- `docs/feasibility-report.md` updated to `DECISION: GO`, `LIMITED`, or `STOP`.

Phase 2 remains closed until real sanitized traffic supports `DECISION: GO`.

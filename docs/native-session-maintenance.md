# Native session maintenance contract

Source analysis: SmartThings Web 2.57.0, natural module exports (no hard-coded module IDs). The bridge observes UI preference separately from effective user.session and client connection/authentication flags. Only booleans, bounded durations, and enum diagnostics leave the page. A bridge-generated document nonce and revision are used internally for stale-result rejection, not exposed in health or logs.

The app’s existing updateStayLoggedIn and user/reauthenticate action creators are matched by typePrefix. Their native client method is observed without changing arguments, return value or exception behavior. Module factories execute only as part of the app’s normal initialization. Unknown shapes disable supplementary work; no guessed storage keys, independent authentication requests or forced module evaluation are used.

## Timing and proof

The bridge reads at most once per 10 seconds, checks protected Location access at most once per minute per effective-session revision, and supplements renewal when the observed expiry has at most five minutes remaining or UI and effective preference disagree. These are conservative bridge policies, NOT assertions about an unobserved native hook’s automatic cadence. Pending commands, their confirmation quiet period, foreground browser tasks and physical probes defer supplementary work. Idle cached command tabs alone do not block same-document maintenance.

Native Promise fulfillment is not proof. A new session reference from the same user and document, effective ON, live authenticated socket, and protected read are required. A strictly increased expiry is reported as renewed; same-expiry setting application is only applied. Native callback observation is bounded to 35 seconds, with a two-minute supplementary retry cooldown. A pending native request is not duplicated. The existing candidate-tab fallback may recover unsupported or unconfirmed states; its normal safety/backoff gates still apply. No wall-clock 8/24-hour live-account guarantee is claimed.

The DOM fallback waits for native application before reloading an owned candidate after a toggle when this evidence is available. Live manual settings dialogs are never closed or clicked by observation. CSRF-resistant recheck uses loopback/Ingress, a custom same-origin POST header, no CORS permission and an exact empty JSON body.

## Regression coverage

Unit tests cover preference/session mismatch, no ACK, swallowed failure, native in-flight suppression, expiry extension vs application, storage consent OFF, stale contexts/documents/users, active commands, renderer deadlines and non-sensitive health projection. Synthetic Chromium tests exercise the real init-script and natural webpack capture plus delayed callbacks without connecting a real account. Existing DOM, persistent-profile, runtime, integration and security suites remain enabled. Real account soak and performance benchmarking are separate operational checks.

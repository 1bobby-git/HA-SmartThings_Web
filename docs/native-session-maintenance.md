# Native session maintenance contract

Source analysis: SmartThings Web 2.57.0, natural module exports (no hard-coded module IDs). The bridge observes UI preference separately from effective user.session and client connection/authentication flags. Only booleans, bounded durations, and enum diagnostics leave the page. A bridge-generated document nonce and revision are used internally for stale-result rejection, not exposed in health or logs.

The app’s existing updateStayLoggedIn and user/reauthenticate action creators are matched by typePrefix. Their native client method is observed without changing arguments, return value or exception behavior. Module factories execute only as part of the app’s normal initialization. Unknown shapes disable supplementary work; no guessed storage keys, independent authentication requests or forced module evaluation are used.

## Timing and proof

The bridge reads at most once per 10 seconds, checks protected Location access at most once per minute per effective-session revision, and supplements renewal when the observed expiry has at most five minutes remaining or UI and effective preference disagree. These are conservative bridge policies, NOT assertions about an unobserved native hook’s automatic cadence. Pending commands, their confirmation quiet period, foreground browser tasks and physical probes defer supplementary work. Idle cached command tabs alone do not block same-document maintenance.

Native Promise fulfillment is not proof. A new session reference from the same user and document, effective ON, live authenticated socket, and protected read are required. A strictly increased expiry is reported as renewed; same-expiry setting application is only applied. Native callback observation is bounded to 35 seconds, with a two-minute supplementary retry cooldown. A pending native request is not duplicated. The existing candidate-tab fallback may recover unsupported or unconfirmed states; its normal safety/backoff gates still apply. No wall-clock 8/24-hour live-account guarantee is claimed.

The DOM fallback waits for native application before reloading an owned candidate after a toggle when this evidence is available. Live manual settings dialogs are never closed or clicked by observation. CSRF-resistant recheck uses loopback/Ingress, a custom same-origin POST header, no CORS permission and an exact empty JSON body.

## Regression coverage

Unit tests cover preference/session mismatch, no ACK, swallowed failure, native in-flight suppression, expiry extension vs application, storage consent OFF, stale contexts/documents/users, active commands, renderer deadlines and non-sensitive health projection. Synthetic Chromium tests exercise the real init-script and natural webpack capture plus delayed callbacks without connecting a real account. Existing DOM, persistent-profile, runtime, integration and security suites remain enabled. Real account soak and performance benchmarking are separate operational checks.

## Observation versus renewal capabilities (1.8.54)

An already initialized Redux store can expose a valid effective session before a duration preference or native action delegate becomes available. Read-only observation does not require renewal capabilities. Supplemental mutations still require the verified native delegate, both matching action creators, a finite positive observed expiry, and a recognized duration. A missing optional expiry is omitted from the health projection, never defaulted or treated as an infinite session. Even in read-only mode, active status requires effective ON and a protected Location read; an actual 401 still wins over the displayed switches.

Only matched, naturally executed module export namespaces are retained in a bounded list to handle late/cyclic getters. Reading one unavailable sibling does not discard other ready exports. No module is force-executed for capture. Diagnostics use fixed enums and do not return raw state, user IDs, URLs or credentials.

Native settings detection bounds its scan to a settings heading and its local dialog, not the complete device dashboard. More than 8,000 unrelated device elements is not an authentication challenge. Large-dashboard regressions must also show that real OTP/password/foreign modal guards and read-only DOM/focus preservation remain intact.

## 1.8.55: field-level observation and non-mutating preference inspection

A 1.8.54 user log proves authenticated probes succeed while `session_schema_unknown`,
`blocked` and `page_changed` recur. It does not contain the actual session field
values or DOM blocker; do not claim which field value or modal the user has.

Observe a boolean effective flag independently from optional expiry. A null,
string, zero or otherwise unreadable deadline is not a server auth rejection and
never authorizes supplemental renewal. Missing/non-boolean flags remain unknown.
The Web 2.57.0 native setLogoutTimer uses the deadline only when the effective
stayLoggedIn flag is OFF. ON plus an elapsed deadline still requires a fresh
protected Location read; 401 still invalidates authentication.

Read the app preference without opening a modal/reloading an already-ON page.
UI preference alone is never effective-session or persistence proof. Explicit
blocker reasons preserve credential/challenge/modal protection. Diagnostic field
TYPE enums only (no values, account IDs, storage, cookie or token data) cross the
page boundary. Unit and browser fixtures cover variants, not live account state.

# Samsung login session continuity — 2026-09-13

## Reported symptom

A running Bridge reports successful protected probes, proactive refresh handoffs and encrypted session-state saves, then repeatedly reports:

```text
session_recovery:{"phase":"attempt"}
session_login_page:{"stage":"recovery","page":"samsung_account","surface":"no_visible_auth_input"}
session_recovery:{"phase":"login_required"}
```

The submitted excerpt has no timestamps. It establishes repeated failed recovery, but not the elapsed interval between attempts, the cause of Samsung's redirect, or a server-enforced session expiry. A missing visible standard input is not proof that no iframe/custom authentication challenge exists. Occasional inventory writes taking about 2–3 seconds are separate observations and are not established as the cause of authentication loss.

## Code changes

- When a previously authenticated keeper is already on Samsung Account and the ordinary SmartThings return path remains unsettled without visible standard authentication inputs, attempt the existing normal Samsung Account → SmartThings SSO route in a separate managed tab. Previously this fallback was only reachable from a stale SmartThings application shell.
- Give the Samsung bootstrap a bounded redirect opportunity before leaving its document. Do not type credentials, change cookie expiry, extract tokens, bypass MFA, or replay device commands.
- Preserve the user's existing password, email and one-time-code form. An input-less or unavailable SSO page remains an unknown/unsettled result and is not promoted over the original keeper.
- Require the existing runtime native Location application proof as well as the protected Advanced read before promoting a recovered application page. Recheck page identity, navigation and command/navigation availability after asynchronous work.
- Share concurrent keeper operations as before. After unchanged recovery failures, retry after 5, 10, 20 and at most 30 minutes with default settings. A verified session resets the failure counter. The initial recovery delay is unchanged.
- Keep the persistent Chromium profile, encrypted cookies/localStorage/IndexedDB handling, API-free transport, device/entity identifiers, number controls, protocol and release versions unchanged.

## Diagnostics

`login_page_unsettled` and `sso_page_unsettled` distinguish an unknown Samsung document from a detected standard sign-in/MFA input. `sso_verified` means a candidate passed the configured protected/application checks; it does not promise that Samsung will never revoke that session later. No page contents, input values, cookies or tokens are added to logs.

## Verification

The dedicated regression suite covers SSO fallback, existing password/email/OTP forms, blank or MFA fallback documents, independent native application proof, rejected protected reads, exponential backoff, concurrent recovery requests, user navigation during verification, unrelated redirects and profiles that have never authenticated. Run:

```sh
npx vitest run bridge/tests/browser
npm test
npm run typecheck
npm run build
npm run audit:api-free
npm run audit:fixtures
npm run audit:secrets
```

Also run the repository's existing real-Chromium session continuity and packaged HAOS runtime checks before release. Unit/fixture tests cannot establish actual account-specific Samsung SSO behavior or long-duration session retention. A genuinely revoked session or server-required MFA can still require the user to authenticate through the Bridge browser; do not delete the existing profile to address this symptom.

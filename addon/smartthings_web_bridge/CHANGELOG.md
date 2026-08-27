# Changelog

## 0.1.98

- Keep the inactive Chromium keeper and native command dispatcher responsive by launching with explicit background timer, occluded-window, and renderer throttling suppression flags.
- Cache the recovered authenticated `api/device` service in the live SmartThings page so consecutive native commands do not rescan the webpack module cache.
- Remove stale camera-image and image-transfer states from non-camera devices while preserving Home Camera image entities; this restores the living-room window sensor to Contact, Battery, Received Signal Metrics, and its observed Refresh button.
- Preserve the 0.1.97 Advanced HUB enrichment behavior while keeping Cupcake endpoints read-only and excluded from command execution.

## 0.1.97

- Include the Advanced `type=HUB` same-origin device-list GET in the one-shot bootstrap fallback so SmartThings hub metadata can enrich the normalized inventory when the Advanced page does not naturally finish that request.
- Keep Advanced responses read-only enrichment only; `allowedActions` and Cupcake endpoints remain excluded from command execution and polling.

## 0.1.96

- Fall back to two bounded same-origin Advanced device-list GETs when the authenticated page does not naturally finish its snapshot request within five seconds; responses are redacted and merged only as bootstrap metadata/state, never used for direct Cupcake commands or polling.
- Keep the temporary Advanced page alive briefly after the first complete response so its observed continuation page can enrich devices beyond the initial batch.
- Refine existing generated sensor and binary-sensor registry names when newly observed component roles replace numeric qualifiers, while preserving every user-supplied entity name.

## 0.1.95

- Keep Ari/SmartTag alarm volume and other audio accessory controls off `media_player`, while retaining real speakers only when the required pushed audio volume and mute evidence is present; remove stale media_player registry entries owned by this integration after reclassification.
- Expose pushed speaker duration, position, repeat, shuffle, source, and source-list metadata, and enable their write features only when the exact corresponding SmartThings Web control was observed.
- Observe the authenticated Advanced device-list JSON once for each new browser context, close its temporary page promptly, and atomically enrich the push inventory with status, health, presentation, type, room, and safe component-role metadata without SmartThings polling or direct Advanced commands.
- Distinguish repeated refrigerator, freezer, pantry, ice-maker, hub, setup, Bixby, and multi-switch states with localized component-role labels while keeping stable aliased entity identities.
- Keep official-style read-only appliance power categories as binary sensors, retain web-only states, and apply SmartThings presentation artwork only to primary device entities while preserving functional icons on individual sensors.

## 0.1.94

- Correlate SmartThings Web camera image-state URLs with `api/camera/thumbnail` requests and persist the real Socket.IO binary thumbnail response for Home Assistant's authenticated image proxy.
- Open camera detail pages for bounded initial image discovery even when other observed controls already exist, without adding SmartThings state polling.
- Keep pushed powered-down laundry state readable while leaving device controls unavailable when the washer or dryer is offline.
- Localize current SmartThings device types, remove trailing technical numeric suffixes, and migrate one repeated room prefix from generated entity IDs.
- Distinguish repeated state rows with stable component, capability, or numeric qualifiers and remove raw sensor duplicates already represented by an observed select.
- Complete a device command as soon as the post-dispatch authoritative push confirms the requested state, removing the fixed 500 ms hold that serialized consecutive controls.

## 0.1.93

- Keep SmartThings presentation artwork off state-backed sensor rows so Home Assistant can show distinct temperature, humidity, battery, and other device-class icons.
- Preserve translated entity names by leaving an unset entity name truly unset instead of shadowing the translation key with `None`.

## 0.1.92

- Capture the authenticated Cake client when the SmartThings app naturally invokes its private webpack module factory, then reuse only that volatile reference.
- Accept a verified SmartThings device-detail page as the warm native dispatcher instead of rejecting it as a non-location page.
- Send the exact captured `patch` request to the existing `api/device` Socket.IO service without direct SmartThings API calls, cookie replay, or DOM state authority.

## 0.1.91

- Reuse the authenticated client loaded by a successful device-detail page for native commands instead of limiting native dispatch to the overview keeper.
- Keep the single verified warm detail page available for up to 24 hours while continuing to validate that it is open and on SmartThings before each use.

## 0.1.90

- Dispatch authenticated in-page native device commands outside the serialized DOM navigation queue, so a slow fallback control cannot delay unrelated native controls.
- Return from native dispatch immediately after the authenticated patch is invoked and use the existing authoritative push/snapshot confirmation path for success.
- Expose allowlisted SmartThings presentation artwork on Home Assistant entities and create refresh buttons only from real observed refresh controls.
- Add a guarded live control benchmark that permits only the explicitly allowlisted Home Assistant entity, requires an initial and final OFF state, and records sanitized Bridge/HA timing evidence.

## 0.1.89

- Recover the authenticated keeper immediately when the consumer-web Socket.IO transport closes, and require a fresh complete snapshot before readiness returns.
- Treat only received WebSocket frames as push freshness so outbound traffic cannot hide a stalled subscription.
- Eliminate duplicate reconnect inventory fetches and avoid cloning the full inventory merely to emit the SSE sequence marker.
- Track active Home Assistant SSE connections for accurate transport diagnostics without adding polling.

## 0.1.88

- Treat a compatible historical protocol change count as durable history rather than a current mismatch in the physical-action probe, Core restart continuity operator, and sealed soak deployment gate.
- Continue to fail closed when the runtime is not ready/connected or when the protocol change count increases after the scenario baseline.

## 0.1.87

- Remove duplicate custom Chromium background flags after live HAOS process inspection confirmed that Playwright already supplies all three; retain the SSE and reconnect latency improvements without redundant launch arguments.

## 0.1.86

- Keep the authenticated SmartThings Web keeper socket responsive while its Chromium window is inactive by disabling background timer and renderer throttling.
- Disable Nagle delay for the local SSE stream and retry transient Bridge stream failures after 50 ms, with a bounded one-second backoff for repeated failures.

## 0.1.85

- Send the canonical `on`/`off` command used by captured Cake toggle exchanges when an observed safe toggle omits its optional command metadata, avoiding the slow detail-page fallback.

## 0.1.84

- Reverse the second sanitized device-alias generation as well as every component/capability generation used by DeviceStore, allowing the authenticated native command path to start from the public inventory alias.

## 0.1.83

- Parse bounded full-snapshot websocket frames up to 8 MiB for volatile native-command identifier mapping while retaining the smaller persisted diagnostic capture limit.
- Distinguish missing device, component, and capability mappings with fixed-value diagnostics that never reveal identifiers.

## 0.1.82

- Retain the third identifier-alias generation produced by sanitized component metadata plus DeviceStore normalization, so the authenticated native command path is available immediately after a full snapshot.

## 0.1.81

- Dispatch device commands through the authenticated in-page SmartThings Web client before any DOM navigation fallback, while preserving post-command push confirmation.
- Keep volatile raw identifiers only in process memory, clear them on browser restart, and never expose them through persistence, logs, SSE, or Home Assistant.
- Preserve the warm command page during background detail discovery and fail closed unless switch and refresh actions bind to exact observed toggle and refresh controls.
- Reject additional localized door control identities and keep graceful shutdown available when the final best-effort inventory persistence flush remains locked.

## 0.1.80

- Publish SmartThings push state to Bridge SSE before diagnostic capture and normalized-inventory persistence can block the live path.
- Coalesce full normalized-inventory persistence across event bursts, retry transient write failures, and flush the newest snapshot during graceful shutdown.
- Keep duplicate-delivery protocol counters intact without repeatedly persisting the same logical SmartThings Web device event.

## 0.1.79

- Deliver existing pushed states only to matching state and device listeners; run global discovery/registry listeners only for a new state key or inventory change.
- Scope inventory refresh writes to devices whose normalized state or metadata actually changed.
- Aggregate raw firmware fields into one read-only `update` entity, publish physical button pushes as `event` entities, apply official-style names/classes/categories, and consolidate richer-domain values into primary entity attributes while retaining other SmartThings Web-only values as diagnostic sensors.
- Drive native SmartThings Web range inputs for all observed numeric sliders and route enumerated media/fan/select options through their exact observed commands.
- Map speaker fast-forward/rewind to Home Assistant next/previous, preserve current-track metadata, and add brightness/color-temperature handling for observed light sliders.
- Keep read-only pushed content visible while exposing writable switch, light, fan, media, and number features only when their exact web control has been observed.

## 0.1.78

- Report the restored cached inventory count immediately after Bridge startup and browser reconnects, while keeping login-required sessions unready until fresh push proof returns.

## 0.1.77

- Wait for the exact visible Cake room-card heading to hydrate before considering slower page-wide accessibility fallbacks.
- Isolate Home Assistant entity-listener failures so one entity cannot interrupt the SSE push loop or block other sensor updates.
- Add direct Bridge SSE delivery, HA SSE parsing, and runtime-to-entity write regression coverage.

## 0.1.76

- Dispatch a navigation-only click event on the already verified unique visible same-page device wrapper, avoiding the fifteen-second actionability wait observed behind Cake's closing overlay.
- Keep the exact detail URL, visible device dialog, dialog-scoped control, and post-command push confirmation gates unchanged.

## 0.1.75

- Recover a dismissed warm detail from the already rendered exact device card before navigating anywhere, then require the exact detail URL and visible device dialog again before control lookup.
- Fall back to the exact room path when that immediate card is missing or fails, without reloading the SmartThings application at the slow verified detail URL.

## 0.1.74

- Resolve the exact visible Cake `draggable-room` heading through CSS before any page-wide accessibility-tree fallback, and go straight to the authoritative inventory room instead of probing the overview first.
- Reopen a dismissed warm device dialog at its already verified exact detail URL and revalidate the exact URL and dialog identity before control lookup, falling back to the exact room path only when that fails.
- Let foreground control proceed after background inspection preemption without waiting for the separate inspection page's potentially slow close operation.

## 0.1.73

- Resolve the exact room heading and its unique parent before scanning Cake's page-wide button accessibility tree, matching the observed `draggable-room` structure while retaining fail-closed room, device, dialog, and control checks.
- Keep a freshly verified detail route after same-page warm recovery fails, then independently revalidate its exact URL and device dialog on a new page before any control lookup.

## 0.1.72

- Replace the room target's retrying visibility wait with Playwright's non-waiting visibility check before dispatching its navigation-only click event.
- Preserve exact unique room, device card, device-detail URL, dialog identity, dialog-scoped control, and post-command push verification.

## 0.1.71

- Dispatch one exact click event to the already visible, unique navigation-only room target instead of waiting for Cake's slow navigation completion inside `Locator.click()`.
- Skip a known-invalid direct detail route after same-page warm recovery fails, then rebuild the exact room, device, and dialog context on one fresh page.

## 0.1.70

- Preempt background detail discovery as soon as a foreground command arrives, so inventory enrichment cannot hold the command queue.
- Recover a dismissed device dialog on the same warm page by reopening the exact room and device before any control lookup.
- Bound and force only the exact visible navigation-only room button, while retaining exact device, dialog, and control identity checks.

## 0.1.69

- Add fixed phase diagnostics for warm-page validation, verified-route reuse, room navigation, exact device selection, detail readiness, and toggle click completion.
- Keep diagnostic output free of device names, identifiers, URLs, values, and credentials while exposing the precise command latency boundary.

## 0.1.68

- Retry one cold room-navigation failure on a new page before any control probing, while preserving exact room, device, and detail-dialog matching.
- Close the failed page and never retry after control discovery starts or a mutation might have occurred.

## 0.1.67

- Preserve non-numeric pushed values such as battery health status without assigning Home Assistant numeric sensor classes.
- Reapply numeric device and state classes automatically when a later push contains a numeric measurement.

## 0.1.66

- Scope every control lookup to the exact verified device-detail dialog.
- Allow a unique dialog-local switch or checkbox when Cake exposes the observed Power toggle without an addressable label.
- Resynchronize Home Assistant from the Bridge-local full snapshot before every SSE connection and recover from transient stream authentication or connection failures.

## 0.1.65

- Require an exact device-only accessible heading when inventory has no room name.
- Reject prefix-matching device headings before probing any control.

## 0.1.64

- Match the device-detail dialog by its exact accessible device-and-room heading, mirroring Cake's live modal structure.
- Keep the background device card and partial device-name matches outside the readiness proof.

## 0.1.63

- Require the visible SmartThings device-detail dialog containing the exact device name before probing any control.
- Do not mistake the still-visible room card behind a routed modal for detail readiness.

## 0.1.62

- Allow a fresh or directly reopened detail page up to fifteen seconds to render the exact observed toggle swatch.
- Keep warm-page probes short and leave unrelated controls at their existing five-second bound.

## 0.1.61

- Give a unique control inside the exact observed swatch its own bounded visibility probe after late swatch rendering.
- Preserve exact scope, uniqueness checks, and push confirmation while avoiding a one-millisecond residual visibility timeout.

## 0.1.60

- Add fixed, identifier-free toggle discovery stages that distinguish missing names, exact swatch scope, and scoped accessibility-role counts.
- Keep the added live diagnostics observational only; target selection and push confirmation behavior are unchanged.

## 0.1.59

- Wait for the exact SmartThings device-detail route and visible identity before probing any control after a card click.
- Fail closed without clicking controls when Cake never completes the detail transition.
- Emit only fixed, identifier-free command navigation stages for live failure diagnosis.

## 0.1.58

- Accept a single button-rendered toggle only inside the exact observed Power swatch, while preserving switch/checkbox priority and ambiguity rejection.
- Shorten verified-detail and exact-room discovery probes so stale optimized routes fall back faster without weakening push confirmation.
- Retain a revalidated exact device-detail page for five minutes to accelerate consecutive commands on the same device.

## 0.1.57

- Apply the 500 ms push stability requirement to timeout-triggered full snapshot resynchronization as well as direct device events.
- Reject a requested state that reverses during the timeout boundary instead of confirming from a transient snapshot.
- Clear removed presentation metadata during Home Assistant's atomic inventory merge instead of retaining a stale icon/model hint.

## 0.1.56

- Open device details only by clicking the unique visible `data-testid="device"` wrapper; never click a page-wide named button, an exact text label, or a descendant inline action as a fallback.
- Delay command success until browser interaction has completed and the requested newer push value remains stable for 500 ms, rejecting transient values that immediately reverse.
- Preserve only allowlisted SmartThings active, inactive, and Lottie asset URLs, and use the published asset type when Cake reports the device type as `NONE`.
- Keep public presentation metadata separate from authoritative push/snapshot state; no SmartThings polling or asset-based state inference is added.

## 0.1.55

- Give foreground device, scene, and Home Monitor commands priority over optional background detail discovery.
- Close only the isolated background inspection page when a command arrives so it cannot block the UI queue for tens of seconds.
- Do not count command-preempted discovery as a failed or consumed inspection attempt.

## 0.1.54

- Recognize the live Cake `/location/<id>/rooms/device/<id>` detail route in addition to the direct `/location/<id>/device/<id>` route.
- Keep exact visible device-identity validation before retaining or reusing either route.
- Restore warm-page reuse for room-originated device details instead of closing them after every command.

## 0.1.53

- Retain verified device-detail routes in bounded process memory so controls do not repeat the full location/card search after a warm page expires.
- Revalidate the exact visible device identity before every direct-route reuse and discard stale or redirected routes.
- Keep route data ephemeral; nothing new is persisted to disk.

## 0.1.52

- Prefer the single accessibility `switch` when one observed Cake toggle also exposes its underlying `checkbox`.
- Continue to fail closed when the preferred role itself resolves to multiple controls.
- Preserve the exact-label scope and warm device-detail reuse for fast consecutive commands.

## 0.1.51

- Use the exact visible device-card opener on the current location view before falling back to the room route.
- Keep the room fallback for virtualized cards, but never restore the unsafe page-wide named-button shortcut.

## 0.1.50

- Remove the page-wide named-button shortcut that could select a device-card inline action instead of opening the detail route.
- Prefer the exact visible `data-testid="device"` wrapper and its unique name-bearing opener before locating any control.
- Keep room activation ahead of virtualized device-card discovery so control lookup starts only on the intended device detail page.

## 0.1.49

- Treat a validated transient SmartThings `GeneralError` 500 snapshot response as a request failure instead of permanently entering `PROTOCOL_CHANGED`.
- Advance the reviewed protocol contract to v4 so an earlier false-positive snapshot mismatch is cleared through the normal persisted-state migration.
- Reuse verified `/location/<id>/device/<id>` pages for consecutive commands instead of reopening the full location/room flow.
- Resolve observed exact-label toggles exposed as either an accessibility `switch` or native `checkbox`, while preserving ambiguity rejection.

## 0.1.48

- Restore Chromium session cookies across a clean app restart while pruning every restored tab except one verified SmartThings keeper before network observation starts.
- Preserve the concrete SmartThings location route on keeper recovery and fail closed when a command page has no verifiable location id.
- Revalidate the exact warm device detail URL and visible identity before every cached control action.
- Bound first-load control probes at 5 seconds and warm same-device probes at 1.5 seconds, prioritizing already-rendered localized labels before bounded late-render waits while preserving actual click and push-confirmation safety windows.
- Wait for delayed SmartThings SPA location-route changes before reporting a location change failure.

## 0.1.47

- Map the live Air Purifier `percent` slider and space-delimited `supportedAcFanModes` state into Home Assistant fan speed, number, preset, and mode-backed on/off controls.
- Parse the live speakers' space-delimited playback and track command lists so play, pause, stop, next, and previous controls remain available after a cached-inventory restore.
- Expose `playTrackAndResume` only when its exact detail control is observed, retaining exact UI targeting plus authoritative push confirmation.
- Include only sanitized Bridge error codes in every Home Assistant control failure so login, target, selector, and confirmation failures are distinguishable.

## 0.1.46

- Wait for the persistent Chromium context to close before the add-on process exits so session state can be flushed during a normal rebuild or restart.
- Retain the restart-safe cached inventory and push-confirmed UI command repairs from 0.1.45.

## 0.1.45

- Restore persisted inventories containing a valid `null` location update timestamp instead of discarding the entire cached snapshot after a Bridge restart.
- Retain the push-confirmed, UI-only warm command path and Home Assistant fan/error fixes from 0.1.44.

## 0.1.44

- Keep commands on the SmartThings Web UI click path only; remove the aborted direct Socket.IO command fallback from the release candidate.
- Retain the 0.1.43 command-page serialization and sanitized Bridge error-code propagation.
- Reuse a verified device-detail command page for sixty seconds so consecutive controls avoid a new tab, room navigation, and React detail render while preserving exact-target and push confirmation checks.
- Open a unique visible device directly from the location overview before using the exact-room fallback, and match known English/Korean control labels without waiting on the wrong locale.
- Pause background detail discovery while the warm command page is active, then close the page automatically before discovery resumes.

## 0.1.43

- Serialize SmartThings Web detail-discovery pages and user command pages so background control discovery cannot overlap the actual control click flow in the shared browser context.
- Preserve fixed Bridge command error codes in Home Assistant exceptions while keeping response bodies sanitized and secret-free.

## 0.1.42

- Match the current Home Assistant fan `turn_on` percentage and preset-mode service signature so HA no longer rejects fan power-on before reaching the Bridge.
- Use an already unique visible room device target immediately and prefer the exact observed labeled swatch before waiting on a missing accessible control name.
- Remove the two fixed 15-second waits observed ahead of a successful air-purifier power command while preserving unique-target and ambiguity checks.

## 0.1.41

- Treat an empty `api/device` result for a selected location as an authoritative zero-device snapshot instead of a permanent protocol mismatch.
- Advance the reviewed protocol contract so a previously persisted empty-location false positive cannot keep the Bridge blocked after the confirmed compatible snapshot shape returns.
- Include the 0.1.40 exact-toggle command routing and newer full-inventory command confirmation repair.

## 0.1.40

- Bind switch, light, fan, and media power commands to the exact observed SmartThings toggle instead of a different generic power control on multi-toggle devices.
- Accept a newer full SmartThings Web inventory snapshot as authoritative command confirmation when the direct push is missed, while retaining exact device/component/capability/attribute/value, sequence, and timestamp guards.
- Keep command state push/snapshot-grounded without optimistic Home Assistant mutation or SmartThings status polling.

## 0.1.39

- Add the official SmartThings icon to the Home Assistant add-on and local custom-integration brand assets, including the high-density integration variant.

## 0.1.38

- Foreground the isolated command page, activate the exact observed room before querying its lazily rendered device cards, and select the unique exact-name opener inside a multi-button card so commands follow the real SmartThings room UI without falling back to a same-named device or secondary card action.
- Exclude Cake's hidden duplicate device wrappers from exact-card ambiguity checks while preserving fail-closed behavior for multiple visible exact matches.
- Accept the one visible unnamed power switch used by the current Cake detail surface only when it is unambiguous; named and duplicated controls still fail closed.
- Treat only the observed Feathers `BadRequest`/400 request-error ACK as a failed snapshot request; 404 and server-error shapes still surface a protocol change, and the protocol contract advances to clear the earlier false-positive block safely.
- Keep command success dependent on a newer matching SmartThings push event; no optimistic state mutation or SmartThings polling is added.
- Add Home Assistant control-mode options, local Bridge-token reauthentication, Samsung-login Repairs, redacted diagnostics, and migration of obsolete duplicate number entries.

## 0.1.37

- Recover Bridge startup after the sanitized diagnostic database crossed Node's 2 GiB whole-file read limit.
- Keep the newest 50,000 diagnostic captures so the same restart failure cannot recur while preserving inventory and alias tables.

## 0.1.36

- Scope similarly named devices to the real SmartThings `data-testid=device` cards so room drag wrappers cannot make commands ambiguous.
- Drive detail sliders, toggles, and buttons from their visible swatch labels, matching the actual generic range, switch, and icon-button markup.
- Normalize enumerated `possibleStates` atomically and click only the observed status-to-command mapping while confirming the newer pushed status.
- Validate large private SQLite files by descriptor metadata instead of reading the entire database during startup.
- Retain only the newest 50,000 sanitized diagnostic captures and reapply that bound while observations continue.

## 0.1.35

- Prefer one exact SmartThings device-card name before partial-name matches so similarly named speakers remain safely addressable without weakening duplicate-name ambiguity checks.

## 0.1.34

- Scope CDP WebSocket identities to their browser session so repeated Chrome request IDs cannot cross-wire delayed acknowledgements.
- Accept camera thumbnail URLs nested inside the acknowledged SmartThings Web response envelope while keeping host, content type, redirect, and size validation fail-closed.

## 0.1.33

- Wait for asynchronously rendered named controls and give camera detail pages a longer bounded settle window so thumbnail ACKs can complete.
- Add push-only Home Assistant cover and climate entities plus observed enumerated select controls.
- Bind select, cover, and position commands to observed safe web controls and newer matching push confirmation while rejecting lock, valve, door, and garage control shapes.

## 0.1.32

- Serve camera thumbnail image bytes discovered from CDP-observed SmartThings Web Socket.IO ACKs.
- Keep capture storage non-fatal when a concurrent inspector holds the SQLite database.
- Remove stale Home Assistant `fan` registry entries that no longer classify as fan devices in the latest selected-location inventory.

## 0.1.31

- Correlate Socket.IO snapshot, detail, protocol, and camera thumbnail acknowledgements by WebSocket connection as well as ACK number.
- Preserve numeric level controls while preventing generic light and blind levels from creating false fan entities.

## 0.1.30

- Resynchronize inventory markers and expose normalized scenes, swatch controls, SmartThings Home Monitor, media, fan, number, button, and camera image surfaces.
- Confirm generic commands only from newer SmartThings push state, scene-location events, or Home Monitor arm-state inventory.
- Visit device details once on a separate bounded discovery page so the web app exposes every available swatch without using DOM content as device state.

## 0.1.29

- Add a safe authenticated switch command endpoint that serializes per device and succeeds only after a newer push event confirms the requested state.
- Keep command activity in a separate browser page while the keeper page remains observation-only.
- Add Home Assistant switch and fail-closed light entities without optimistic state updates.

## 0.1.28

- Keep physical-action correlation armed for valid component-less physical-action events by recording an explicit safe `unspecified` component.
- Accept the observed epoch-millisecond source timestamps in privacy-safe physical-action evidence.

## 0.1.27

- Restore live sensor and binary-sensor updates by reconciling component-less push events with the normalized snapshot state identity.
- Normalize epoch-millisecond event timestamps and reject older state events before they can overwrite newer snapshot values.
- Re-fetch and atomically merge Bridge inventory on SSE connection markers, sequence gaps, and Bridge sequence resets without adding SmartThings polling.

## 0.1.26

- Route the authenticated Bridge API to Home Assistant Core on internal port 8100 while allowing only the Core container address.
- Register 213 observed devices and 352 read-only entities on Home Assistant 2026.8.3, using state attributes that remain stable after capability identifiers are privacy-aliased.
- Permit cached inventory startup during a browser re-login window and use Home Assistant's supported illuminance unit constant.
- Add an authenticated local inventory API, one-time Ingress pairing codes, and an SSE state stream for the `smartthings_web` Home Assistant integration.
- Reconstruct all observed devices from the real SmartThings Web snapshot and update supported read-only sensor states from push events without SmartThings polling.
- Canonicalize generated package text as UTF-8/LF so equivalent cross-platform checkouts retain one manifest identity.
- Add a bounded in-memory physical-action correlation probe with fixed safe contact, motion, switch, and button presets.
- Require exactly one settled `/location` keeper page before arming and fail active evidence on browser isolation loss, protocol change, or runtime restart.
- Collapse Playwright/CDP duplicate deliveries into one logical candidate while exposing only safe metadata and an output-only SHA-256 logical-event hash.
- Add fixed no-store Ingress control responses with strict JSON validation, a 4 KiB request limit, and no request-body or raw-event logging.
- Keep commands, DOM state scraping, direct SmartThings APIs, and a persistent event journal outside the current limited alpha.
- Defer the interrupted 72-hour soak until after the first real Home Assistant device-registration result.

## 0.1.25

- Keep missing-event-ID deduplication source-independent by hashing the canonical sanitized Socket.IO delivery instead of an observer-specific capture envelope.
- Treat a changed value or event timestamp as a distinct fallback event while still collapsing the same delivery observed by Playwright and CDP.
- Align Phase 1 documentation with the already verified 0.1.24 add-on restart session and snapshot restore.
- Keep source backups outside `/addons` so duplicate local-app slugs cannot hide the newest package metadata.

## 0.1.24

- Attach Playwright and CDP network observers before keeper navigation, then reload an already restored authenticated SmartThings keeper once so restart-time snapshot requests cannot escape observation.
- Preserve Samsung login pages without automatic navigation and retain the 0.1.23 current-context readiness semantics.

## 0.1.23

- Keep readiness true for the current browser-context initial snapshot proof after the old 120-second snapshot TTL, while heartbeat freshness, recent push traffic, and current-context parser proof continue to gate readiness.
- Document the logged-in HAOS add-on validation that reached `CONNECTED`, observed 213 devices, decoded live device events, and kept `protocolChangeCount=0` and `restartCount=0`.
- Retain the owner-qualified `/proc` AppArmor write rule for Chromium's user-namespace setup and keep Phase 2 under the LIMITED evidence gate.

## 0.1.22

- Permit Chromium's HAOS user-namespace sandbox probe under enforced AppArmor with owner-qualified access to only the exact `/proc` map files it writes, while keeping the add-on's Docker privilege list empty and retaining `chromiumSandbox: true`.
- Allow the read-only GnuTLS configuration lookup observed during the same sandbox startup path.

## 0.1.21

- Allow HAOS Debian coreutils targets in the AppArmor profile so the `data-prep` oneshot can execute `chown` under enforced AppArmor.
- Run Openbox with temporary HOME/XDG cache paths to avoid root-home cache writes inside the confined add-on.

## 0.1.20

- Run the bridge and Chromium as the existing non-root `pwuser`, with a root-only data preparation oneshot for the add-on's private `/data` volume.
- Enable Playwright's Chromium sandbox explicitly and configure the pinned architecture-specific `chrome_sandbox` helper as `root:root` mode `4755`, without privileged mode, broad AppArmor access, a global sysctl change, or a `--no-sandbox` fallback.
- Add only the helper execution paths and the `chown`, `dac_override`, `setpcap`, and `sys_chroot` capabilities required by that fail-closed sandbox experiment.

## 0.1.19

- Run websockify in its standard proxy mode after live HAOS testing showed the distribution `--libserver` path accepted the WebSocket upgrade and then crashed on a missing `unix_listen` attribute.

## 0.1.18

- Keep the noVNC WebSocket URL relative to the `/novnc-ui/` Ingress page and proxy that exact path to websockify, preventing the duplicated `/novnc-ui/novnc/` route that completed an HTTP upgrade and then disconnected.

## 0.1.17

- Route the status-page login link through a fresh `/novnc-ui/` asset namespace and mark noVNC assets `no-store`, avoiding stale edge-cached MIME responses without requiring an external cache purge.

## 0.1.16

- Load nginx's standard MIME map so noVNC styles, ES modules, fonts, and images are served with browser-accepted content types through Ingress.
- Permit only the nginx MIME map plus the standard fontconfig and Openbox configuration trees required by the confined desktop session.

## 0.1.15

- Restore compatibility with the Home Assistant OS 18.2 AppArmor parser after it rejected the newer `userns` rule syntax.
- Serve noVNC static assets directly from nginx and run websockify on its thread-based library server so HTTP requests do not depend on per-request child processes under confinement.

## 0.1.14

- Allow user-namespace creation only inside the add-on's AppArmor profile so the pinned Chromium build can initialize its Linux sandbox without global sysctl or privileged-container changes.

## 0.1.13

- Allow read and executable mapping only for the pinned Playwright Chromium revision, with explicit amd64 and aarch64 browser and crash-handler entrypoints.

## 0.1.12

- Match the Supervisor-owned persistent data root as a directory (`/data/`) so AppArmor permits its metadata validation without broad file access.
- Use s6-overlay's bundled millisecond sleep utility while waiting for Xvfb readiness, avoiding ambiguous system `sleep` resolution under confinement.

## 0.1.11

- Permit only the `setgid` and `setuid` capabilities Xvfb needs to drop root privileges inside the AppArmor-confined container.
- Emit path-free initialization stage markers so startup permission failures can be isolated without exposing private data paths or contents.

## 0.1.10

- Reuse the existing `/tmp` directory for nginx and emit only an allowlisted startup error code for safe live diagnostics.
- Keep nginx's worker identity aligned with the already-root, AppArmor-confined service container so startup performs no ownership changes.

## 0.1.9

- Keep nginx temporary state in `/tmp`, let the bridge own `/data` initialization, and allow only the standard TLS configuration tree needed by Node.

## 0.1.8

- Allow nginx to read only its generated configuration and Xvfb to write only its keyboard-cache directory.

## 0.1.7

- Permit only the nginx binary under `/usr/sbin` and disable the unnecessary Xvfb lock file in the single-display container.

## 0.1.6

- Match both the pinned s6 bootstrap directories and their contents so s6 can enumerate its immutable service sources.

## 0.1.5

- Move the service bundle to s6-overlay's current `user-bundles.d` layout so startup does not rewrite the immutable image configuration.

## 0.1.4

- Declare the s6 user service bundle in the image so startup never needs to modify the read-only `/etc/s6-overlay` tree.

## 0.1.3

- Allow read access only to the pinned s6-overlay interpreter and bootstrap-data subtrees required by its verified startup chain.

## 0.1.2

- Allow the pinned s6-overlay `preinit` interpreter to be read without broadening the rest of `/package`.

## 0.1.1

- Reload the enforced Home Assistant AppArmor profile with read access for the s6 `/init` entrypoint.

## 0.1.0

- Initial Phase 1 inspector add-on skeleton.
- Added read-only protocol observation boundary, static API/secret audit gates, and a LIMITED evidence gate that keeps Phase 2 closed.

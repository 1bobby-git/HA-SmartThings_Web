# Observed my.smartthings.com Behavior

This note records privacy-safe aggregate findings from a user-supplied local
SmartThings Web wire capture and the live Home Assistant OS installation. The
source capture is not committed, copied into fixtures, or used as a runtime
credential source.

## Session and push transport

- One SmartThings Web Socket.IO connection carried one client-side
  `authenticate` exchange and subsequent subscription traffic.
- The supplied window contained 121 DEVICE_EVENT deliveries representing 42
  unique logical events. Seventy-nine deliveries were duplicates: 37 logical
  events appeared three times and 5 appeared twice.
- The unique pushed attributes in that window included illuminance, TVOC,
  fine dust, RSSI, LQI, temperature, CO2, formaldehyde, switch, and contact.
- Unique-event delivery lag in the supplied capture was 832 to 1,212 ms, with
  a 922 ms median.

The Bridge therefore deduplicates by authoritative event identity, with a
sanitized payload fingerprint only when that identity is absent. It does not
deduplicate by device, attribute, or a coarse time bucket, because that would
discard valid consecutive state changes.

## Consecutive physical changes

The supplied capture recorded deliberate switch and contact transitions. The
shortest opposite-state intervals were approximately one second:

- switch on to off: 1,082 ms;
- switch on to off in a later sequence: 997 ms;
- contact open to closed: 1,043 ms;
- contact open to closed in a later sequence: 998 ms.

Every transition remained a separate logical event. Home Assistant Recorder
also retained the corresponding contact changes in order, with `last_updated`
changes within seconds of the SmartThings source times. This is consistent
with the earlier independent temperature and contact correlation proofs and
does not require SmartThings state polling.

## Detail controls and entity mapping

The actual detail traffic included read-only value controls, a numeric volume
slider with `setVolume`, and an enumerated alarm control. The live normalized
inventory also exposes controls such as Received Signal Metrics and typed
sliders or enumerations when SmartThings Web provides them. The integration
maps these shapes by semantics:

- contact and motion become `binary_sensor` entities;
- measurements and otherwise unknown pushed values remain `sensor` entities;
- numeric sliders become `number` entities unless a richer primary domain owns
  the control;
- enumerations become `select` entities unless owned by media, fan, climate,
  cover, or another richer domain;
- speaker playback, volume, mute, power, track metadata, and observed transport
  commands become `media_player` features;
- shade and thermostat controls become `cover` and `climate` entities;
- location scenes and pushed SmartThings Home Monitor state become `scene` and
  `alarm_control_panel` entities.

Only commands validated from normalized control metadata are actionable.
Version 0.1.147 separates Advanced data enrichment from live command evidence.
Unproven Advanced POSTs are not sent; the observed Location-native dispatcher
is the default transport and a verified DOM control remains the final fallback.
An uncertain receipt or timeout never causes a second physical dispatch.

## Advanced primary inventory and commands

The Advanced device endpoint is paginated. The Bridge follows server links
first and otherwise continues with `isNext/max/page`, merging all pages by raw
SmartThings `deviceId` before redaction and normalization. Advanced locations,
rooms, device state, health, profile/capability metadata, and supported command
schemas feed the existing `DeviceStore`; a single observed page is never an
authoritative deletion snapshot.

The same persistent Chromium session serves the Location keeper and Advanced
requests. Requests run in the keeper when origin policy permits and use a
short-lived Advanced page only as a fallback. Browser profile data, cookies,
storage state, authorization, CSRF, and raw identifiers remain outside logs,
diagnostics, persisted inventory, and HA service data.

An Advanced HTTP `200` with `ACCEPTED` is a transport receipt. Stateful commands
remain pending until a matching post-send Location event or an Advanced status
recheck proves the value. Stateless refresh, press, and media track commands
return `ACCEPTED_UNCONFIRMED` without inventing a persistent state. Recovered
Socket.IO sessions trigger one full Advanced reconciliation after the first
new inbound frame.

Home Assistant exposes a switch only when the exact state has one reversible
observed toggle. Advanced-only secondary switch states remain available to the
normalized inventory but do not become misleading controls. Repeated component
Refresh controls collapse to one main device button. A strong same-owner
Cloud/Local child mirror can share the existing Cloud device card; ordinary
same-name devices remain separate.

The user-supplied Cake `2.57.0` asset and its published source maps were also
reviewed as implementation evidence. They show that room drag wrappers and
device cards can both be buttons, while each real device is wrapped by
`data-testid="device"`. Detail sliders use a generic `aria-label="range"`
under a visible swatch label. Button swatches likewise put the visible label
beside an icon-only button. Enumerated swatches render each visible option
label beside a button carrying the authoritative `data-command`; they are not
comboboxes. Toggle swatches also keep their label beside a generic switch.
Versions 0.1.36 and 0.1.37 follow those exact boundaries: they scope device
selection to real device wrappers, scope sliders/buttons to their observed
swatch label, and retain an atomic `status` to `label` to `command` mapping
from `possibleStates`.

Version 0.1.56 adds fresh live Cake evidence for command targeting. One exact
visible room device wrapper contained multiple descendant buttons, including an
inline power action, while Cake also kept hidden duplicate markup. Clicking the
card body opens details; clicking a descendant action changes device state.
The Bridge therefore clicks only the unique visible `data-testid="device"`
wrapper and never falls through to a page-wide named button, exact text label,
or descendant control. Once opened, the power control exposed one accessible
`switch`, one underlying `checkbox`, visible `Power` text, but no switch whose
accessible name was exactly `Power`. The Bridge scopes the unique toggle to the
exact observed Power swatch and does not accept a page-wide unlabeled switch.
A controlled `off → on → off` cycle was
confirmed only by newer push events and produced ordered companion power
changes of `0 W → 16 W → 0 W` in Home Assistant within about two seconds of
their Bridge timestamps.

The device-card snapshot also carries public `icon`, `inactiveIcon`, and
`lottieData.icon` metadata. The Lottie JSON is presentation data, not device
state. Version 0.1.56 preserves only allowlisted SmartThings/Samsung asset URLs
and derives a bounded asset type such as `hub` or `contact_sensor` when Cake's
device type is `NONE`; it never polls those assets or infers state from their
animation frames. Home Assistant's integration device-list row currently
hard-codes `mdiDevices`, so a custom integration cannot replace that exact row
with remote per-device images without modifying Home Assistant Frontend.

A later live room-card inspection confirmed that Cake opens room-originated
details at `/location/<id>/rooms/device/<id>`, while dashboard-originated
details can use `/location/<id>/device/<id>`. Version 0.1.54 accepts both only
after the exact visible device identity is revalidated, allowing the verified
detail page and its process-memory route to be reused for later controls.

A fresh live comparison found that the routed page can still show the exact
device card behind the modal before the detail content is ready. Cake exposes
the actual detail surface as one visible `role="dialog"` whose descendants
contain the device controls. Version 0.1.63 therefore requires that dialog to
contain the exact device name before probing any control; the background room
card alone no longer satisfies detail readiness.

The visible device name is not an exact standalone text node inside that
dialog: Cake combines it with the back affordance and room name. The dialog's
`h1` instead exposes an exact accessible name in the form `device + room`.
Version 0.1.64 uses that accessible heading for exact identity validation.
Version 0.1.65 also fails closed when the room is unknown: only an exact
device-only accessible heading is accepted, never a prefix-matching device.
Version 0.1.66 scopes every control lookup to that exact dialog. If Cake's
Power label cannot be addressed, only one dialog-local switch or checkbox is
accepted; a background-card control is never a fallback. The HA event loop also
fetches one Bridge-local full snapshot before each SSE connection and retries
transient stream authentication/connection failures without polling SmartThings.

## Camera behavior

An earlier supplied capture contained two thumbnail requests and no
corresponding response. A later user-supplied wire capture exposed the complete
path used by the current site: a pushed `image` state contains an allowlisted
signed media URL, the page sends `get api/camera/thumbnail` with that URL, the
server answers with a Socket.IO binary ACK placeholder, and the next WebSocket
binary frame contains the still-image bytes. The bytes are not an ordinary URL
ACK and were therefore invisible to the original URL-only cache.

Version 0.1.94 correlates the image-state URL, request ACK identifier, WebSocket
connection, binary placeholder count, and following image frame in memory. It
accepts only JPEG, PNG, or WebP magic bytes within the existing size limit,
persists only private image bytes plus non-secret metadata, and serves them
through the authenticated Bridge image route. Camera detail discovery is also
attempted a bounded number of times even when the camera already exposes other
controls, allowing the web application to issue its natural thumbnail request.
No SmartThings status polling, DOM pixel fallback, signed-URL persistence, or
cookie replay is added.

## Login persistence and privacy

Login persistence was already implemented before this capture was supplied.
Samsung login occurs only inside the add-on's headed Chromium, whose dedicated
profile is stored at `/data/chromium-profile`. The web application performs its
own Socket.IO authentication and reauthentication. Cookies, CSRF values, user
identifiers, and authentication payloads are not copied into source or Bridge
configuration.

The 0.1.37 Supervisor rebuild preserved that profile directory, but the next
SmartThings navigation was redirected to Samsung login. This is an observed
session expiry, not evidence that the profile was replaced. The add-on keeps
liveness and Ingress available while readiness and inventory synchronization
remain blocked until the user completes manual browser reauthentication.

The 0.1.139 candidate was deployed and reached live, ready, `CONNECTED`
operation after restart, but the immediate post-restart status response covered
206 device IDs and omitted the safe target. The target device existed in the
restored inventory without controls, so the restart-time control gap remained.

Version 0.1.145 is deployed and the authenticated session restored automatically
through four consecutive add-on updates and repeated Home Assistant Core
restarts. The final live report was `live=true`, `ready=true`, `CONNECTED`, and
covered 232 devices without a browser restart. The non-navigation same-origin
`/location` touch remains gated away from commands, detail discovery, physical
probes, non-isolated pages, login pages, and stale browser contexts. It does not
inspect DOM state, read cookies, call Advanced/device/scene/command endpoints,
or reload the keeper page.

The same live deployment used Advanced component roles plus the configured
SmartThings location name to render Jump3's four presence sensors as
`부모님댁`, `친정집`, `회사`, and `Home`. Repeated registry migration stayed
idempotent. Deleted `dev_N` cards and entities were removed only from the ready
inventory while `loc_N` location cards were preserved. Primary-control IDs and
visuals were also verified as `switch.eohang`, `fan.hwanpunggi`, Device-settings
Refresh with `mdi:refresh`, and mapped control icons.

The supplied capture was labelled safe but still contained account-related
metadata inside a third-party feature-delivery URL. It was therefore treated as
sensitive local evidence and was not added to the repository.

`DECISION: LIMITED` remains in force until the cached camera bytes, 72-hour
durability, host-reboot recovery, and remaining device-family gates are verified
on HAOS.

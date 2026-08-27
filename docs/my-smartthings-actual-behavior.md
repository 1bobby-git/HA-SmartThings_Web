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

Only controls actually observed on the SmartThings Web detail page are
actionable. A command is successful only after a newer authoritative push
confirms the requested value. Missing controls fail closed instead of clicking
a similarly shaped page element.

## Advanced device bootstrap

An authenticated inspection of `https://my.smartthings.com/advanced` confirmed
that the page naturally loads same-origin
`/advanced/cupcake-api/api/devices` JSON containing device identity,
location/room, health, category/type, presentation/profile information,
component capability status, and allowed-action metadata. The status tree is
useful for initial and reconnect enrichment, especially for refrigerator
compartments and appliance values that are distributed across components.

Version 0.1.95 observes that naturally loaded response once per new Chromium
context after installing the existing CDP network observer, redacts it, merges
only metadata and state into DeviceStore, publishes one inventory transition,
and closes the temporary Advanced page. Component and capability identifiers
remain aliases; only a small allowlist of semantic roles such as cooler,
freezer, pantry, ice maker, hub, setup, and Bixby is carried separately for
localized Home Assistant labels. `updatedAt` ordering prevents the bootstrap
from replacing newer push state.

The Advanced `allowedActions` field is descriptive evidence only. It is not
converted into a Bridge control, and the implementation does not send direct
Cupcake commands, periodically fetch status, replay cookies, or treat Advanced
JSON as a replacement for the authoritative SmartThings Web push stream.

The supplied capture also contains four accepted device command exchanges.
Cake sends them through its already authenticated Feathers client as
`service("api/device").patch(deviceId, {query: {execute: true, commands}})`
over the same Socket.IO transport used by the web application. Version 0.1.85
uses that existing in-page dispatcher first, retaining raw device, component,
and capability identifiers only in volatile process memory. It does not export
cookies, replay authentication, create a second public API client, or treat the
command ACK as state confirmation. If the dispatcher is not available before
dispatch, the exact observed UI control remains the fallback; a rejected or
uncertain dispatched command is never repeated through the UI.

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

The supplied capture was labelled safe but still contained account-related
metadata inside a third-party feature-delivery URL. It was therefore treated as
sensitive local evidence and was not added to the repository.

`DECISION: LIMITED` remains in force until the current candidate is deployed and
the cached camera bytes, Advanced bootstrap, 72-hour durability, host-reboot
recovery, and remaining device-family gates are verified on HAOS.

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

The user-supplied Cake `2.57.0` asset and its published source maps were also
reviewed as implementation evidence. They show that room drag wrappers and
device cards can both be buttons, while each real device is wrapped by
`data-testid="device"`. Detail sliders use a generic `aria-label="range"`
under a visible swatch label. Button swatches likewise put the visible label
beside an icon-only button. Enumerated swatches render each visible option
label beside a button carrying the authoritative `data-command`; they are not
comboboxes. Toggle swatches also keep their label beside a generic switch.
Version 0.1.36 follows those exact boundaries: it scopes device
selection to real device wrappers, scopes sliders/buttons to their observed
swatch label, and retains an atomic `status` to `label` to `command` mapping
from `possibleStates`.

## Camera behavior

The supplied capture contained two thumbnail requests and no corresponding ACK
or image-media response. A later live refresh attempt likewise found no exact
observed refresh control and safely refused the command. Version 0.1.34 scopes
WebSocket request correlation per CDP observer session so a delayed camera ACK
cannot be attached to a reused request identifier, and it accepts a signed
thumbnail URL only after the existing HTTPS host, credential, redirect, MIME,
and size checks.

The Home Assistant image entities and refreshable private image cache are
implemented. They remain empty when SmartThings Web or the device supplies no
thumbnail ACK or bytes; DOM pixels are never used as a fallback state source.

## Login persistence and privacy

Login persistence was already implemented before this capture was supplied.
Samsung login occurs only inside the add-on's headed Chromium, whose dedicated
profile is stored at `/data/chromium-profile`. The web application performs its
own Socket.IO authentication and reauthentication. Cookies, CSRF values, user
identifiers, and authentication payloads are not copied into source or Bridge
configuration.

The supplied capture was labelled safe but still contained account-related
metadata inside a third-party feature-delivery URL. It was therefore treated as
sensitive local evidence and was not added to the repository.

`DECISION: LIMITED` remains in force because this bounded evidence does not
prove 72-hour durability, host-reboot recovery, every device family, or camera
image availability.

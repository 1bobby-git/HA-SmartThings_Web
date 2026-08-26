# Official SmartThings Parity Matrix

This matrix was rechecked against the installed Home Assistant Core `2026.8.3`
source at `homeassistant/components/smartthings`. No official integration code or
credentials are copied into this repository. `smartthings_web` keeps its own
domain, browser-session transport, identifiers, and limited-alpha safety gates.

## Shared architecture

| Concern | Official integration | SmartThings Web integration |
| --- | --- | --- |
| State delivery | SmartThings subscription callbacks update entities. | Bridge Socket.IO observation is normalized, sent over authenticated local SSE, atomically merged, and delivered to entity listeners. |
| Polling | Entities set `should_poll = False`. | Entities set `should_poll = False`; SmartThings state polling is not used. |
| Entity update | Capability listeners update attributes and call `async_write_ha_state()`. | Runtime listeners read the latest immutable inventory and call `async_write_ha_state()`. |
| Device identity | `(smartthings, device_id)`. | `(smartthings_web, device_id)`; official entities are never adopted or renamed. |
| Availability | Device availability plus integration connectivity. | Pushed device health plus Bridge disconnect grace/stale timeout. |
| Commands | SmartThings SDK commands and scene execution. | Logged-in SmartThings Web UI actions on a separate command page, confirmed only by a newer push event. |

## Platform status

`Verified` means the normalized input and HA mapping are covered by tests and
the platform is registered. A control is exposed only when its web control
shape is observed; value-only swatches remain read-only.

| Platform | Official 2026.8.3 pattern | `smartthings_web` status |
| --- | --- | --- |
| `binary_sensor` | Contact, motion, presence, water, smoke/CO, tamper and related binary capabilities. | Verified. Contact and motion are excluded from generic sensors and mapped to binary sensors. |
| `sensor` | Typed measurements plus appliance/status attributes. | Typed temperature, humidity, power, battery, illuminance, air-quality, particulate, VOC/formaldehyde, filter-life, signal, duration, and camera metadata are enabled. SmartThings Web-specific pushed content remains exposed as diagnostic sensors; only values consolidated into a richer domain are moved into that entity's attributes instead of duplicated. |
| `switch` | Main switch is suppressed for richer media/appliance domains. | Verified. Media, fan, light, and binary states are not duplicated as primary switches. |
| `light` | Switch, level, color temperature, and supported color modes. | Observed level and color-temperature sliders are mapped to brightness and color temperature; hue/saturation content remains visible without advertising an unobserved color picker. |
| `button` | Fixed capability commands with stable command-based unique IDs. | Only exact observed web button controls are created. Synthetic Refresh controls are removed; a real Refresh appears automatically if the web detail actually exposes one. |
| `number` | Observed numeric ranges and typed set commands. | Verified for exact observed sliders including detection frequency, fan speed, and device-specific numeric controls. Volume, light brightness/color temperature, cover position, and climate setpoints stay on their richer primary entity instead of becoming duplicate numbers. A numeric state without a matching web slider stays read-only instead of creating a dead number control. |
| `fan` | Switch, fan speed percentage, and fan-mode presets. | Verified for fan/purifier evidence; generic `level` alone is not sufficient. |
| `media_player` | Playback commands, track controls, volume, mute, power, and track data. | Power, play/pause/stop, observed fast-forward/rewind options mapped to next/previous, native range volume, mute, current track, and `playTrackAndResume` are mapped; raw media content is retained as attributes. |
| `scene` | Scene ID entity; activation executes the scene. | Verified from the normalized scene snapshot and push-confirmed Bridge execution. |
| `alarm_control_panel` | Not an official SmartThings platform. | Added specifically for the pushed SmartThings Home Monitor location arm state. |
| `image` | Not an official SmartThings platform. | Added for refreshed camera still images cached from observed SmartThings Web thumbnail traffic; pixels are never used as device state. |
| `cover` | Window-shade state, position, and observed shade commands. | Implemented for `windowShade`, `shadeLevel`, and observed shade controls; unsupported actions remain hidden. |
| `climate` | Thermostat mode, temperature, setpoints, and supported modes. | Implemented for thermostat evidence; target/mode controls require observed slider/enumerated controls. |
| `select` | Enumerated capability options with a typed command. | Implemented only for observed enumerated controls with explicit options and outside richer primary domains. |
| `event` | Momentary capability events. | Standard button state and `supportedButtonValues` are combined into a push-driven button event entity, including repeated events distinguished by sequence and `updatedAt`. |
| `time` | Writable time capabilities. | Not created without an observed writable time control; timestamp content remains a sensor. |
| `update` | Installed/latest firmware version with optional install semantics. | `currentVersion`, `availableVersion`, state, and update availability are combined into one read-only firmware update entity. Install remains hidden because no safe observed web install control exists. |
| `lock` | Lock/unlock commands and lock state. | Deliberately read-only through sensor fallback until the dangerous-command gate is explicitly enabled and verified. |
| `valve` | Valve state and open/close commands. | Deliberately not controllable; water-leak state is a binary sensor and is not treated as a valve. |
| `vacuum` | Robot state and verified cleaning commands. | No verified normalized control candidate. |
| `water_heater` | Operation mode and temperature controls. | No verified normalized control candidate. |

## Official conventions retained

- Push-only entities and listener-driven `async_write_ha_state()` updates.
- Device registry identifiers owned by the integration domain.
- Stable unique IDs that include device/component/state or observed control ID.
- Feature flags derived from observed supported commands/ranges rather than a
  device-name guess.
- Writable switch, light, fan, media, number, select, button, cover, and climate
  features require their exact observed web control; pushed state alone remains
  available but does not create a dead service button.
- Main-switch suppression when a richer platform owns the device.
- Official-style firmware aggregation, translated entity names, diagnostic
  categories, and device configuration URLs without adopting official registry
  identifiers.
- No optimistic state mutation: command completion requires a newer
  authoritative event or returns an error and requests a full resynchronization.

`DECISION: LIMITED` remains in force. Platform presence is not evidence for
72-hour durability, host-reboot recovery, or every appliance command family.

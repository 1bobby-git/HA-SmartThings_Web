"""Runtime models for SmartThings Web."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
import logging
import re
from typing import Any, Literal
from urllib.parse import urlparse


_LOGGER = logging.getLogger(__name__)


@dataclass
class BridgeState:
    """One current SmartThings attribute."""

    component: str
    capability: str
    attribute: str
    value: Any
    unit: str | None
    updated_at: str | None
    component_role: str | None = None
    capability_role: str | None = None

    @property
    def key(self) -> tuple[str, str, str]:
        """Return the stable state key."""
        return (self.component, self.capability, self.attribute)


@dataclass
class BridgeDevicePresentation:
    """Allowlisted SmartThings presentation metadata from the device snapshot."""

    asset_type: str | None = None
    icon_url: str | None = None
    inactive_icon_url: str | None = None
    animation_url: str | None = None


@dataclass
class BridgeDevice:
    """One Bridge device."""

    device_id: str
    location_id: str
    room_id: str | None
    name: str
    device_type: str | None
    online: bool
    presentation: BridgeDevicePresentation | None = None
    states: dict[tuple[str, str, str], BridgeState] = field(default_factory=dict)
    controls: dict[str, "BridgeControl"] = field(default_factory=dict)


@dataclass(frozen=True)
class BridgeControl:
    """One normalized control discovered from SmartThings Web detail swatches."""

    control_id: str
    kind: str
    label: str | None
    component: str | None = None
    capability: str | None = None
    attribute: str | None = None
    commands: tuple[str, ...] = ()
    options: tuple[str, ...] = ()
    option_labels: dict[str, str] = field(default_factory=dict)
    option_commands: dict[str, str] = field(default_factory=dict)
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None


@dataclass(frozen=True)
class BridgeLocation:
    """One SmartThings location."""

    location_id: str
    name: str
    arm_state: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True)
class BridgeScene:
    """One SmartThings scene."""

    scene_id: str
    location_id: str
    name: str
    updated_at: str | None = None


@dataclass
class BridgeInventory:
    """Current Bridge inventory."""

    sequence: int
    ready: bool
    bridge_version: str
    protocol_version: str
    locations: dict[str, BridgeLocation | str]
    rooms: dict[str, tuple[str, str]]
    devices: dict[str, BridgeDevice]
    scenes: dict[str, BridgeScene] = field(default_factory=dict)


@dataclass(frozen=True)
class BridgeCommandResult:
    """Verified result returned by the local Bridge command endpoint."""

    status: Literal["confirmed", "already_confirmed"]
    sequence: int
    confirmation: Literal[
        "device_event",
        "inventory_snapshot",
        "current_state",
        "security_arm_state_event",
    ]


@dataclass
class SmartThingsWebRuntime:
    """Config-entry runtime state."""

    client: Any
    location_id: str
    inventory: BridgeInventory
    listeners: set[Callable[[], None]] = field(default_factory=set)
    state_listeners: dict[
        tuple[str, tuple[str, str, str]], set[Callable[[], None]]
    ] = field(default_factory=dict)
    device_listeners: dict[str, set[Callable[[], None]]] = field(default_factory=dict)

    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to state changes."""
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)

    def subscribe_state(
        self,
        device_id: str,
        state_key: tuple[str, str, str],
        listener: Callable[[], None],
    ) -> Callable[[], None]:
        """Subscribe to one exact pushed device state."""
        key = (device_id, state_key)
        self.state_listeners.setdefault(key, set()).add(listener)
        return lambda: self._remove_scoped_listener(self.state_listeners, key, listener)

    def subscribe_device(
        self, device_id: str, listener: Callable[[], None]
    ) -> Callable[[], None]:
        """Subscribe to any pushed state or inventory change for one device."""
        self.device_listeners.setdefault(device_id, set()).add(listener)
        return lambda: self._remove_scoped_listener(
            self.device_listeners, device_id, listener
        )

    async def handle_event(self, event: dict[str, Any]) -> bool:
        """Apply one SSE event, resynchronizing on reconnects and gaps."""
        if event.get("type") == "inventory":
            if _event_sequence(event) == self.inventory.sequence:
                return False
            return self.apply_inventory(await self.client.async_get_inventory())
        if event.get("type") != "state":
            return False
        sequence = _event_sequence(event)
        if sequence is None:
            return self.apply_inventory(await self.client.async_get_inventory())
        if sequence <= self.inventory.sequence:
            return False
        changed = False
        if sequence > self.inventory.sequence + 1:
            changed = self.apply_inventory(await self.client.async_get_inventory())
            if sequence <= self.inventory.sequence:
                return changed
            if sequence > self.inventory.sequence + 1:
                return changed
        return self.apply_state(event) or changed

    def apply_inventory(self, latest: BridgeInventory) -> bool:
        """Atomically merge the newest full or partial Bridge inventory."""
        current = self.inventory
        authoritative = latest.ready
        devices = {} if authoritative else deepcopy(current.devices)
        for device_id, latest_device in latest.devices.items():
            existing = current.devices.get(device_id)
            if existing is None:
                devices[device_id] = deepcopy(latest_device)
                continue
            states = {} if authoritative else deepcopy(existing.states)
            for key, candidate in latest_device.states.items():
                present = existing.states.get(key)
                if present is None or _state_is_newer(candidate, present):
                    states[key] = deepcopy(candidate)
                elif authoritative:
                    states[key] = deepcopy(present)
            devices[device_id] = BridgeDevice(
                device_id=latest_device.device_id,
                location_id=latest_device.location_id,
                room_id=latest_device.room_id,
                name=latest_device.name,
                device_type=latest_device.device_type,
                online=latest_device.online,
                presentation=latest_device.presentation,
                states=states,
                controls=(
                    deepcopy(latest_device.controls)
                    if authoritative
                    else {**existing.controls, **latest_device.controls}
                ),
            )
        merged = BridgeInventory(
            sequence=latest.sequence,
            ready=latest.ready,
            bridge_version=latest.bridge_version,
            protocol_version=latest.protocol_version,
            locations=(
                _merge_locations(
                    {
                        location_id: location
                        for location_id, location in current.locations.items()
                        if location_id in latest.locations
                    },
                    latest.locations,
                )
                if authoritative
                else _merge_locations(current.locations, latest.locations)
            ),
            rooms=(
                deepcopy(latest.rooms)
                if authoritative
                else {**current.rooms, **latest.rooms}
            ),
            devices=devices,
            scenes=(
                _merge_scenes(
                    {
                        scene_id: scene
                        for scene_id, scene in current.scenes.items()
                        if scene_id in latest.scenes
                    },
                    latest.scenes,
                )
                if authoritative
                else _merge_scenes(current.scenes, latest.scenes)
            ),
        )
        if merged == current:
            return False
        changed_device_ids = {
            device_id
            for device_id in current.devices.keys() | merged.devices.keys()
            if current.devices.get(device_id) != merged.devices.get(device_id)
        }
        self.inventory = merged
        self._notify_listeners(device_ids=changed_device_ids)
        return True

    def apply_state(self, event: dict[str, Any]) -> bool:
        """Apply one push state event."""
        device_id = event.get("deviceId")
        raw = event.get("state")
        if not isinstance(device_id, str) or not isinstance(raw, dict):
            return False
        device = self.inventory.devices.get(device_id)
        if device is None or device.location_id != self.location_id:
            return False
        state = parse_state(raw)
        if state is None:
            return False
        sequence = _event_sequence(event)
        if sequence is None or sequence <= self.inventory.sequence:
            return False
        current = device.states.get(state.key)
        new_state_key = current is None
        self.inventory.sequence = sequence
        repeated_event = (
            current is not None
            and state.attribute in EVENT_ATTRIBUTES
            and _timestamp(state.updated_at) == _timestamp(current.updated_at)
        )
        if current is not None and not _state_is_newer(state, current) and not repeated_event:
            return False
        device.states[state.key] = state
        self._notify_listeners(
            device_ids={device_id},
            state_keys={(device_id, state.key)},
            notify_global=(
                new_state_key or state.attribute in DEVICE_REGISTRY_ATTRIBUTES
            ),
        )
        return True

    def _notify_listeners(
        self,
        *,
        device_ids: set[str] | None = None,
        state_keys: set[tuple[str, tuple[str, str, str]]] | None = None,
        notify_global: bool = True,
    ) -> None:
        listeners = set(self.listeners) if notify_global else set()
        if device_ids is None:
            for scoped in self.device_listeners.values():
                listeners.update(scoped)
            for scoped in self.state_listeners.values():
                listeners.update(scoped)
        else:
            for device_id in device_ids:
                listeners.update(self.device_listeners.get(device_id, ()))
            if state_keys is None:
                for (device_id, _state_key), scoped in self.state_listeners.items():
                    if device_id in device_ids:
                        listeners.update(scoped)
            else:
                for key in state_keys:
                    listeners.update(self.state_listeners.get(key, ()))
        for listener in tuple(listeners):
            try:
                listener()
            except Exception:  # noqa: BLE001 - one HA entity must not break the push loop
                _LOGGER.exception("runtime_listener_failed")

    @staticmethod
    def _remove_scoped_listener(
        listeners: dict[Any, set[Callable[[], None]]],
        key: Any,
        listener: Callable[[], None],
    ) -> None:
        scoped = listeners.get(key)
        if scoped is None:
            return
        scoped.discard(listener)
        if not scoped:
            listeners.pop(key, None)


ControlKind = Literal["switch", "light"]

BINARY_ATTRIBUTES = frozenset(
    {
        "acceleration",
        "carbonMonoxide",
        "contact",
        "doorState",
        "filterStatus",
        "gas",
        "motion",
        "presence",
        "smoke",
        "sound",
        "tamper",
        "water",
    }
)

EVENT_ATTRIBUTES = frozenset({"button"})

FIRMWARE_ATTRIBUTES = frozenset(
    {
        "availableVersion",
        "currentVersion",
        "lastUpdateStatus",
        "lastUpdateStatusReason",
        "lastUpdateTime",
        "state",
        "updateAvailable",
    }
)

DEVICE_REGISTRY_ATTRIBUTES = frozenset(
    {
        "currentVersion",
        "mnhw",
        "mnfv",
        "mnmn",
        "mnmo",
        "model",
        "modelCode",
        "txicDeviceFwVer",
    }
)


def control_kind(device: BridgeDevice, switch_state: BridgeState) -> ControlKind | None:
    """Classify only verified, safe switch-shaped controls."""
    if switch_state.attribute != "switch":
        return None
    if is_media_device(device) or is_fan_device(device):
        return None
    if is_readonly_appliance_switch(device):
        return None
    attributes = {
        state.attribute
        for state in device.states.values()
        if state.component == switch_state.component
    }
    light_specific = (
        "colorTemperatureRange" in attributes
        or {"hue", "saturation"}.issubset(attributes)
        or (
            "level" in attributes
            and any(
                control.kind == "slider"
                and control.attribute == "level"
                and safe_observed_control(control)
                for control in device.controls.values()
            )
        )
    )
    return "light" if light_specific else "switch"


def toggle_control_for_state(
    device: BridgeDevice, state: BridgeState
) -> BridgeControl | None:
    """Return the unique exact toggle control backing one pushed state."""
    matches = [
        control
        for control in device.controls.values()
        if control.kind == "toggle"
        and control.component == state.component
        and control.capability == state.capability
        and control.attribute == state.attribute
    ]
    return matches[0] if len(matches) == 1 else None


def safe_generic_toggle_control(control: BridgeControl) -> bool:
    """Accept only a reversible observed toggle outside dangerous device classes."""
    if not safe_observed_control(control):
        return False
    values = {
        value.lower().replace("_", "").replace("-", "")
        for value in control.commands
    }
    return bool(values & {"on", "switchon", "enable", "enabled"}) and bool(
        values & {"off", "switchoff", "disable", "disabled"}
    )


def safe_observed_control(control: BridgeControl) -> bool:
    """Reject dangerous actuators regardless of compound or localized naming."""
    identity = " ".join(
        value
        for value in (
            control.control_id,
            control.capability,
            control.attribute,
            control.label,
            *control.commands,
            *control.option_commands.values(),
        )
        if value
    )
    return not _dangerous_control_text(identity)


def _dangerous_control_text(value: str) -> bool:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value).lower()
    tokens = [item for item in re.split(r"[^a-z0-9가-힣]+", separated) if item]
    if any(
        item in {"lock", "unlock", "valve", "door", "garage"}
        or re.fullmatch(r"(?:lock|unlock|valve|door|garage)\d*", item)
        for item in tokens
    ):
        return True
    compact = "".join(tokens)
    return bool(
        re.search(r"(?:door|lock|unlock|valve|garage)(?:state|control|command)", compact)
        or re.search(r"잠금|도어|차고|밸브|문\s*(?:열|닫)", value)
        or any(
            item in {"문", "현관문", "대문", "창문", "출입문", "방화문", "자동문"}
            for item in tokens
        )
    )


def entity_unique_id(device_id: str, state: BridgeState) -> str:
    """Return the stable entity identity without duplicating the attribute."""
    return "_".join((device_id, *state.key))


def disambiguated_state_names(
    items: Iterable[tuple[BridgeState, str]],
) -> dict[tuple[str, str, str], str]:
    """Return explicit names only for states sharing the same display name."""
    grouped: dict[str, list[BridgeState]] = {}
    for state, name in items:
        grouped.setdefault(name, []).append(state)

    names: dict[tuple[str, str, str], str] = {}
    for base_name, states in grouped.items():
        if len(states) < 2:
            continue
        ordered = sorted(states, key=lambda state: state.key)
        qualifiers = _unique_state_qualifiers(ordered, "component")
        if qualifiers is None:
            qualifiers = _unique_state_qualifiers(ordered, "capability")
        if qualifiers is None:
            qualifiers = [str(index) for index in range(1, len(ordered) + 1)]
        for state, qualifier in zip(ordered, qualifiers, strict=True):
            names[state.key] = f"{base_name} ({qualifier})"
    return names


def _unique_state_qualifiers(
    states: list[BridgeState], field_name: Literal["component", "capability"]
) -> list[str] | None:
    qualifiers = [
        _readable_state_role(state, field_name)
        or _readable_state_token(getattr(state, field_name), field_name)
        for state in states
    ]
    if any(qualifier is None for qualifier in qualifiers):
        return None
    readable = [qualifier for qualifier in qualifiers if qualifier is not None]
    return readable if len(set(readable)) == len(states) else None


def _readable_state_role(
    state: BridgeState, field_name: Literal["component", "capability"]
) -> str | None:
    role = state.component_role if field_name == "component" else state.capability_role
    return _readable_state_token(role, field_name) if role else None


def _readable_state_token(value: str, field_name: str) -> str | None:
    normalized = value.strip()
    if not normalized or normalized.lower().startswith("identifier_"):
        return None
    if field_name == "component" and normalized.lower() == "main":
        return None
    normalized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", normalized)
    normalized = re.sub(r"[_-]+", " ", normalized).strip()
    return normalized.title() or None


def _safe_role(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or len(normalized) > 80:
        return None
    if normalized.lower().startswith("identifier_"):
        return None
    if not re.fullmatch(r"[A-Za-z0-9가-힣 _-]+", normalized):
        return None
    return normalized


def location_name(inventory: BridgeInventory, location_id: str) -> str:
    """Return a user-facing location name for old and new inventory shapes."""
    location = inventory.locations.get(location_id)
    if isinstance(location, BridgeLocation):
        return location.name
    if isinstance(location, str):
        return location
    return location_id


def location_arm_state(inventory: BridgeInventory, location_id: str) -> str | None:
    """Return the current SmartThings Home Monitor arm state if present."""
    location = inventory.locations.get(location_id)
    if isinstance(location, BridgeLocation):
        return location.arm_state
    return None


def location_unique_id(location_id: str, suffix: str) -> str:
    """Return a stable non-device unique ID."""
    return f"{location_id}_{suffix}"


def scene_unique_id(scene_id: str) -> str:
    """Return a stable scene unique ID."""
    return f"{scene_id}_scene"


def device_has_any_state(device: BridgeDevice, attributes: set[str]) -> bool:
    """Return whether a device exposes at least one of the requested attributes."""
    return any(state.attribute in attributes for state in device.states.values())


REFRESH_ATTRIBUTES = {
    "battery",
    "captureTime",
    "clip",
    "contact",
    "image",
    "imageTransferProgress",
    "lqi",
    "motion",
    "rssi",
    "signalMetrics",
    "stream",
}

IMAGE_ATTRIBUTES = {"captureTime", "clip", "image", "imageTransferProgress", "stream"}

MEDIA_ATTRIBUTES = {
    "audioTrackData",
    "mute",
    "playbackStatus",
    "supportedPlaybackCommands",
    "supportedTrackControlCommands",
    "volume",
}

MEDIA_PLAYBACK_ATTRIBUTES = {
    "audioTrackData",
    "playbackStatus",
    "supportedPlaybackCommands",
    "supportedTrackControlCommands",
}

MEDIA_TRANSPORT_COMMANDS = {
    "fastforward",
    "nexttrack",
    "pause",
    "play",
    "playtrackandresume",
    "previoustrack",
    "rewind",
    "stop",
}

MEDIA_DEVICE_TYPES = {
    "ai_speaker_lux_one",
    "audio",
    "av_receiver",
    "home_theater",
    "media_player",
    "soundbar",
    "speaker",
}

READ_ONLY_POWER_DEVICE_TYPES = {
    "camera_security",
    "clothing_care",
    "cooktop",
    "dishwasher",
    "dryer",
    "microwave",
    "oven",
    "range",
    "refrigerator",
    "washer",
}

FAN_ATTRIBUTES = {
    "airPurifierMode",
    "fanMode",
    "fanSpeed",
    "supportedAcFanModes",
    "supportedAirPurifierModes",
    "supportedFanModes",
}

FAN_LEVEL_ATTRIBUTES = {"level"}

FAN_IDENTITY_TERMS = {
    "air conditioner",
    "air purifier",
    "airpurifier",
    "circulator",
    "fan",
    "purifier",
    "ventilator",
    "ventilation",
    "공기청정",
    "서큘레이터",
    "선풍기",
    "팬",
    "환풍",
}

COVER_ATTRIBUTES = {
    "shadeLevel",
    "supportedWindowShadeCommands",
    "windowShade",
}

CLIMATE_ATTRIBUTES = {
    "coolingSetpoint",
    "heatingSetpoint",
    "supportedThermostatModes",
    "targetTemperature",
    "temperature",
    "thermostatMode",
}

CLIMATE_MODE_ATTRIBUTES = {"supportedThermostatModes", "thermostatMode"}

SELECT_PRIMARY_DOMAIN_ATTRIBUTES = (
    COVER_ATTRIBUTES
    | CLIMATE_MODE_ATTRIBUTES
    | FAN_ATTRIBUTES
    | MEDIA_ATTRIBUTES
)


def is_refreshable_device(device: BridgeDevice) -> bool:
    """Return whether a device has state that maps to a refresh action."""
    return any(
        _is_observed_refresh_control(control) for control in device.controls.values()
    )


def _is_observed_refresh_control(control: BridgeControl) -> bool:
    if not safe_observed_control(control) or control.kind != "button":
        return False
    return _control_mentions(control, "refresh") and any(
        "refresh" == command.lower() for command in control.commands
    )


def is_image_device(device: BridgeDevice) -> bool:
    """Return whether a device has camera/image-shaped state."""
    return device_has_any_state(device, IMAGE_ATTRIBUTES)


def is_media_device(device: BridgeDevice) -> bool:
    """Return whether a device has media-player state."""
    if device_has_any_state(device, MEDIA_PLAYBACK_ATTRIBUTES):
        return True
    if any(
        safe_observed_control(control)
        and _control_has_explicit_media_semantics(control)
        for control in device.controls.values()
    ):
        return True
    if not _device_has_media_device_type(device):
        return False
    if _device_has_audio_volume_evidence(device) or _device_has_audio_mute_evidence(device):
        return True
    return any(
        safe_observed_control(control)
        and _control_has_media_transport_semantics(control)
        for control in device.controls.values()
    )


def is_fan_device(device: BridgeDevice) -> bool:
    """Return whether a device has fan or air-purifier state."""
    if device_has_any_state(device, FAN_ATTRIBUTES):
        return True
    if any(_control_has_fan_semantics(control) for control in device.controls.values()):
        return True
    return device_has_any_state(device, FAN_LEVEL_ATTRIBUTES) and _device_has_fan_identity(device)


def is_cover_device(device: BridgeDevice) -> bool:
    """Return whether a device has window shade state/control evidence."""
    if device_has_any_state(device, COVER_ATTRIBUTES):
        return True
    return any(
        control.kind in {"button", "slider", "enumerated"}
        and _control_mentions(control, "shade", "windowshade", "blind", "cover")
        for control in device.controls.values()
    )


def is_climate_device(device: BridgeDevice) -> bool:
    """Return whether a device has thermostat state/control evidence."""
    attributes = {state.attribute for state in device.states.values()}
    if "thermostatMode" in attributes and (
        "temperature" in attributes
        or "coolingSetpoint" in attributes
        or "heatingSetpoint" in attributes
        or "targetTemperature" in attributes
    ):
        return True
    return any(
        control.kind in {"enumerated", "slider"}
        and control.attribute in CLIMATE_ATTRIBUTES
        for control in device.controls.values()
    )


def number_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return slider controls discovered from detail swatches."""
    return [
        control
        for control in device.controls.values()
        if control.kind == "slider"
        and control.attribute is not None
        and control.minimum is not None
        and control.maximum is not None
        and safe_observed_control(control)
        and not _slider_owned_by_richer_domain(device, control)
    ]


def number_control_for_state(
    device: BridgeDevice, state: BridgeState
) -> BridgeControl | None:
    """Return the unique exact observed slider mirroring one pushed state."""
    matches = [
        control
        for control in number_controls(device)
        if (control.component is None or control.component == state.component)
        and (control.capability is None or control.capability == state.capability)
        and control.attribute == state.attribute
    ]
    return matches[0] if len(matches) == 1 else None


def _slider_owned_by_richer_domain(
    device: BridgeDevice, control: BridgeControl
) -> bool:
    attribute = control.attribute
    if attribute == "volume" and is_media_device(device):
        return True
    if attribute == "shadeLevel" and is_cover_device(device):
        return True
    if attribute in {"coolingSetpoint", "heatingSetpoint", "targetTemperature"} and is_climate_device(device):
        return True
    if attribute not in {"colorTemperature", "level"}:
        return False
    return any(
        state.attribute == "switch"
        and control_kind(device, state) == "light"
        and (toggle := toggle_control_for_state(device, state)) is not None
        and safe_observed_control(toggle)
        for state in device.states.values()
    )


def cover_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return controls that can safely target a cover device."""
    return [
        control
        for control in device.controls.values()
        if control.kind in {"button", "slider", "enumerated"}
        and safe_observed_control(control)
        and (
            control.attribute in COVER_ATTRIBUTES
            or _control_mentions(control, "shade", "windowshade", "blind", "cover")
        )
    ]


def climate_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return controls that can safely target a climate device."""
    return [
        control
        for control in device.controls.values()
        if control.kind in {"enumerated", "slider"}
        and control.attribute in CLIMATE_ATTRIBUTES
        and safe_observed_control(control)
    ]


def select_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return observed enumerated controls with explicit options."""
    return [
        control
        for control in device.controls.values()
        if control.kind == "enumerated"
        and bool(control.options)
        and control.attribute not in SELECT_PRIMARY_DOMAIN_ATTRIBUTES
        and safe_observed_control(control)
    ]


def select_control_for_state(
    device: BridgeDevice, state: BridgeState
) -> BridgeControl | None:
    """Return the unique observed select that mirrors one pushed state."""
    matches = [
        control
        for control in select_controls(device)
        if (control.component is None or control.component == state.component)
        and (control.capability is None or control.capability == state.capability)
        and control.attribute == state.attribute
    ]
    return matches[0] if len(matches) == 1 else None


def refresh_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return refresh button controls discovered from detail swatches."""
    return [
        control
        for control in device.controls.values()
        if _is_observed_refresh_control(control)
    ]


def button_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return non-value button controls discovered from detail swatches."""
    return [
        control
        for control in device.controls.values()
        if control.kind == "button" and safe_observed_control(control)
    ]


def control_label(control: BridgeControl, fallback: str) -> str:
    """Return a readable control label."""
    return control.label or fallback


def control_supports_command(control: BridgeControl, command: str) -> bool:
    """Match a web control command without confusing Play with Play Track."""
    command_lower = command.lower()
    aliases = {
        "on": {"on", "switchon", "enable", "enabled"},
        "off": {"off", "switchoff", "disable", "disabled"},
        "setvolume": {"setvolume", "volume"},
        "unmute": {"unmute", "mute"},
        "playtrackandresume": {"playtrackandresume", "play track and resume"},
    }.get(command_lower, {command_lower})
    values = [
        control.control_id,
        control.label or "",
        control.attribute or "",
        *control.commands,
        *control.option_commands.values(),
    ]
    normalized = {
        " ".join(value.lower().replace("_", " ").replace("-", " ").split())
        for value in values
    }
    compact = {value.replace(" ", "") for value in normalized}
    return any(alias in normalized or alias.replace(" ", "") in compact for alias in aliases)


def numeric_range_for(device: BridgeDevice, state: BridgeState) -> tuple[float, float, float]:
    """Infer a HA number range from sibling range metadata or conservative defaults."""
    for sibling in device.states.values():
        if sibling.component != state.component:
            continue
        if sibling.attribute not in {
            f"{state.attribute}Range",
            f"{state.attribute}Ranges",
            "range",
            "ranges",
        }:
            continue
        parsed = _parse_numeric_range(sibling.value)
        if parsed is not None:
            return parsed
    if state.attribute in {"level", "fanSpeed", "percent"}:
        return (0.0, 100.0, 1.0)
    if state.attribute == "detectionFrequency":
        return (0.0, 3600.0, 1.0)
    if state.attribute == "colorTemperature":
        return (1500.0, 9000.0, 1.0)
    return (0.0, 100.0, 1.0)


def option_values(value: Any) -> list[str]:
    """Extract option strings from normalized SmartThings option payloads."""
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, list):
        result = []
        for item in value:
            if isinstance(item, str):
                result.append(item)
            elif isinstance(item, dict):
                for key in ("value", "id", "name"):
                    candidate = item.get(key)
                    if isinstance(candidate, str):
                        result.append(candidate)
                        break
        return result
    if isinstance(value, dict):
        for key in ("values", "options", "supportedValues", "supportedModes"):
            nested = value.get(key)
            if nested is not None:
                return option_values(nested)
    return []


def token_values(value: Any) -> list[str]:
    """Extract whitespace/comma-delimited capability tokens or structured options."""
    if isinstance(value, str):
        return [item for item in re.split(r"[\s,]+", value.strip()) if item]
    return option_values(value)


def primary_state_attributes(
    device: BridgeDevice,
    attributes: Iterable[str],
    *,
    component: str | None = None,
) -> dict[str, Any]:
    """Preserve primary-domain raw values without losing duplicate component keys."""
    allowed = set(attributes)
    selected = [
        state
        for state in device.states.values()
        if state.attribute in allowed
        and (component is None or state.component == component)
    ]
    counts: dict[str, int] = {}
    for state in selected:
        counts[state.attribute] = counts.get(state.attribute, 0) + 1
    return {
        (
            state.attribute
            if counts[state.attribute] == 1
            else _state_attribute_key(state)
        ): state.value
        for state in selected
    }


def _state_attribute_key(state: BridgeState) -> str:
    qualifier = _readable_state_role(state, "component") or _readable_state_role(
        state, "capability"
    )
    if qualifier is not None:
        slug = re.sub(r"[^0-9a-zA-Z가-힣]+", "_", qualifier).strip("_").lower()
        if slug:
            return f"smartthings_{slug}_{state.attribute}"
    return f"smartthings_{state.component}_{state.capability}_{state.attribute}"


def sensor_state_allowed(
    attribute: str, *, firmware: bool = False, primary_domain: bool = False
) -> bool:
    """Return whether a normalized state needs a sensor representation."""
    return (
        attribute != "switch"
        and attribute not in BINARY_ATTRIBUTES
        and attribute not in EVENT_ATTRIBUTES
        and not firmware
        and not primary_domain
    )


def sensor_state_owned_by_primary_domain(
    device: BridgeDevice, state: BridgeState
) -> bool:
    """Avoid raw sensor duplicates when an official-style rich domain owns a state."""
    attribute = state.attribute
    if is_media_device(device) and attribute in MEDIA_ATTRIBUTES:
        return True
    if is_fan_device(device) and attribute in FAN_ATTRIBUTES | {"level", "percent"}:
        return True
    if is_cover_device(device) and attribute in COVER_ATTRIBUTES:
        return True
    if is_climate_device(device) and attribute in {
        "coolingSetpoint",
        "heatingSetpoint",
        "supportedThermostatModes",
        "targetTemperature",
        "thermostatMode",
    }:
        return True
    if attribute in {"mute", "volume"} and not is_media_device(device):
        return False
    if number_control_for_state(device, state) is not None:
        return True
    if select_control_for_state(device, state) is not None:
        return True
    if attribute in {
        "colorTemperature",
        "colorTemperatureRange",
        "hue",
        "level",
        "levelRange",
        "saturation",
        "supportedColorModes",
    } and any(
        candidate.attribute == "switch"
        and control_kind(device, candidate) == "light"
        and toggle_control_for_state(device, candidate) is not None
        for candidate in device.states.values()
    ):
        return True
    toggle = toggle_control_for_state(device, state)
    if (
        toggle is not None
        and attribute not in {"switch", "mute", "windowShade"}
        and safe_generic_toggle_control(toggle)
    ):
        return True
    return False


def firmware_states(device: BridgeDevice) -> dict[str, BridgeState]:
    """Return one coherent firmware capability instead of raw duplicate sensors."""
    by_capability: dict[tuple[str, str], dict[str, BridgeState]] = {}
    for state in device.states.values():
        if state.attribute in FIRMWARE_ATTRIBUTES:
            by_capability.setdefault((state.component, state.capability), {})[
                state.attribute
            ] = state
    candidates = [
        states
        for states in by_capability.values()
        if "currentVersion" in states and "availableVersion" in states
    ]
    if not candidates:
        return {}
    return max(candidates, key=lambda states: len(states))


def device_software_version(device: BridgeDevice) -> str | None:
    """Return a compact device-registry software version when firmware reports one."""
    state = firmware_states(device).get("currentVersion")
    value = _device_metadata_value(state)
    if value is None:
        value = _first_device_metadata_value(device, "mnfv", "txicDeviceFwVer")
    if value is None:
        return None
    return re.sub(r"\s+\(\d+\)$", "", value) or value


def device_manufacturer(device: BridgeDevice) -> str | None:
    """Return the pushed manufacturer name when SmartThings supplies it."""
    return _first_device_metadata_value(device, "mnmn")


_DEVICE_TYPE_MODELS_KO = {
    "accessory": "액세서리",
    "ai_speaker_lux_one": "AI 스피커",
    "air_purifier": "공기청정기",
    "air_quality_sensor": "공기질 센서",
    "bleD2D": "블루투스 기기",
    "button_1": "버튼",
    "camera_security": "보안 카메라",
    "charger_hub": "충전 허브",
    "coffee_machine": "커피 머신",
    "contact_sensor": "문열림 센서",
    "custom_door": "도어",
    "custom_floor_ac_rac": "에어컨",
    "custom_light_mood": "무드등",
    "custom_light_pendant": "펜던트 조명",
    "custom_light_strip": "스트립 조명",
    "custom_light_tube": "튜브 조명",
    "custom_window_h": "창문",
    "dishwasher": "식기세척기",
    "dryer": "건조기",
    "elevator": "엘리베이터",
    "energy_monitoring": "에너지 모니터",
    "fan": "선풍기",
    "floor_ac": "에어컨",
    "garage_door": "차고문",
    "general_display": "디스플레이",
    "home_theater": "홈시어터",
    "hub": "허브",
    "humidifier": "가습기",
    "illuminance_sensor": "조도 센서",
    "light_bulb": "전구",
    "light_ceiling": "천장등",
    "moisture_sensor_1": "누수 센서",
    "motion_sensor_1": "모션 센서",
    "multipurpose_sensor_1": "다목적 센서",
    "outlet_1": "콘센트",
    "presence_sensor": "재실 센서",
    "qooker": "쿠커",
    "range_extender": "신호 확장기",
    "refrigerator": "냉장고",
    "remote": "리모컨",
    "shade": "블라인드",
    "smoke_sensor": "연기 감지기",
    "soundbar": "사운드바",
    "speaker": "스피커",
    "smart_tag": "스마트태그",
    "smart_tag_2": "스마트태그",
    "switch": "스위치",
    "temp_humidity_sensor": "온습도 센서",
    "thermostat": "온도조절기",
    "unknown": "스마트 기기",
    "washer": "세탁기",
    "wifi_hub_1": "Wi-Fi 허브",
}


def device_model(device: BridgeDevice) -> str | None:
    """Return a readable localized SmartThings device type for the registry."""
    asset_type = device.presentation.asset_type if device.presentation else None
    if asset_type and _normalized_device_type(device.device_type) in {
        "",
        "accessory",
        "bled2d",
        "none",
        "unknown",
    }:
        mapped_asset = _DEVICE_TYPE_MODELS_KO.get(asset_type)
        if mapped_asset is not None:
            return mapped_asset
    if device.device_type:
        mapped = _DEVICE_TYPE_MODELS_KO.get(device.device_type)
        if mapped is not None:
            return mapped
        normalized = re.sub(r"_\d+$", "", device.device_type.strip())
        normalized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", normalized)
        return normalized.replace("_", " ").strip().title() or None
    return _first_device_metadata_value(device, "mnmo", "model", "modelCode")


def device_hardware_version(device: BridgeDevice) -> str | None:
    """Return the pushed hardware revision when available."""
    return _first_device_metadata_value(device, "mnhw")


def _first_device_metadata_value(
    device: BridgeDevice, *attributes: str
) -> str | None:
    for attribute in attributes:
        for state in device.states.values():
            if state.attribute != attribute:
                continue
            value = _device_metadata_value(state)
            if value is not None:
                return value
    return None


def _device_metadata_value(state: BridgeState | None) -> str | None:
    if state is None or not isinstance(state.value, str):
        return None
    value = state.value.strip()
    return value if 0 < len(value) <= 255 else None


def sensor_native_value(value: Any) -> Any:
    """Return a HA-safe primary sensor value without dropping structured content."""
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 255 else "data"
    if isinstance(value, list):
        return f"{len(value)} items"
    if isinstance(value, dict):
        return "data"
    return None


def sensor_extra_attributes(value: Any) -> dict[str, Any]:
    """Retain normalized structured or long values as entity attributes."""
    if isinstance(value, (dict, list)) or (isinstance(value, str) and len(value) > 255):
        return {"value": deepcopy(value)}
    return {}


def parse_command_result(
    raw: dict[str, Any], client_request_id: str, target_type: str | None = None
) -> BridgeCommandResult | None:
    """Accept only a result bound to this request and an authoritative state source."""
    status = raw.get("status")
    confirmation = raw.get("confirmation")
    sequence = raw.get("sequence")
    if (
        raw.get("schemaVersion") != 1
        or raw.get("clientRequestId") != client_request_id
        or raw.get("transport") != "smartthings_web_ui"
        or status not in {"confirmed", "already_confirmed"}
        or confirmation
        not in {
            "device_event",
            "inventory_snapshot",
            "current_state",
            "security_arm_state_event",
        }
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence < 0
    ):
        return None
    if confirmation == "security_arm_state_event" and target_type != "location":
        return None
    if confirmation == "inventory_snapshot" and target_type != "device":
        return None
    if status == "confirmed" and confirmation != "device_event":
        if confirmation not in {"inventory_snapshot", "security_arm_state_event"}:
            return None
    if status == "already_confirmed" and confirmation != "current_state":
        return None
    return BridgeCommandResult(status, sequence, confirmation)


def parse_location(raw: Any) -> BridgeLocation | None:
    """Parse old/new Bridge location shapes."""
    if isinstance(raw, dict):
        location_id = raw.get("id")
        name = raw.get("name")
        updated_at = raw.get("updatedAt")
        if not isinstance(location_id, str) or not isinstance(name, str):
            return None
        if updated_at is not None and (
            not isinstance(updated_at, str) or _timestamp(updated_at) is None
        ):
            return None
        arm_state = raw.get("armState")
        return BridgeLocation(
            location_id=location_id,
            name=name,
            arm_state=arm_state if isinstance(arm_state, str) else None,
            updated_at=updated_at,
        )
    return None


def parse_scene(raw: Any) -> BridgeScene | None:
    """Parse one normalized scene entry."""
    if not isinstance(raw, dict):
        return None
    scene_id = raw.get("id")
    location_id = raw.get("locationId")
    name = raw.get("name")
    updated_at = raw.get("updatedAt")
    if not all(isinstance(value, str) and value for value in (scene_id, location_id, name)):
        return None
    if updated_at is not None and (
        not isinstance(updated_at, str) or _timestamp(updated_at) is None
    ):
        return None
    return BridgeScene(
        scene_id=scene_id,
        location_id=location_id,
        name=name,
        updated_at=updated_at,
    )


def parse_device_presentation(raw: Any) -> BridgeDevicePresentation | None:
    """Parse only public SmartThings icon and animation asset metadata."""
    if not isinstance(raw, dict):
        return None
    asset_type_raw = raw.get("assetType")
    asset_type = (
        asset_type_raw
        if isinstance(asset_type_raw, str)
        and re.fullmatch(r"[a-z0-9_-]{1,80}", asset_type_raw)
        else None
    )
    icon_url = _safe_device_asset_url(raw.get("iconUrl"), animation=False)
    inactive_icon_url = _safe_device_asset_url(
        raw.get("inactiveIconUrl"), animation=False
    )
    animation_url = _safe_device_asset_url(raw.get("animationUrl"), animation=True)
    if not any((asset_type, icon_url, inactive_icon_url, animation_url)):
        return None
    return BridgeDevicePresentation(
        asset_type=asset_type,
        icon_url=icon_url,
        inactive_icon_url=inactive_icon_url,
        animation_url=animation_url,
    )


def _safe_device_asset_url(value: Any, *, animation: bool) -> str | None:
    if not isinstance(value, str) or len(value) > 512:
        return None
    try:
        parsed = urlparse(value)
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.port
            or parsed.query
            or parsed.fragment
        ):
            return None
    except ValueError:
        return None
    if animation:
        if parsed.hostname != "app-asset.samsungiotcloud.com" or not re.fullmatch(
            r"/assets/icons/published/[a-z0-9_-]{1,80}/[a-z0-9_-]{1,80}\.json",
            parsed.path,
        ):
            return None
    elif parsed.hostname != "client.smartthings.com" or not parsed.path.startswith(
        "/icons/"
    ):
        return None
    return value


def parse_control(raw: Any) -> BridgeControl | None:
    """Parse one normalized control from a detail swatch."""
    if not isinstance(raw, dict):
        return None
    control_id = raw.get("id")
    kind = raw.get("kind")
    if (
        not isinstance(control_id, str)
        or kind not in {"button", "color", "enumerated", "slider", "toggle", "value"}
    ):
        return None
    label = raw.get("label")
    component = raw.get("component")
    capability = raw.get("capability")
    attribute = raw.get("attribute")
    minimum = raw.get("min")
    maximum = raw.get("max")
    step = raw.get("step")
    return BridgeControl(
        control_id=control_id,
        kind=kind,
        label=label if isinstance(label, str) else None,
        component=component if isinstance(component, str) else None,
        capability=capability if isinstance(capability, str) else None,
        attribute=attribute if isinstance(attribute, str) else None,
        commands=tuple(
            dict.fromkeys(
                ([raw["command"]] if isinstance(raw.get("command"), str) else [])
                + option_values(raw.get("commands"))
            )
        ),
        options=tuple(option_values(raw.get("options"))),
        option_labels=_safe_string_map(raw.get("optionLabels")),
        option_commands=_safe_string_map(raw.get("optionCommands")),
        minimum=float(minimum)
        if isinstance(minimum, (int, float)) and not isinstance(minimum, bool)
        else None,
        maximum=float(maximum)
        if isinstance(maximum, (int, float)) and not isinstance(maximum, bool)
        else None,
        step=float(step)
        if isinstance(step, (int, float)) and not isinstance(step, bool)
        else None,
    )


def _safe_string_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {
        key: item
        for key, item in value.items()
        if isinstance(key, str)
        and isinstance(item, str)
        and key not in {"__proto__", "prototype", "constructor"}
        and 0 < len(key) <= 255
        and 0 < len(item) <= 255
    }


def parse_state(raw: dict[str, Any]) -> BridgeState | None:
    """Parse one Bridge state."""
    component = raw.get("component")
    capability = raw.get("capability")
    attribute = raw.get("attribute")
    if not all(isinstance(value, str) and value for value in (component, capability, attribute)):
        return None
    unit = raw.get("unit")
    updated_at = raw.get("updatedAt")
    if updated_at is not None and (
        not isinstance(updated_at, str) or _timestamp(updated_at) is None
    ):
        return None
    return BridgeState(
        component=component,
        capability=capability,
        attribute=attribute,
        value=raw.get("value"),
        unit=unit if isinstance(unit, str) else None,
        updated_at=updated_at,
        component_role=_safe_role(raw.get("componentRole")),
        capability_role=_safe_role(raw.get("capabilityRole")),
    )


def _event_sequence(event: dict[str, Any]) -> int | None:
    sequence = event.get("sequence")
    return sequence if isinstance(sequence, int) and not isinstance(sequence, bool) and sequence >= 0 else None


def _state_is_newer(candidate: BridgeState, current: BridgeState) -> bool:
    candidate_time = _timestamp(candidate.updated_at)
    current_time = _timestamp(current.updated_at)
    if current_time is None:
        return True
    if candidate_time is None:
        return False
    return candidate_time > current_time


def _merge_locations(
    current: dict[str, BridgeLocation | str],
    latest: dict[str, BridgeLocation | str],
) -> dict[str, BridgeLocation | str]:
    merged = deepcopy(current)
    for location_id, candidate in latest.items():
        present = merged.get(location_id)
        if (
            isinstance(candidate, BridgeLocation)
            and isinstance(present, BridgeLocation)
            and not _metadata_is_newer(candidate.updated_at, present.updated_at)
        ):
            continue
        merged[location_id] = candidate
    return merged


def _merge_scenes(
    current: dict[str, BridgeScene], latest: dict[str, BridgeScene]
) -> dict[str, BridgeScene]:
    merged = deepcopy(current)
    for scene_id, candidate in latest.items():
        present = merged.get(scene_id)
        if present is None or _metadata_is_newer(candidate.updated_at, present.updated_at):
            merged[scene_id] = candidate
    return merged


def _metadata_is_newer(candidate: str | None, current: str | None) -> bool:
    current_time = _timestamp(current)
    candidate_time = _timestamp(candidate)
    if current_time is None:
        return True
    if candidate_time is None:
        return False
    return candidate_time >= current_time


def _parse_numeric_range(value: Any) -> tuple[float, float, float] | None:
    if isinstance(value, dict):
        minimum = _number_from_keys(value, "minimum", "min", "minValue")
        maximum = _number_from_keys(value, "maximum", "max", "maxValue")
        step = _number_from_keys(value, "step", "interval", "increment") or 1.0
        if minimum is not None and maximum is not None and minimum < maximum:
            return (minimum, maximum, step)
    if isinstance(value, list) and value:
        numbers = [
            float(item)
            for item in value
            if isinstance(item, (int, float)) and not isinstance(item, bool)
        ]
        if len(numbers) >= 2:
            return (min(numbers), max(numbers), 1.0)
        for item in value:
            parsed = _parse_numeric_range(item)
            if parsed is not None:
                return parsed
    return None


def _number_from_keys(value: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
            return float(candidate)
    return None


def _control_mentions(control: BridgeControl, *needles: str) -> bool:
    haystack = " ".join(
        item.lower()
        for item in (
            control.control_id,
            control.kind,
            control.label or "",
            control.attribute or "",
            *control.commands,
        )
    )
    return any(needle.lower() in haystack for needle in needles)


def _device_has_audio_volume_evidence(device: BridgeDevice) -> bool:
    if device_has_any_state(device, {"volume"}):
        return True
    return any(
        safe_observed_control(control)
        and (control.attribute == "volume" or control.capability == "audioVolume")
        for control in device.controls.values()
    )


def _device_has_audio_mute_evidence(device: BridgeDevice) -> bool:
    if device_has_any_state(device, {"mute"}):
        return True
    return any(
        safe_observed_control(control)
        and (control.attribute == "mute" or control.capability == "audioMute")
        for control in device.controls.values()
    )


def is_readonly_appliance_switch(device: BridgeDevice) -> bool:
    """Return whether appliance power must remain read-only state."""
    device_type = _normalized_device_type(device.device_type)
    asset_type = (
        _normalized_device_type(device.presentation.asset_type)
        if device.presentation
        else ""
    )
    return device_type in READ_ONLY_POWER_DEVICE_TYPES or asset_type in READ_ONLY_POWER_DEVICE_TYPES


def _normalized_device_type(value: str | None) -> str:
    return (value or "").strip().lower().replace("-", "_")


def _control_has_fan_semantics(control: BridgeControl) -> bool:
    if control.attribute in FAN_ATTRIBUTES or control.capability in FAN_ATTRIBUTES:
        return True
    return _text_has_fan_identity(
        control.control_id,
        control.label,
        control.capability,
        control.attribute,
        *control.commands,
    )


def _device_has_fan_identity(device: BridgeDevice) -> bool:
    return _text_has_fan_identity(device.name, device.device_type)


def _text_has_fan_identity(*values: str | None) -> bool:
    haystack = " ".join(value.lower() for value in values if isinstance(value, str))
    if not haystack:
        return False
    return any(term in haystack for term in FAN_IDENTITY_TERMS)


def _timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None and parsed.utcoffset() is not None else None
    except ValueError:
        return None

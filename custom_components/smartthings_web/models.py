"""Runtime models for SmartThings Web."""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
import re
from typing import Any, Literal
from urllib.parse import urlparse


@dataclass
class BridgeState:
    """One current SmartThings attribute."""

    component: str
    capability: str
    attribute: str
    value: Any
    unit: str | None
    updated_at: str | None

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

    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to state changes."""
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)

    async def handle_event(self, event: dict[str, Any]) -> bool:
        """Apply one SSE event, resynchronizing on reconnects and gaps."""
        if event.get("type") == "inventory":
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
        devices = deepcopy(current.devices)
        for device_id, latest_device in latest.devices.items():
            existing = devices.get(device_id)
            if existing is None:
                devices[device_id] = deepcopy(latest_device)
                continue
            states = deepcopy(existing.states)
            for key, candidate in latest_device.states.items():
                present = states.get(key)
                if present is None or _state_is_newer(candidate, present):
                    states[key] = deepcopy(candidate)
            devices[device_id] = BridgeDevice(
                device_id=latest_device.device_id,
                location_id=latest_device.location_id,
                room_id=latest_device.room_id,
                name=latest_device.name,
                device_type=latest_device.device_type,
                online=latest_device.online,
                presentation=latest_device.presentation,
                states=states,
                controls={**existing.controls, **latest_device.controls},
            )
        merged = BridgeInventory(
            sequence=latest.sequence,
            ready=latest.ready,
            bridge_version=latest.bridge_version,
            protocol_version=latest.protocol_version,
            locations=_merge_locations(current.locations, latest.locations),
            rooms={**current.rooms, **latest.rooms},
            devices=devices,
            scenes=_merge_scenes(current.scenes, latest.scenes),
        )
        if merged == current:
            return False
        self.inventory = merged
        self._notify_listeners()
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
        self.inventory.sequence = sequence
        if current is not None and not _state_is_newer(state, current):
            return False
        device.states[state.key] = state
        self._notify_listeners()
        return True

    def _notify_listeners(self) -> None:
        for listener in tuple(self.listeners):
            listener()


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


def control_kind(device: BridgeDevice, switch_state: BridgeState) -> ControlKind | None:
    """Classify only verified, safe switch-shaped controls."""
    if switch_state.attribute != "switch":
        return None
    if is_media_device(device) or is_fan_device(device):
        return None
    attributes = {
        state.attribute
        for state in device.states.values()
        if state.component == switch_state.component
    }
    light_specific = (
        "colorTemperatureRange" in attributes
        or {"hue", "saturation"}.issubset(attributes)
    )
    return "light" if light_specific else "switch"


def entity_unique_id(device_id: str, state: BridgeState) -> str:
    """Return the stable entity identity without duplicating the attribute."""
    return "_".join((device_id, *state.key))


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

FAN_ATTRIBUTES = {
    "airPurifierMode",
    "fanMode",
    "fanSpeed",
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

NUMBER_ATTRIBUTES = {
    "colorTemperature",
    "coolingSetpoint",
    "detectionFrequency",
    "fanSpeed",
    "heatingSetpoint",
    "level",
    "percent",
    "setpoint",
    "targetTemperature",
    "volume",
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
    return any(_control_mentions(control, "refresh") for control in device.controls.values()) or device_has_any_state(device, REFRESH_ATTRIBUTES)


def is_image_device(device: BridgeDevice) -> bool:
    """Return whether a device has camera/image-shaped state."""
    return device_has_any_state(device, IMAGE_ATTRIBUTES)


def is_media_device(device: BridgeDevice) -> bool:
    """Return whether a device has media-player state."""
    return any(
        _control_mentions(control, "play", "pause", "track", "mute", "volume")
        for control in device.controls.values()
    ) or device_has_any_state(device, MEDIA_ATTRIBUTES)


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


def number_state_allowed(device: BridgeDevice, state: BridgeState) -> bool:
    """Return whether a numeric state should be exposed as a control number."""
    if isinstance(state.value, bool) or not isinstance(state.value, (int, float)):
        return False
    if state.attribute not in NUMBER_ATTRIBUTES:
        return False
    if state.attribute in {"volume"} and is_media_device(device):
        return False
    if state.attribute == "fanSpeed" and not is_fan_device(device):
        return False
    if state.attribute == "percent" and not is_fan_device(device):
        return False
    return True


def number_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return slider controls discovered from detail swatches."""
    return [
        control
        for control in device.controls.values()
        if control.kind == "slider"
        and control.attribute is not None
        and control.minimum is not None
        and control.maximum is not None
    ]


def cover_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return controls that can safely target a cover device."""
    return [
        control
        for control in device.controls.values()
        if control.kind in {"button", "slider", "enumerated"}
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
    ]


def select_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return observed enumerated controls with explicit options."""
    return [
        control
        for control in device.controls.values()
        if control.kind == "enumerated"
        and bool(control.options)
        and control.attribute not in SELECT_PRIMARY_DOMAIN_ATTRIBUTES
    ]


def refresh_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return refresh button controls discovered from detail swatches."""
    return [
        control
        for control in device.controls.values()
        if control.kind == "button" and _control_mentions(control, "refresh")
    ]


def button_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return non-value button controls discovered from detail swatches."""
    return [control for control in device.controls.values() if control.kind == "button"]


def control_label(control: BridgeControl, fallback: str) -> str:
    """Return a readable control label."""
    return control.label or fallback


def control_supports_command(control: BridgeControl, command: str) -> bool:
    """Match a web control command without confusing Play with Play Track."""
    command_lower = command.lower()
    aliases = {
        "setvolume": {"setvolume", "volume"},
        "unmute": {"unmute", "mute"},
        "playtrackandresume": {"playtrackandresume", "play track and resume"},
    }.get(command_lower, {command_lower})
    values = [
        control.control_id,
        control.label or "",
        control.attribute or "",
        *control.commands,
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


def sensor_state_allowed(attribute: str) -> bool:
    """Return whether a normalized state needs a sensor representation."""
    return attribute != "switch" and attribute not in BINARY_ATTRIBUTES


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

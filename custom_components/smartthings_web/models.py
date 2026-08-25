"""Runtime models for SmartThings Web."""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


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
class BridgeDevice:
    """One Bridge device."""

    device_id: str
    location_id: str
    room_id: str | None
    name: str
    device_type: str | None
    online: bool
    states: dict[tuple[str, str, str], BridgeState] = field(default_factory=dict)


@dataclass
class BridgeInventory:
    """Current Bridge inventory."""

    sequence: int
    ready: bool
    bridge_version: str
    protocol_version: str
    locations: dict[str, str]
    rooms: dict[str, tuple[str, str]]
    devices: dict[str, BridgeDevice]


@dataclass(frozen=True)
class BridgeCommandResult:
    """Verified result returned by the local Bridge command endpoint."""

    status: Literal["confirmed", "already_confirmed"]
    sequence: int
    confirmation: Literal["device_event", "current_state"]


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
                states=states,
            )
        merged = BridgeInventory(
            sequence=latest.sequence,
            ready=latest.ready,
            bridge_version=latest.bridge_version,
            protocol_version=latest.protocol_version,
            locations={**current.locations, **latest.locations},
            rooms={**current.rooms, **latest.rooms},
            devices=devices,
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
    raw: dict[str, Any], client_request_id: str
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
        or confirmation not in {"device_event", "current_state"}
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence < 0
    ):
        return None
    if status == "confirmed" and confirmation != "device_event":
        return None
    if status == "already_confirmed" and confirmation != "current_state":
        return None
    return BridgeCommandResult(status, sequence, confirmation)


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


def _timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None and parsed.utcoffset() is not None else None
    except ValueError:
        return None

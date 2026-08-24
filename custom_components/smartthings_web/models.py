"""Runtime models for SmartThings Web."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


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
        device.states[state.key] = state
        self.inventory.sequence = max(self.inventory.sequence, int(event.get("sequence", 0)))
        for listener in tuple(self.listeners):
            listener()
        return True


def parse_state(raw: dict[str, Any]) -> BridgeState | None:
    """Parse one Bridge state."""
    component = raw.get("component")
    capability = raw.get("capability")
    attribute = raw.get("attribute")
    if not all(isinstance(value, str) and value for value in (component, capability, attribute)):
        return None
    unit = raw.get("unit")
    updated_at = raw.get("updatedAt")
    return BridgeState(
        component=component,
        capability=capability,
        attribute=attribute,
        value=raw.get("value"),
        unit=unit if isinstance(unit, str) else None,
        updated_at=updated_at if isinstance(updated_at, str) else None,
    )


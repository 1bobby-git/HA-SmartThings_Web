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


@dataclass(frozen=True)
class BridgeAdvancedDeviceMetadata:
    """Allowlisted Advanced identity metadata used for safe canonicalization."""

    owner_id: str | None = None
    parent_device_id: str | None = None
    execution_context: str | None = None
    linked_device_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class BridgeCommandArgument:
    """One safe Advanced command argument definition."""

    name: str
    required: bool
    sensitive: bool
    schema: dict[str, Any]
    unit: str | None = None


@dataclass(frozen=True)
class BridgeCommandDescriptor:
    """One safe Advanced command descriptor exposed by the Bridge."""

    component: str
    capability: str
    capability_version: int
    command: str
    arguments: tuple[BridgeCommandArgument, ...]
    transport: str
    confirmation: str
    label: str
    label_source: str
    component_role: str | None = None
    capability_role: str | None = None


@dataclass(frozen=True)
class BridgeCommandOmission:
    """One omitted Advanced command record from the Bridge inventory."""

    component: str
    capability: str
    command: str | None
    reason: str


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
    commands: tuple[BridgeCommandDescriptor, ...] = ()
    command_omissions: tuple[BridgeCommandOmission, ...] = ()
    advanced: BridgeAdvancedDeviceMetadata | None = None
    health_updated_at: str | None = None


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
    transport: str | None = None


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


@dataclass(frozen=True)
class BridgeImageUpdate:
    """One sanitized Bridge camera cache update."""

    sequence: int
    captured_at: str
    content_type: str


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
    device_aliases: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class BridgeCommandResult:
    """Verified result returned by the local Bridge command endpoint."""

    status: Literal["confirmed", "already_confirmed", "accepted_unconfirmed"]
    sequence: int
    confirmation: Literal[
        "device_event",
        "inventory_snapshot",
        "current_state",
        "security_arm_state_event",
        "accepted_receipt",
    ]
    transport: Literal[
        "smartthings_web_ui", "advanced", "location_native", "internal", "dom"
    ] = "smartthings_web_ui"
    lifecycle: Literal[
        "CONFIRMED_BY_EVENT", "CONFIRMED_BY_STATUS", "ACCEPTED_UNCONFIRMED"
    ] = (
        "CONFIRMED_BY_EVENT"
    )


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
    image_updates: dict[str, BridgeImageUpdate] = field(default_factory=dict)

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
        device_id = event.get("deviceId")
        canonical_id = self.inventory.device_aliases.get(device_id, device_id)
        if isinstance(device_id, str) and canonical_id != device_id:
            event = {**event, "deviceId": canonical_id}
        if event.get("type") == "image":
            return self.apply_image_event(event)
        if event.get("type") == "inventory":
            sequence = _event_sequence(event)
            if sequence is None or sequence <= self.inventory.sequence:
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
        if _state_event_needs_inventory(self.inventory, self.location_id, event):
            changed = self.apply_inventory(await self.client.async_get_inventory()) or changed
            if sequence <= self.inventory.sequence:
                return changed
        return self.apply_state(event) or changed

    def apply_image_event(self, event: dict[str, Any]) -> bool:
        """Apply one sanitized camera cache update from the Bridge."""
        update = parse_image_update(event)
        device_id = event.get("deviceId")
        if update is None or not isinstance(device_id, str):
            return False
        device = self.inventory.devices.get(device_id)
        if device is None or device.location_id != self.location_id:
            return False
        current = self.image_updates.get(device_id)
        if current is not None and not _image_update_is_newer(update, current):
            return False
        self.image_updates[device_id] = update
        self._notify_listeners(device_ids={device_id}, notify_global=False)
        return True

    def apply_reconnect_inventory(self, latest: BridgeInventory) -> bool:
        """Apply the first fetched inventory of a new SSE connection epoch."""
        return self._apply_inventory(latest, allow_sequence_reset=True)

    def apply_inventory(self, latest: BridgeInventory) -> bool:
        """Atomically merge the newest full or partial Bridge inventory."""
        return self._apply_inventory(latest, allow_sequence_reset=False)

    def _apply_inventory(
        self,
        latest: BridgeInventory,
        *,
        allow_sequence_reset: bool,
    ) -> bool:
        """Atomically merge the newest full or partial Bridge inventory."""
        current = self.inventory
        if not allow_sequence_reset and latest.sequence < current.sequence:
            return False
        authoritative = latest.ready and (
            allow_sequence_reset or latest.sequence > current.sequence
        )
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
                commands=deepcopy(latest_device.commands),
                command_omissions=deepcopy(latest_device.command_omissions),
                advanced=deepcopy(
                    latest_device.advanced
                    if latest_device.advanced is not None
                    else existing.advanced
                ),
                health_updated_at=(
                    latest_device.health_updated_at
                    if latest_device.health_updated_at is not None
                    else existing.health_updated_at
                ),
            )
        merged = BridgeInventory(
            sequence=latest.sequence if allow_sequence_reset else max(current.sequence, latest.sequence),
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
            device_aliases=_merge_device_aliases(
                current.device_aliases,
                latest.device_aliases,
                devices,
                authoritative=authoritative,
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
        value_became_available = (
            current is not None
            and not state_has_entity_value(current)
            and state_has_entity_value(state)
        )
        repeated_event = (
            current is not None
            and state.attribute in EVENT_ATTRIBUTES
            and _timestamp(state.updated_at) == _timestamp(current.updated_at)
        )
        if current is not None and not _state_is_newer(state, current) and not repeated_event:
            return False
        self.inventory.sequence = sequence
        device.states[state.key] = state
        self._notify_listeners(
            device_ids={device_id},
            state_keys={(device_id, state.key)},
            notify_global=(
                new_state_key
                or value_became_available
                or state.attribute in DEVICE_REGISTRY_ATTRIBUTES
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
    toggle = toggle_control_for_state(device, switch_state)
    if (
        toggle is None
        or not safe_observed_control(toggle)
        or not safe_generic_toggle_control(toggle)
    ):
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
    if len(matches) == 1:
        return matches[0]
    # Cake can describe the same physical toggle twice: once as the exact
    # device action and once as its detail-page swatch. The action identity is
    # deterministic and preserves the observed command directions. Prefer it
    # only when it is itself unique; unrelated duplicate swatches remain
    # fail-closed.
    action_matches = [
        control for control in matches if control.control_id.startswith("action:")
    ]
    return action_matches[0] if len(action_matches) == 1 else None


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
    *,
    all_states: Iterable[BridgeState] | None = None,
    main_presence_name: str | None = None,
) -> dict[tuple[str, str, str], str]:
    """Return explicit names only for states sharing the same display name."""
    grouped: dict[str, list[BridgeState]] = {}
    for state, name in items:
        grouped.setdefault(name, []).append(state)

    all_state_items = tuple(all_states) if all_states is not None else ()
    names: dict[tuple[str, str, str], str] = {}
    for base_name, states in grouped.items():
        if len(states) < 2:
            continue
        primary_component_name = (
            main_presence_name
            if all(state.attribute == "presence" for state in states)
            else None
        )
        component_role_hints = _unique_component_role_hints(
            all_state_items,
            main_component_name=primary_component_name,
        )
        ordered = sorted(states, key=lambda state: state.key)
        qualifiers = _unique_state_qualifiers(
            ordered,
            "component",
            component_role_hints=component_role_hints,
            main_component_name=primary_component_name,
        )
        if qualifiers is None:
            qualifiers = _unique_state_qualifiers(ordered, "capability")
        if qualifiers is None:
            qualifiers = [str(index) for index in range(1, len(ordered) + 1)]
        for state, qualifier in zip(ordered, qualifiers, strict=True):
            names[state.key] = f"{base_name} ({qualifier})"
    return names


WEB_CONTROL_LABELS_KO = {
    "device status": "장치 상태",
    "power": "전원",
    "yjswitchstatus": "장치 상태",
}


def switch_name_overrides(
    device: BridgeDevice,
) -> dict[tuple[str, str, str], str]:
    """Return Web-aligned names for safe switch channels on one device."""
    switch_states = [
        state
        for state in device.states.values()
        if control_kind(device, state) == "switch"
        and state.attribute == "switch"
    ]
    if not switch_states:
        return {}
    names: dict[tuple[str, str, str], str] = {}
    ordered = sorted(switch_states, key=lambda item: item.key)
    secondary_indexes = {
        state.key: index
        for index, state in enumerate(
            (
                item
                for item in ordered
                if not primary_switch_state(device, item)
            ),
            2,
        )
    }
    for state in ordered:
        control = toggle_control_for_state(device, state)
        label = _web_control_label(control.label if control else None)
        if label == "전원" and not _main_power_switch_state(device, state):
            label = None
        if label is None and _main_power_switch_state(device, state):
            label = "전원"
        if label is None:
            label = _readable_state_token(state.component_role or state.component, "component")
        if label is None and state.capability_role is not None:
            label = _readable_state_token(state.capability_role, "capability")
        if (
            label is None
            and (state.component_role or state.component).strip().lower() == "main"
        ):
            continue
        if label is None and state.key in secondary_indexes:
            label = f"스위치 {secondary_indexes[state.key]}"
        if label is not None:
            names[state.key] = label
    return _deduplicated_switch_names(ordered, names)


def _deduplicated_switch_names(
    states: list[BridgeState],
    names: dict[tuple[str, str, str], str],
) -> dict[tuple[str, str, str], str]:
    grouped: dict[str, list[BridgeState]] = {}
    for state in states:
        label = names.get(state.key)
        if label is not None:
            grouped.setdefault(label, []).append(state)
    for label, siblings in grouped.items():
        if len(siblings) < 2:
            continue
        qualifiers = [
            _readable_state_token(state.capability_role or state.capability, "capability")
            or _readable_state_token(state.component_role or state.component, "component")
            for state in siblings
        ]
        if (
            all(qualifier is not None for qualifier in qualifiers)
            and len(set(qualifiers)) == len(siblings)
        ):
            for state, qualifier in zip(siblings, qualifiers, strict=True):
                names[state.key] = f"{label} ({qualifier})"
            continue
        for index, state in enumerate(sorted(siblings, key=lambda item: item.key), 1):
            names[state.key] = f"{label} {index}"
    return names


def secondary_switch_name_overrides(
    device: BridgeDevice,
) -> dict[tuple[str, str, str], str]:
    """Return legacy structural names for non-main switch migration repair."""
    secondary_switches = [
        state
        for state in device.states.values()
        if control_kind(device, state) == "switch"
        and state.attribute == "switch"
        and (state.component_role or state.component).strip().lower() != "main"
    ]
    names: dict[tuple[str, str, str], str] = {}
    for index, state in enumerate(sorted(secondary_switches, key=lambda item: item.key), 2):
        role_name = _readable_state_token(
            state.component_role or state.component,
            "component",
        )
        names[state.key] = role_name if role_name is not None else f"스위치 {index}"
    return names


def _localized_web_control_label(value: str | None) -> str | None:
    if not value:
        return None
    normalized = " ".join(value.strip().lower().replace("_", " ").replace("-", " ").split())
    return WEB_CONTROL_LABELS_KO.get(normalized) or WEB_CONTROL_LABELS_KO.get(
        normalized.replace(" ", "")
    )


def _web_control_label(value: str | None) -> str | None:
    localized = _localized_web_control_label(value)
    if localized is not None:
        return localized
    safe_name = _safe_role(value)
    return _readable_state_token(safe_name, "control") if safe_name else None


def primary_switch_state(device: BridgeDevice, state: BridgeState) -> bool:
    """Return whether this state is the device's canonical Web power switch."""
    if state.attribute != "switch":
        return False
    safe_switch_states = [
        item
        for item in device.states.values()
        if item.attribute == "switch" and control_kind(device, item) == "switch"
    ]
    if len(safe_switch_states) != 1 or safe_switch_states[0].key != state.key:
        return False
    return _main_power_switch_state(device, state, allow_identifier_component=True)


def _main_power_switch_state(
    device: BridgeDevice,
    state: BridgeState,
    *,
    allow_identifier_component: bool = False,
) -> bool:
    if state.attribute != "switch":
        return False
    if (state.component_role or state.component).strip().lower() != "main":
        if not allow_identifier_component:
            return False
        component = (state.component_role or state.component).strip().lower()
        if not component.startswith("identifier_"):
            return False
    control = toggle_control_for_state(device, state)
    label = _localized_web_control_label(control.label if control else None)
    capability = state.capability.strip().lower()
    capability_power = capability == "switch" or capability.endswith("_switch")
    return capability_power or (allow_identifier_component and label == "전원")


def _unique_state_qualifiers(
    states: list[BridgeState],
    field_name: Literal["component", "capability"],
    *,
    component_role_hints: dict[str, str] | None = None,
    main_component_name: str | None = None,
) -> list[str] | None:
    qualifiers = [
        _readable_state_role(
            state,
            field_name,
            main_component_name=main_component_name,
        )
        or (
            component_role_hints.get(state.component)
            if field_name == "component" and component_role_hints is not None
            else None
        )
        or _readable_state_token(getattr(state, field_name), field_name)
        for state in states
    ]
    if any(qualifier is None for qualifier in qualifiers):
        return None
    readable = [qualifier for qualifier in qualifiers if qualifier is not None]
    return readable if len(set(readable)) == len(states) else None


def _unique_component_role_hints(
    states: Iterable[BridgeState],
    *,
    main_component_name: str | None = None,
) -> dict[str, str]:
    roles_by_component: dict[str, set[str]] = {}
    for state in states:
        role = _readable_state_role(
            state,
            "component",
            main_component_name=main_component_name,
        )
        if role is not None:
            roles_by_component.setdefault(state.component, set()).add(role)
    return {
        component: next(iter(roles))
        for component, roles in roles_by_component.items()
        if len(roles) == 1
    }


def _readable_state_role(
    state: BridgeState,
    field_name: Literal["component", "capability"],
    *,
    main_component_name: str | None = None,
) -> str | None:
    role = state.component_role if field_name == "component" else state.capability_role
    if (
        field_name == "component"
        and isinstance(role, str)
        and role.strip().lower() == "main"
        and main_component_name is not None
    ):
        safe_name = _safe_role(main_component_name)
        return _readable_state_token(safe_name, "location") if safe_name else None
    return _readable_state_token(role, field_name) if role else None


def _readable_state_token(value: str, field_name: str) -> str | None:
    normalized = value.strip()
    if not normalized or normalized.lower().startswith("identifier_"):
        return None
    if field_name == "component" and normalized.lower() == "main":
        return None
    role_name = STATE_ROLE_DISPLAY_NAMES.get(normalized.lower())
    if role_name is not None:
        return role_name
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
    if not re.fullmatch(r"[A-Za-z0-9가-힣 ._-]+", normalized):
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


def room_free_display_name(
    runtime: SmartThingsWebRuntime,
    device: BridgeDevice,
) -> str | None:
    """Preserve the SmartThings device name, including an exact room name.

    Room-prefix deduplication belongs only to generated entity object IDs.
    Replacing an exact room-name device with a type label loses the user's
    actual SmartThings name and can produce opaque collision IDs.
    """
    return None


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
SENSITIVE_IMAGE_ATTRIBUTES = {"image"}

CAMERA_DEVICE_TYPES = {
    "camera",
    "camera_security",
    "cctv",
    "security_camera",
}

CAMERA_IDENTITY_TERMS = {
    "camera",
    "cctv",
    "homecam",
    "security cam",
    "보안 카메라",
    "카메라",
    "홈캠",
}

MEDIA_ATTRIBUTES = {
    "audioTrackData",
    "mute",
    "playbackStatus",
    "supportedPlaybackCommands",
    "supportedTrackControlCommands",
    "volume",
}

MEDIA_DEVICE_TYPES = {
    "ai_speaker",
    "ai_speaker_lux_one",
    "audio",
    "av_receiver",
    "media_player",
    "soundbar",
    "speaker",
    "tv",
}

MEDIA_IDENTITY_TERMS = {
    "ai speaker",
    "audio",
    "galaxy home mini",
    "home mini",
    "media player",
    "soundbar",
    "speaker",
    "갤럭시 홈 미니",
    "미디어",
    "사운드바",
    "스피커",
    "홈 미니",
}

MEDIA_PLAYBACK_ATTRIBUTES = {
    "audioTrackData",
    "playbackStatus",
    "supportedPlaybackCommands",
    "supportedTrackControlCommands",
}

READ_ONLY_POWER_DEVICE_TYPES = {
    "clothing_care",
    "cooktop",
    "dishwasher",
    "dryer",
    "microwave",
    "washer",
}

NON_MEDIA_ACCESSORY_ASSET_TYPES = {
    "car",
    "smart_tag",
    "smart_tag_2",
}

STATE_ROLE_DISPLAY_NAMES = {
    "bixby": "빅스비",
    "cooler": "냉장실",
    "curdmaker": "숙성실",
    "cvroom": "맞춤보관실",
    "freezer": "냉동실",
    "fridge": "냉장실",
    "hca.main": "HCA",
    "icemaker": "제빙기",
    "icemaker-02": "보조 제빙기",
    "onedoor": "단일 도어",
    "pantry-01": "팬트리 1",
    "pantry-02": "팬트리 2",
    "refrigerator": "냉장고",
    "setup": "설정",
    "smartthings-findnode": "찾기 노드",
    "smartthings-hub": "스마트싱스 허브",
    "switch2": "스위치 2",
    "switch3": "스위치 3",
    "switch4": "스위치 4",
    "switch5": "스위치 5",
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
    """Return whether pushed image state belongs to an actual camera device."""
    attributes = {state.attribute for state in device.states.values()}
    if not attributes & IMAGE_ATTRIBUTES:
        return False
    if _device_has_camera_identity(device):
        return True
    return bool(
        attributes & {"clip", "stream"}
        and attributes & {"captureTime", "image"}
    )


def is_media_device(device: BridgeDevice) -> bool:
    """Return whether a device has media-player state."""
    if _device_has_explicit_non_media_accessory_identity(device):
        return False
    if not (
        _device_has_audio_volume_evidence(device)
        and _device_has_audio_mute_evidence(device)
    ):
        return False
    return _device_has_media_identity(device) or _device_has_media_playback_evidence(
        device
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
        and (
            (control.minimum is not None and control.maximum is not None)
            or _slider_has_numeric_state(device, control)
        )
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


def _slider_has_numeric_state(device: BridgeDevice, control: BridgeControl) -> bool:
    """Allow metadata-light sliders only when the pushed state is numeric."""
    return any(
        state.attribute == control.attribute
        and (control.component is None or state.component == control.component)
        and (control.capability is None or state.capability == control.capability)
        and isinstance(state.value, (int, float))
        and not isinstance(state.value, bool)
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


def canonical_refresh_control(device: BridgeDevice) -> BridgeControl | None:
    """Return the one device-level Refresh control exposed to Home Assistant."""
    candidates = [
        control
        for control in device.controls.values()
        if _is_observed_refresh_control(control)
    ]
    if not candidates:
        return None
    main_components = {
        state.component
        for state in device.states.values()
        if (state.component_role or "").strip().lower() == "main"
    }
    return min(
        candidates,
        key=lambda control: (
            control.component not in main_components,
            control.component or "",
            control.control_id,
        ),
    )


def refresh_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return at most one canonical device-level Refresh control."""
    control = canonical_refresh_control(device)
    return [] if control is None else [control]


def noncanonical_refresh_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return observed component Refresh controls hidden behind the canonical one."""
    canonical = canonical_refresh_control(device)
    return [
        control
        for control in device.controls.values()
        if _is_observed_refresh_control(control) and control != canonical
    ]


def button_controls(device: BridgeDevice) -> list[BridgeControl]:
    """Return non-value button controls discovered from detail swatches."""
    canonical_refresh = canonical_refresh_control(device)
    return [
        control
        for control in device.controls.values()
        if control.kind == "button"
        and safe_observed_control(control)
        and (
            not _is_observed_refresh_control(control)
            or control == canonical_refresh
        )
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
    attribute: str,
    *,
    firmware: bool = False,
    primary_domain: bool = False,
    image_device: bool = True,
) -> bool:
    """Return whether a normalized state needs a sensor representation."""
    return (
        attribute != "switch"
        and attribute not in BINARY_ATTRIBUTES
        and attribute not in EVENT_ATTRIBUTES
        and attribute not in SENSITIVE_IMAGE_ATTRIBUTES
        and (image_device or attribute not in IMAGE_ATTRIBUTES)
        and not firmware
        and not primary_domain
    )


def state_has_entity_value(state: BridgeState) -> bool:
    """Return whether a normalized state contains content worth exposing."""
    return state.value is not None


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
        if state.attribute in FIRMWARE_ATTRIBUTES and state_has_entity_value(state):
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


def signal_metrics_native_value(value: Any, updated_at: str | None = None) -> Any:
    """Return the SmartThings Web display string for received signal metrics."""
    if isinstance(value, str):
        return value if len(value) <= 255 else "data"
    if not isinstance(value, dict):
        return sensor_native_value(value)
    lqi = _number_from_keys(value, "lqi", "LQI")
    rssi = _number_from_keys(value, "rssi", "RSSI")
    if lqi is None and rssi is None:
        return "data"
    parts: list[str] = []
    timestamp = _signal_metrics_timestamp(value, updated_at)
    if timestamp:
        parts.append(f"KST-9: {timestamp}")
    if lqi is not None:
        parts.append(f"LQI: {_compact_number(lqi)}")
    if rssi is not None:
        parts.append(f"RSSI: {_compact_number(rssi)}dbm")
    result = " ".join(parts)
    return result if len(result) <= 255 else "data"


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


def _signal_metrics_timestamp(value: dict[str, Any], fallback: str | None) -> str | None:
    for key in ("timestamp", "updatedAt", "time"):
        candidate = value.get(key)
        if isinstance(candidate, str):
            parsed = _timestamp(candidate)
            if parsed is not None:
                return parsed.strftime("%Y/%m/%d %H:%M")
    parsed = _timestamp(fallback)
    return parsed.strftime("%Y/%m/%d %H:%M") if parsed is not None else None


def _compact_number(value: float) -> str:
    return str(int(value)) if value.is_integer() else f"{value:g}"


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
    transport = raw.get("transport")
    lifecycle = raw.get("lifecycle")
    sequence = raw.get("sequence")
    if (
        raw.get("schemaVersion") != 1
        or raw.get("clientRequestId") != client_request_id
        or transport
        not in {"smartthings_web_ui", "advanced", "location_native", "internal", "dom"}
        or status not in {"confirmed", "already_confirmed", "accepted_unconfirmed"}
        or confirmation
        not in {
            "device_event",
            "inventory_snapshot",
            "current_state",
            "security_arm_state_event",
            "accepted_receipt",
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
    if status == "accepted_unconfirmed":
        if confirmation != "accepted_receipt" or target_type not in {None, "device"}:
            return None
        expected_lifecycle = "ACCEPTED_UNCONFIRMED"
    else:
        if confirmation == "accepted_receipt":
            return None
        expected_lifecycle = (
            "CONFIRMED_BY_EVENT"
            if confirmation in {"device_event", "security_arm_state_event"}
            else "CONFIRMED_BY_STATUS"
        )
    if lifecycle is not None and lifecycle != expected_lifecycle:
        return None
    return BridgeCommandResult(
        status=status,
        sequence=sequence,
        confirmation=confirmation,
        transport=transport,
        lifecycle=expected_lifecycle,
    )


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


def parse_image_update(raw: Any) -> BridgeImageUpdate | None:
    """Parse a sanitized Bridge camera cache SSE event."""
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1 or raw.get("type") != "image":
        return None
    sequence = raw.get("sequence")
    image = raw.get("image")
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        return None
    if not isinstance(image, dict):
        return None
    captured_at = image.get("capturedAt")
    content_type = image.get("contentType")
    if (
        not isinstance(captured_at, str)
        or _timestamp(captured_at) is None
        or content_type not in {"image/jpeg", "image/png", "image/webp"}
    ):
        return None
    return BridgeImageUpdate(sequence, captured_at, content_type)


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
    transport = raw.get("transport")
    if transport is not None and (
        not isinstance(transport, str)
        or transport not in {"advanced", "location_native"}
    ):
        return None
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
        transport=transport if isinstance(transport, str) else None,
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


def _state_event_needs_inventory(
    inventory: BridgeInventory,
    location_id: str,
    event: dict[str, Any],
) -> bool:
    device_id = event.get("deviceId")
    if not isinstance(device_id, str) or not isinstance(event.get("state"), dict):
        return False
    device = inventory.devices.get(device_id)
    return device is None or device.location_id != location_id


def _state_is_newer(candidate: BridgeState, current: BridgeState) -> bool:
    candidate_time = _timestamp(candidate.updated_at)
    current_time = _timestamp(current.updated_at)
    if current_time is None:
        return True
    if candidate_time is None:
        return False
    return candidate_time > current_time


def _merge_device_aliases(
    current: dict[str, str],
    latest: dict[str, str],
    devices: dict[str, BridgeDevice],
    *,
    authoritative: bool,
) -> dict[str, str]:
    """Retain only aliases whose source is hidden and canonical target exists."""
    merged = deepcopy(latest) if authoritative else {**current, **latest}
    return {
        alias: canonical
        for alias, canonical in merged.items()
        if alias not in devices and canonical in devices and alias != canonical
    }


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


def _image_update_is_newer(candidate: BridgeImageUpdate, current: BridgeImageUpdate) -> bool:
    if candidate.sequence > current.sequence:
        return True
    candidate_time = _timestamp(candidate.captured_at)
    current_time = _timestamp(current.captured_at)
    if current_time is None:
        return True
    if candidate_time is None:
        return False
    if candidate.sequence < current.sequence:
        return candidate_time > current_time
    return candidate_time > current_time


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


def _device_has_explicit_non_media_accessory_identity(device: BridgeDevice) -> bool:
    device_type = _normalized_device_type(device.device_type)
    asset_type = (
        _normalized_device_type(device.presentation.asset_type)
        if device.presentation
        else ""
    )
    if device_type in NON_MEDIA_ACCESSORY_ASSET_TYPES:
        return True
    if asset_type in NON_MEDIA_ACCESSORY_ASSET_TYPES:
        return True
    return device_type == "bled2d" and bool(asset_type)


def _device_has_media_identity(device: BridgeDevice) -> bool:
    device_type = _normalized_device_type(device.device_type)
    asset_type = (
        _normalized_device_type(device.presentation.asset_type)
        if device.presentation
        else ""
    )
    if device_type in MEDIA_DEVICE_TYPES or asset_type in MEDIA_DEVICE_TYPES:
        return True
    haystack = " ".join(
        value.lower().replace("_", " ")
        for value in (device.name, device.device_type, asset_type)
        if isinstance(value, str)
    )
    return any(term in haystack for term in MEDIA_IDENTITY_TERMS)


def _device_has_media_playback_evidence(device: BridgeDevice) -> bool:
    if device_has_any_state(device, MEDIA_PLAYBACK_ATTRIBUTES):
        return True
    return any(
        safe_observed_control(control)
        and (
            control.attribute in MEDIA_PLAYBACK_ATTRIBUTES
            or control.capability in MEDIA_PLAYBACK_ATTRIBUTES
            or _control_mentions(
                control,
                "playback",
                "track",
                "media",
                "audioTrack",
            )
        )
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


def _device_has_camera_identity(device: BridgeDevice) -> bool:
    device_type = _normalized_device_type(device.device_type)
    asset_type = (
        _normalized_device_type(device.presentation.asset_type)
        if device.presentation
        else ""
    )
    if device_type in CAMERA_DEVICE_TYPES or asset_type in CAMERA_DEVICE_TYPES:
        return True
    haystack = " ".join(
        value.lower()
        for value in (device.name, device.device_type, asset_type)
        if isinstance(value, str)
    )
    return any(term in haystack for term in CAMERA_IDENTITY_TERMS)


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

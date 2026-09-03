"""Firmware update entities for SmartThings Web."""

from __future__ import annotations

from typing import Any

from homeassistant.components.update import UpdateDeviceClass, UpdateEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .entity import SmartThingsWebDeviceEntity
from .models import BridgeDevice, BridgeState, SmartThingsWebRuntime, firmware_states


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create one official-style firmware entity per capable device."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id or not firmware_states(device):
                continue
            if device.device_id in known:
                continue
            known.add(device.device_id)
            entities.append(SmartThingsWebFirmwareUpdate(runtime, device))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebFirmwareUpdate(SmartThingsWebDeviceEntity, UpdateEntity):
    """Combine raw firmware attributes into one Home Assistant update entity."""

    _attr_device_class = UpdateDeviceClass.FIRMWARE
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "firmware"

    def __init__(self, runtime: SmartThingsWebRuntime, device: BridgeDevice) -> None:
        super().__init__(runtime, device, "firmware_update", None)

    @property
    def installed_version(self) -> str | None:
        """Return the pushed current firmware version."""
        return _version(self._states.get("currentVersion"))

    @property
    def latest_version(self) -> str | None:
        """Return the pushed available firmware version."""
        return _version(self._states.get("availableVersion"))

    @property
    def in_progress(self) -> bool:
        """Return whether SmartThings reports a firmware update in progress."""
        state = self._states.get("state")
        return state is not None and state.value == "updateInProgress"

    def version_is_newer(self, latest_version: str, installed_version: str) -> bool:
        """Prefer SmartThings' pushed availability bit over string guessing."""
        state = self._states.get("updateAvailable")
        if state is not None:
            if isinstance(state.value, bool):
                return state.value
            if isinstance(state.value, str):
                normalized = state.value.strip().lower()
                if normalized in {"true", "yes", "available"}:
                    return True
                if normalized in {"false", "no", "none", "unavailable"}:
                    return False
        return latest_version != installed_version

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Preserve non-primary firmware content without duplicate sensor rows."""
        return {
            attribute: state.value
            for attribute, state in self._states.items()
            if attribute
            not in {"availableVersion", "currentVersion", "state", "updateAvailable"}
        }

    @property
    def _states(self) -> dict[str, BridgeState]:
        device = self.bridge_device
        return firmware_states(device) if device is not None else {}


def _version(state: BridgeState | None) -> str | None:
    if state is None or state.value is None:
        return None
    value = str(state.value).strip()
    return value or None

"""Diagnostics for SmartThings Web."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError
from .const import CONF_CONTROL_MODE, CONTROL_MODE_SAFE_CONTROL


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
) -> dict[str, Any]:
    """Return redacted aggregate diagnostics for one config entry."""
    runtime = getattr(entry, "runtime_data", None)
    inventory = getattr(runtime, "inventory", None)
    diagnostics: dict[str, Any] = {
        "entry": {
            "has_bridge_url": "bridge_url" in entry.data,
            "has_bridge_token": "bridge_token" in entry.data,
            "has_location": "location_id" in entry.data,
            "control_mode": entry.options.get(CONF_CONTROL_MODE, CONTROL_MODE_SAFE_CONTROL),
        }
    }
    if inventory is None:
        diagnostics["inventory"] = {"available": False}
    else:
        diagnostics["inventory"] = {
            "available": True,
            "ready": inventory.ready,
            "sequence": inventory.sequence,
            "bridge_version": inventory.bridge_version,
            "protocol_version": inventory.protocol_version,
            "location_count": len(inventory.locations),
            "room_count": len(inventory.rooms),
            "device_count": len(inventory.devices),
            "scene_count": len(inventory.scenes),
            "state_count": sum(len(device.states) for device in inventory.devices.values()),
            "control_count": sum(len(device.controls) for device in inventory.devices.values()),
        }
    diagnostics["health"] = await _async_health_diagnostics(runtime)
    return diagnostics


async def _async_health_diagnostics(runtime: object | None) -> dict[str, Any]:
    client = getattr(runtime, "client", None)
    if client is None:
        return {"available": False}
    try:
        health = await client.async_get_health()
    except (AttributeError, BridgeClientError):
        return {"available": False}
    details = health.get("details") if isinstance(health.get("details"), dict) else {}
    return {
        "available": True,
        **_copy_bool(health, "live"),
        **_copy_bool(health, "ready"),
        "details": {
            **_copy_str(details, "state"),
            **_copy_str(details, "urlCategory"),
            **_copy_str(details, "bridgeVersion"),
            **_copy_str(details, "protocolVersion"),
            **_copy_int(details, "observedDeviceCount"),
            **_copy_int(details, "protocolInvalidFrameCount"),
            **_copy_int(details, "protocolChangeCount"),
            **_copy_int(details, "restartCount"),
            **_copy_int(details, "detailDiscoveryFailureCount"),
            **_copy_str(details, "architectureVersion"),
            **_copy_int(details, "advancedInventoryDeviceCount"),
            **_copy_int(details, "advancedInventoryLocationCount"),
            **_copy_int(details, "advancedInventoryPageCount"),
            **_copy_int(details, "pendingCommandCount"),
            **_copy_int(details, "domFallbackCount"),
            **_copy_str(details, "lastCommandTransport"),
            **_copy_str(details, "lastCommandConfirmation"),
        },
    }


def _copy_bool(source: dict[str, Any], key: str) -> dict[str, bool]:
    value = source.get(key)
    return {key: value} if isinstance(value, bool) else {}


def _copy_str(source: dict[str, Any], key: str) -> dict[str, str]:
    value = source.get(key)
    return {key: value} if isinstance(value, str) else {}


def _copy_int(source: dict[str, Any], key: str) -> dict[str, int]:
    value = source.get(key)
    return {key: value} if isinstance(value, int) and not isinstance(value, bool) else {}

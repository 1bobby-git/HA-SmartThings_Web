"""SmartThings Web integration."""

from __future__ import annotations

import asyncio

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .bridge_client import BridgeAuthError, BridgeClientError, SmartThingsWebBridgeClient
from .const import CONF_BRIDGE_TOKEN, CONF_BRIDGE_URL, CONF_LOCATION_ID, DOMAIN
from .models import (
    BridgeInventory,
    SmartThingsWebRuntime,
    entity_unique_id,
    is_fan_device,
    is_media_device,
)

PLATFORMS = [
    Platform.ALARM_CONTROL_PANEL,
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.CLIMATE,
    Platform.COVER,
    Platform.FAN,
    Platform.IMAGE,
    Platform.LIGHT,
    Platform.MEDIA_PLAYER,
    Platform.NUMBER,
    Platform.SCENE,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SWITCH,
]
SmartThingsWebConfigEntry = ConfigEntry[SmartThingsWebRuntime]


async def async_setup_entry(hass: HomeAssistant, entry: SmartThingsWebConfigEntry) -> bool:
    """Set up one SmartThings Web location."""
    client = SmartThingsWebBridgeClient(
        async_get_clientsession(hass),
        entry.data[CONF_BRIDGE_URL],
        entry.data[CONF_BRIDGE_TOKEN],
    )
    try:
        inventory = await client.async_get_inventory()
    except BridgeAuthError as err:
        raise ConfigEntryAuthFailed from err
    except BridgeClientError as err:
        raise ConfigEntryNotReady from err
    if not inventory.ready and not inventory.devices:
        raise ConfigEntryNotReady("SmartThings Web Bridge has no cached inventory")

    location_id = entry.data[CONF_LOCATION_ID]
    runtime = SmartThingsWebRuntime(client=client, location_id=location_id, inventory=inventory)
    entry.runtime_data = runtime
    _migrate_entity_registry(hass, entry, inventory)

    def register_devices() -> None:
        registry = dr.async_get(hass)
        for device in runtime.inventory.devices.values():
            if device.location_id != location_id:
                continue
            room = runtime.inventory.rooms.get(device.room_id) if device.room_id else None
            registry.async_get_or_create(
                config_entry_id=entry.entry_id,
                identifiers={(DOMAIN, device.device_id)},
                name=device.name,
                model=device.device_type,
                suggested_area=room[1] if room and room[0] == location_id else None,
            )

    register_devices()
    entry.async_on_unload(runtime.subscribe(register_devices))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_create_background_task(hass, _event_loop(entry), "smartthings_web_events")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SmartThingsWebConfigEntry) -> bool:
    """Unload a SmartThings Web config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _event_loop(entry: SmartThingsWebConfigEntry) -> None:
    """Maintain the Bridge push stream."""
    runtime = entry.runtime_data
    while True:
        try:
            async for event in runtime.client.async_events():
                await runtime.handle_event(event)
        except BridgeAuthError:
            return
        except BridgeClientError:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(5)


def _migrate_entity_registry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    inventory: BridgeInventory,
) -> None:
    """Repair only this integration's old unique IDs and binary switch artifacts."""
    registry = er.async_get(hass)
    old_to_new: dict[str, str] = {}
    switch_ids: set[str] = set()
    primary_domain_switch_ids: set[str] = set()
    current_fan_ids: set[str] = set()
    current_device_ids: set[str] = set()
    for device in inventory.devices.values():
        if device.location_id != entry.data[CONF_LOCATION_ID]:
            continue
        current_device_ids.add(device.device_id)
        if is_fan_device(device):
            current_fan_ids.add(device.device_id)
        for state in device.states.values():
            new_unique_id = entity_unique_id(device.device_id, state)
            old_unique_id = f"{new_unique_id}_{state.attribute}"
            old_to_new[old_unique_id] = new_unique_id
            if state.attribute == "switch":
                switch_ids.update((old_unique_id, new_unique_id))
                if is_media_device(device) or is_fan_device(device):
                    primary_domain_switch_ids.update((old_unique_id, new_unique_id))

    for entity_entry in list(er.async_entries_for_config_entry(registry, entry.entry_id)):
        if entity_entry.platform != DOMAIN:
            continue
        if entity_entry.domain == Platform.BINARY_SENSOR and entity_entry.unique_id in switch_ids:
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SWITCH
            and entity_entry.unique_id in primary_domain_switch_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.FAN
            and _stale_fan_unique_id(entity_entry.unique_id, current_device_ids, current_fan_ids)
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        new_unique_id = old_to_new.get(entity_entry.unique_id)
        if new_unique_id is None:
            continue
        existing = registry.async_get_entity_id(entity_entry.domain, DOMAIN, new_unique_id)
        if existing is None:
            registry.async_update_entity(entity_entry.entity_id, new_unique_id=new_unique_id)


def _stale_fan_unique_id(
    unique_id: str,
    current_device_ids: set[str],
    current_fan_ids: set[str],
) -> bool:
    """Return whether an old device fan entity no longer matches inventory."""
    if not unique_id.endswith("_fan"):
        return False
    device_id = unique_id.removesuffix("_fan")
    return device_id in current_device_ids and device_id not in current_fan_ids

"""SmartThings Web integration."""

from __future__ import annotations

import asyncio

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .bridge_client import BridgeAuthError, BridgeClientError, SmartThingsWebBridgeClient
from .const import CONF_BRIDGE_TOKEN, CONF_BRIDGE_URL, CONF_LOCATION_ID
from .models import SmartThingsWebRuntime

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR]
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
    registry = dr.async_get(hass)
    for device in inventory.devices.values():
        if device.location_id != location_id:
            continue
        room = inventory.rooms.get(device.room_id) if device.room_id else None
        registry.async_get_or_create(
            config_entry_id=entry.entry_id,
            identifiers={("smartthings_web", device.device_id)},
            name=device.name,
            model=device.device_type,
            manufacturer="SmartThings Web",
            suggested_area=room[1] if room and room[0] == location_id else None,
        )

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
                if event.get("type") == "state":
                    runtime.apply_state(event)
        except BridgeAuthError:
            return
        except BridgeClientError:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(5)

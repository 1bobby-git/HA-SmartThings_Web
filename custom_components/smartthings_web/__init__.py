"""SmartThings Web integration."""

from __future__ import annotations

import asyncio
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .bridge_client import (
    BridgeAuthError,
    BridgeClientError,
    ReadOnlyBridgeClient,
    SmartThingsWebBridgeClient,
)
from .const import (
    CONF_BRIDGE_TOKEN,
    CONF_BRIDGE_URL,
    CONF_CONTROL_MODE,
    CONF_LOCATION_ID,
    CONTROL_MODE_READ_ONLY,
    CONTROL_MODE_SAFE_CONTROL,
    DOMAIN,
    REPAIR_SAMSUNG_LOGIN_REQUIRED,
)
from .entity import device_info_for
from .models import (
    BridgeInventory,
    FIRMWARE_ATTRIBUTES,
    IMAGE_ATTRIBUTES,
    SmartThingsWebRuntime,
    entity_unique_id,
    firmware_states,
    is_fan_device,
    is_image_device,
    is_media_device,
    number_controls,
    sensor_state_allowed,
    sensor_state_owned_by_primary_domain,
    state_has_entity_value,
)

_LOGGER = logging.getLogger(__name__)

_EVENT_RECONNECT_MIN_DELAY = 0.05
_EVENT_RECONNECT_MAX_DELAY = 1.0

PLATFORMS = [
    Platform.ALARM_CONTROL_PANEL,
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.CLIMATE,
    Platform.COVER,
    Platform.EVENT,
    Platform.FAN,
    Platform.IMAGE,
    Platform.LIGHT,
    Platform.MEDIA_PLAYER,
    Platform.NUMBER,
    Platform.SCENE,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.UPDATE,
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
    await _async_update_repairs(hass, entry, client)

    location_id = entry.data[CONF_LOCATION_ID]
    runtime_client = ReadOnlyBridgeClient(client) if _control_mode(entry) == CONTROL_MODE_READ_ONLY else client
    runtime = SmartThingsWebRuntime(client=runtime_client, location_id=location_id, inventory=inventory)
    entry.runtime_data = runtime
    _migrate_entity_registry(hass, entry, inventory)
    registered_metadata: dict[str, tuple[object, ...]] = {}

    def register_devices() -> None:
        registry = dr.async_get(hass)
        for device in runtime.inventory.devices.values():
            if device.location_id != location_id:
                continue
            room = runtime.inventory.rooms.get(device.room_id) if device.room_id else None
            device_info = device_info_for(device)
            metadata = (
                device.name,
                device_info.get("manufacturer"),
                device_info.get("model"),
                device_info.get("hw_version"),
                device_info.get("sw_version"),
                room[1] if room and room[0] == location_id else None,
            )
            if registered_metadata.get(device.device_id) == metadata:
                continue
            registry_entry = registry.async_get_or_create(
                config_entry_id=entry.entry_id,
                suggested_area=room[1] if room and room[0] == location_id else None,
                **device_info,
            )
            if registry_entry.manufacturer == "SmartThings Web":
                registry.async_update_device(registry_entry.id, manufacturer=None)
            registered_metadata[device.device_id] = metadata

    register_devices()
    entry.async_on_unload(runtime.subscribe(register_devices))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_create_background_task(hass, _event_loop(entry), "smartthings_web_events")
    entry.async_create_background_task(
        hass,
        _repair_loop(hass, entry, client),
        "smartthings_web_repairs",
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SmartThingsWebConfigEntry) -> bool:
    """Unload a SmartThings Web config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _event_loop(entry: SmartThingsWebConfigEntry) -> None:
    """Maintain the Bridge push stream."""
    runtime = entry.runtime_data
    reconnect_delay = _EVENT_RECONNECT_MIN_DELAY
    while True:
        try:
            runtime.apply_inventory(await runtime.client.async_get_inventory())
            async for event in runtime.client.async_events():
                await runtime.handle_event(event)
                reconnect_delay = _EVENT_RECONNECT_MIN_DELAY
        except BridgeAuthError:
            await asyncio.sleep(5)
        except BridgeClientError:
            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, _EVENT_RECONNECT_MAX_DELAY)
        except asyncio.CancelledError:
            raise
        except Exception:
            _LOGGER.exception("smartthings_web_event_loop_failed")
            await asyncio.sleep(max(reconnect_delay, 0.25))
            reconnect_delay = min(reconnect_delay * 2, _EVENT_RECONNECT_MAX_DELAY)
        else:
            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, _EVENT_RECONNECT_MAX_DELAY)


async def _repair_loop(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    client: SmartThingsWebBridgeClient,
) -> None:
    """Refresh Bridge-health repairs without polling SmartThings device state."""
    while True:
        try:
            await asyncio.sleep(60)
            await _async_update_repairs(hass, entry, client)
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(60)


def _control_mode(entry: ConfigEntry) -> str:
    """Return effective control mode, preserving old entries as write-capable."""
    value = entry.options.get(CONF_CONTROL_MODE)
    if value in {CONTROL_MODE_READ_ONLY, CONTROL_MODE_SAFE_CONTROL}:
        return value
    value = entry.data.get(CONF_CONTROL_MODE)
    if value in {CONTROL_MODE_READ_ONLY, CONTROL_MODE_SAFE_CONTROL}:
        return value
    return CONTROL_MODE_SAFE_CONTROL


async def _async_update_repairs(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    client: SmartThingsWebBridgeClient,
) -> None:
    """Create or dismiss the Samsung-login repair from non-secret Bridge health."""
    try:
        health = await client.async_get_health()
    except BridgeClientError:
        return
    details = health.get("details") if isinstance(health.get("details"), dict) else {}
    category = _health_text(details.get("urlCategory"))
    state = _health_text(details.get("state"))
    issue_id = f"{entry.entry_id}_{REPAIR_SAMSUNG_LOGIN_REQUIRED}"
    login_required = state in {
        "login_required",
        "samsung_login_required",
        "not_authenticated",
    } and category is not None and _is_samsung_login_category(category)
    if login_required:
        ir.async_create_issue(
            hass,
            DOMAIN,
            issue_id,
            is_fixable=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key=REPAIR_SAMSUNG_LOGIN_REQUIRED,
        )
        return
    ir.async_delete_issue(hass, DOMAIN, issue_id)


def _health_text(value: object) -> str | None:
    return value.lower() if isinstance(value, str) else None


def _is_samsung_login_category(value: str) -> bool:
    return any(term in value for term in ("samsung", "login", "auth", "account"))


def _migrate_entity_registry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    inventory: BridgeInventory,
) -> None:
    """Repair only this integration's old unique IDs and binary switch artifacts."""
    registry = er.async_get(hass)
    registry_entries = list(er.async_entries_for_config_entry(registry, entry.entry_id))
    current_entity_ids = {
        getattr(entity_entry, "entity_id", "") for entity_entry in registry_entries
    }
    old_to_new: dict[str, str] = {}
    duplicate_number_ids: set[str] = set()
    stale_firmware_sensor_ids: set[str] = set()
    stale_event_sensor_ids: set[str] = set()
    stale_null_sensor_ids: set[str] = set()
    stale_null_update_ids: set[str] = set()
    stale_primary_sensor_ids: set[str] = set()
    synthetic_refresh_ids: set[str] = set()
    number_state_ids_by_device: dict[str, set[str]] = {}
    switch_ids: set[str] = set()
    primary_domain_switch_ids: set[str] = set()
    current_fan_ids: set[str] = set()
    current_image_ids: set[str] = set()
    current_media_ids: set[str] = set()
    current_device_ids: set[str] = set()
    active_number_ids: set[str] = set()
    for device in inventory.devices.values():
        if device.location_id != entry.data[CONF_LOCATION_ID]:
            continue
        current_device_ids.add(device.device_id)
        synthetic_refresh_ids.add(f"{device.device_id}_refresh")
        image_device = is_image_device(device)
        firmware = firmware_states(device)
        if not firmware and any(
            state.attribute in FIRMWARE_ATTRIBUTES
            for state in device.states.values()
        ):
            stale_null_update_ids.add(f"{device.device_id}_firmware_update")
        for state in firmware.values():
            stale_firmware_sensor_ids.add(entity_unique_id(device.device_id, state))
        for state in device.states.values():
            if state.attribute in FIRMWARE_ATTRIBUTES:
                stale_firmware_sensor_ids.add(entity_unique_id(device.device_id, state))
            if state.attribute == "button":
                stale_event_sensor_ids.add(entity_unique_id(device.device_id, state))
            if sensor_state_owned_by_primary_domain(device, state):
                stale_primary_sensor_ids.add(entity_unique_id(device.device_id, state))
            if (
                not state_has_entity_value(state)
                and sensor_state_allowed(
                    state.attribute,
                    firmware=state.attribute in FIRMWARE_ATTRIBUTES,
                    image_device=image_device,
                    primary_domain=sensor_state_owned_by_primary_domain(device, state),
                )
            ):
                stale_null_sensor_ids.add(entity_unique_id(device.device_id, state))
        number_state_ids_by_device[device.device_id] = {
            entity_unique_id(device.device_id, state) for state in device.states.values()
        }
        if is_fan_device(device):
            current_fan_ids.add(device.device_id)
        if is_image_device(device):
            current_image_ids.add(device.device_id)
        if is_media_device(device):
            current_media_ids.add(device.device_id)
        for state in device.states.values():
            new_unique_id = entity_unique_id(device.device_id, state)
            old_unique_id = f"{new_unique_id}_{state.attribute}"
            old_to_new[old_unique_id] = new_unique_id
            if state.attribute == "switch":
                switch_ids.update((old_unique_id, new_unique_id))
                if is_media_device(device) or is_fan_device(device):
                    primary_domain_switch_ids.update((old_unique_id, new_unique_id))
        for control in number_controls(device):
            state = _matching_control_state(device, control)
            control_unique_id = f"{device.device_id}_number_{control.control_id}"
            if state is None:
                active_number_ids.add(control_unique_id)
                continue
            state_unique_id = entity_unique_id(device.device_id, state)
            active_number_ids.add(state_unique_id)
            duplicate_number_ids.add(control_unique_id)
            old_to_new[control_unique_id] = state_unique_id

    stale_registry_number_ids = _stale_registry_number_ids(
        registry_entries,
        number_state_ids_by_device,
    )

    for entity_entry in registry_entries:
        if entity_entry.platform != DOMAIN:
            continue
        registry_entity_id = entity_entry.entity_id
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_firmware_sensor_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_event_sensor_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_null_sensor_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.UPDATE
            and entity_entry.unique_id in stale_null_update_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_primary_sensor_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.BUTTON
            and entity_entry.unique_id in synthetic_refresh_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.NUMBER
            and entity_entry.unique_id in stale_registry_number_ids
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.NUMBER
            and entity_entry.unique_id not in duplicate_number_ids
            and _unobserved_number_unique_id(
                entity_entry.unique_id,
                current_device_ids,
                active_number_ids,
            )
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if entity_entry.domain == Platform.NUMBER and entity_entry.unique_id in duplicate_number_ids:
            new_unique_id = old_to_new[entity_entry.unique_id]
            existing = registry.async_get_entity_id(entity_entry.domain, DOMAIN, new_unique_id)
            if existing is None:
                registry.async_update_entity(entity_entry.entity_id, new_unique_id=new_unique_id)
            else:
                registry.async_remove(entity_entry.entity_id)
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
        if (
            entity_entry.domain == Platform.MEDIA_PLAYER
            and _stale_device_domain_unique_id(
                entity_entry.unique_id,
                "media_player",
                current_device_ids,
                current_media_ids,
            )
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.IMAGE
            and _stale_device_domain_unique_id(
                entity_entry.unique_id,
                "image",
                current_device_ids,
                current_image_ids,
            )
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and _stale_non_image_sensor_unique_id(
                entity_entry.unique_id,
                current_device_ids,
                current_image_ids,
            )
        ):
            registry.async_remove(entity_entry.entity_id)
            continue
        new_entity_id = _deduplicated_generated_entity_id(
            entity_entry,
            current_device_ids,
            current_entity_ids,
        )
        if new_entity_id is not None and registry.async_get(new_entity_id) is not None:
            new_entity_id = None
        if new_entity_id is not None:
            registry.async_update_entity(
                registry_entity_id,
                new_entity_id=new_entity_id,
            )
            current_entity_ids.discard(registry_entity_id)
            current_entity_ids.add(new_entity_id)
            registry_entity_id = new_entity_id
        new_unique_id = old_to_new.get(entity_entry.unique_id)
        if new_unique_id is None:
            continue
        existing = registry.async_get_entity_id(entity_entry.domain, DOMAIN, new_unique_id)
        if existing is None:
            registry.async_update_entity(registry_entity_id, new_unique_id=new_unique_id)


def _deduplicated_generated_entity_id(
    entity_entry: object,
    current_device_ids: set[str],
    current_entity_ids: set[str],
) -> str | None:
    """Remove one repeated leading token from scoped automatic entity IDs."""
    unique_id = getattr(entity_entry, "unique_id", "")
    if not any(
        unique_id == device_id or unique_id.startswith(f"{device_id}_")
        for device_id in current_device_ids
    ):
        return None
    entity_id = getattr(entity_entry, "entity_id", "")
    domain, separator, object_id = entity_id.partition(".")
    if not separator:
        return None
    parts = object_id.split("_")
    if len(parts) < 3 or parts[0] != parts[1]:
        return None
    candidate = f"{domain}.{'_'.join(parts[1:])}"
    return candidate if candidate not in current_entity_ids else None


def _stale_fan_unique_id(
    unique_id: str,
    current_device_ids: set[str],
    current_fan_ids: set[str],
) -> bool:
    """Return whether an old device fan entity no longer matches inventory."""
    return _stale_device_domain_unique_id(
        unique_id,
        "fan",
        current_device_ids,
        current_fan_ids,
    )


def _stale_device_domain_unique_id(
    unique_id: str,
    suffix: str,
    current_device_ids: set[str],
    current_domain_device_ids: set[str],
) -> bool:
    """Return whether an old device-domain entity no longer matches inventory."""
    if not unique_id.endswith(f"_{suffix}"):
        return False
    device_id = unique_id.removesuffix(f"_{suffix}")
    return device_id in current_device_ids and device_id not in current_domain_device_ids


def _unobserved_number_unique_id(
    unique_id: str,
    current_device_ids: set[str],
    active_number_ids: set[str],
) -> bool:
    """Remove old writable numbers that no longer have an observed web slider."""
    return unique_id not in active_number_ids and any(
        unique_id.startswith(f"{device_id}_") for device_id in current_device_ids
    )


def _stale_non_image_sensor_unique_id(
    unique_id: str,
    current_device_ids: set[str],
    current_image_ids: set[str],
) -> bool:
    """Remove old image-metadata sensors from devices that are not cameras."""
    image_suffixes = tuple(f"_{attribute}" for attribute in IMAGE_ATTRIBUTES)
    return unique_id.endswith(image_suffixes) and any(
        unique_id.startswith(f"{device_id}_")
        for device_id in current_device_ids - current_image_ids
    )


def _stale_registry_number_ids(
    registry_entries: list[object],
    state_ids_by_device: dict[str, set[str]],
) -> set[str]:
    """Find old control-number entries duplicated by a registered state number."""
    state_stems_by_device: dict[str, set[str]] = {
        device_id: set() for device_id in state_ids_by_device
    }
    for entity_entry in registry_entries:
        if (
            getattr(entity_entry, "platform", None) != DOMAIN
            or getattr(entity_entry, "domain", None) != Platform.NUMBER
            or getattr(entity_entry, "disabled_by", None) is not None
        ):
            continue
        unique_id = getattr(entity_entry, "unique_id", "")
        for device_id, state_ids in state_ids_by_device.items():
            if unique_id in state_ids:
                state_stems_by_device[device_id].add(
                    _entity_id_stem(getattr(entity_entry, "entity_id", ""))
                )
                break

    stale: set[str] = set()
    for entity_entry in registry_entries:
        if (
            getattr(entity_entry, "platform", None) != DOMAIN
            or getattr(entity_entry, "domain", None) != Platform.NUMBER
        ):
            continue
        unique_id = getattr(entity_entry, "unique_id", "")
        entity_stem = _entity_id_stem(getattr(entity_entry, "entity_id", ""))
        for device_id, state_stems in state_stems_by_device.items():
            if unique_id.startswith(f"{device_id}_number_") and entity_stem in state_stems:
                stale.add(unique_id)
                break
    return stale


def _entity_id_stem(entity_id: str) -> str:
    """Remove only HA's numeric duplicate suffix from an entity ID."""
    head, separator, suffix = entity_id.rpartition("_")
    return head if separator and suffix.isdigit() else entity_id


def _matching_control_state(device: BridgeDevice, control: object):
    """Find the state mirrored by an observed slider control."""
    matches = [
        state
        for state in device.states.values()
        if state.attribute == getattr(control, "attribute", None)
        and (
            getattr(control, "component", None) is None
            or state.component == getattr(control, "component", None)
        )
        and (
            getattr(control, "capability", None) is None
            or state.capability == getattr(control, "capability", None)
        )
    ]
    return matches[0] if len(matches) == 1 else None

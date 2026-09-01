"""SmartThings Web integration."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Sequence

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_RESTORED, STATE_UNAVAILABLE, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import slugify

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
    button_controls,
    control_kind,
    disambiguated_state_names,
    entity_unique_id,
    firmware_states,
    is_fan_device,
    is_image_device,
    is_media_device,
    location_name,
    number_controls,
    noncanonical_refresh_controls,
    room_free_display_name,
    secondary_switch_name_overrides,
    sensor_state_allowed,
    sensor_state_owned_by_primary_domain,
    state_has_entity_value,
)
from .services import async_setup_services
from .naming import (
    canonical_entity_object_id,
    canonical_primary_control_object_id,
)

_LOGGER = logging.getLogger(__name__)

_EVENT_RECONNECT_MIN_DELAY = 1.0
_EVENT_RECONNECT_MAX_DELAY = 60.0

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
    await async_setup_services(hass)
    _migrate_entity_registry(hass, entry, inventory)
    registered_metadata: dict[str, tuple[object, ...]] = {}

    def register_devices() -> None:
        registry = dr.async_get(hass)
        for device in runtime.inventory.devices.values():
            if device.location_id != location_id:
                continue
            room = runtime.inventory.rooms.get(device.room_id) if device.room_id else None
            display_name = room_free_display_name(runtime, device)
            device_info = device_info_for(device, display_name=display_name)
            metadata = (
                display_name,
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
    entry.async_on_unload(_subscribe_entity_registry_migration(hass, entry))
    entry.async_create_background_task(hass, _event_loop(hass, entry), "smartthings_web_events")
    entry.async_create_background_task(
        hass,
        _repair_loop(hass, entry, client),
        "smartthings_web_repairs",
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SmartThingsWebConfigEntry) -> bool:
    """Unload a SmartThings Web config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


def _subscribe_entity_registry_migration(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
) -> object:
    """Repair generated entity IDs after dynamic platform discovery settles."""
    scheduled = False
    active = True
    delayed_handles: list[object] = []
    runtime = entry.runtime_data
    last_topology: tuple[object, ...] | None = None

    def run_migration() -> None:
        nonlocal scheduled
        scheduled = False
        if not active:
            return
        _migrate_entity_registry(hass, entry, runtime.inventory)

    def schedule_migration() -> None:
        nonlocal scheduled
        if not active or scheduled:
            return
        scheduled = True
        hass.loop.call_soon(run_migration)

    def schedule_settled_migrations() -> None:
        """Retry through startup so transient restored-state reservations can clear."""
        nonlocal last_topology
        topology = _entity_registry_topology_fingerprint(
            runtime.inventory,
            entry.data[CONF_LOCATION_ID],
        )
        if topology == last_topology:
            return
        last_topology = topology
        for handle in delayed_handles:
            cancel = getattr(handle, "cancel", None)
            if callable(cancel):
                cancel()
        delayed_handles.clear()
        schedule_migration()
        call_later = getattr(hass.loop, "call_later", None)
        if callable(call_later):
            for delay in (0.5, 2.0, 10.0, 30.0):
                handle = call_later(delay, schedule_migration)
                if handle is not None:
                    delayed_handles.append(handle)

    unsubscribe_inventory = runtime.subscribe(schedule_settled_migrations)
    schedule_settled_migrations()

    def unsubscribe() -> None:
        nonlocal active
        active = False
        unsubscribe_inventory()
        for handle in delayed_handles:
            cancel = getattr(handle, "cancel", None)
            if callable(cancel):
                cancel()
        delayed_handles.clear()

    return unsubscribe


def _entity_registry_topology_fingerprint(
    inventory: BridgeInventory,
    location_id: str,
) -> tuple[object, ...]:
    """Return only inventory structure that can change entity discovery.

    Ordinary push updates replace values and timestamps many times per minute.
    Those updates already notify the exact entity listener and must not trigger
    a full entity-registry migration.  A new state/control, a value becoming
    available, or device naming/classification metadata still changes this
    fingerprint and receives the bounded settled migration passes.
    """
    rooms = tuple(
        sorted(
            (room_id, name)
            for room_id, (owner_location_id, name) in inventory.rooms.items()
            if owner_location_id == location_id
        )
    )
    devices: list[tuple[object, ...]] = []
    for device in sorted(inventory.devices.values(), key=lambda item: item.device_id):
        if device.location_id != location_id:
            continue
        states = tuple(
            sorted(
                (
                    state.component,
                    state.capability,
                    state.attribute,
                    state.unit,
                    state.component_role,
                    state.capability_role,
                    state.value is not None,
                    type(state.value).__name__,
                )
                for state in device.states.values()
            )
        )
        controls = tuple(
            sorted(
                (
                    control.control_id,
                    control.kind,
                    control.label,
                    control.component,
                    control.capability,
                    control.attribute,
                    control.commands,
                    control.options,
                    tuple(sorted(control.option_labels.items())),
                    tuple(sorted(control.option_commands.items())),
                    control.minimum,
                    control.maximum,
                    control.step,
                )
                for control in device.controls.values()
            )
        )
        devices.append(
            (
                device.device_id,
                device.room_id,
                device.name,
                device.device_type,
                device.presentation.asset_type if device.presentation else None,
                states,
                controls,
            )
        )
    # Readiness gates destructive orphan cleanup, so false -> true must run one
    # migration even when the device topology itself is unchanged.
    return (inventory.ready, rooms, tuple(devices))


async def _event_loop(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
) -> None:
    """Maintain the Bridge push stream."""
    runtime = entry.runtime_data
    reconnect_delay = _EVENT_RECONNECT_MIN_DELAY
    while True:
        try:
            runtime.apply_reconnect_inventory(await runtime.client.async_get_inventory())
            async for event in runtime.client.async_events():
                await runtime.handle_event(event)
                reconnect_delay = _EVENT_RECONNECT_MIN_DELAY
        except BridgeAuthError:
            entry.async_start_reauth(hass)
            return
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
    stale_unobserved_switch_ids: set[str] = set()
    stale_noncanonical_refresh_ids: set[str] = set()
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
                if control_kind(device, state) is None:
                    stale_unobserved_switch_ids.add(new_unique_id)
                if is_media_device(device) or is_fan_device(device):
                    primary_domain_switch_ids.update((old_unique_id, new_unique_id))
        for control in noncanonical_refresh_controls(device):
            stale_noncanonical_refresh_ids.add(
                f"{device.device_id}_button_{control.control_id}"
            )
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

    device_room_slugs: dict[str, str | None] = {}
    location_id = entry.data[CONF_LOCATION_ID]
    for device_id, device in inventory.devices.items():
        if device.location_id != location_id or not device.room_id:
            continue
        room = inventory.rooms.get(device.room_id)
        if room is None or room[0] != location_id:
            device_room_slugs[device_id] = None
            continue
        device_room_slugs[device_id] = slugify(room[1]) or None
    # Longest-prefix order so the owning Bridge device ID can be resolved from
    # the entity unique_id alone; registry device rows use their own UUIDs.
    room_slug_prefixes = sorted(
        (
            (device_id, slug, slugify(inventory.devices[device_id].name) or None)
            for device_id, slug in device_room_slugs.items()
            if slug
        ),
        key=lambda item: len(item[0]),
        reverse=True,
    )
    registry_uuid_room_slugs = _registry_uuid_room_slugs(hass, device_room_slugs)
    if registry_uuid_room_slugs:
        uuid_prefix_pairs = [
            (uuid_key, slug, None)
            for uuid_key, slugs in sorted(registry_uuid_room_slugs.items(), key=lambda i: -len(i[0]))
            for slug in slugs
        ]
        room_slug_prefixes.extend(uuid_prefix_pairs)

    # Every unique_id the current inventory can produce for its devices; rows
    # that no longer match (legacy duplicate creations from earlier builds)
    # are stale and are removed so a single device keeps a single card.
    expected_uids: set[str] = set()
    for device in inventory.devices.values():
        if device.location_id != entry.data[CONF_LOCATION_ID]:
            continue
        for state in device.states.values():
            expected_uids.add(entity_unique_id(device.device_id, state))
        expected_uids.add(f"{device.device_id}_refresh")
        for control in button_controls(device):
            expected_uids.add(f"{device.device_id}_button_{control.control_id}")
        for control in number_controls(device):
            expected_uids.add(f"{device.device_id}_number_{control.control_id}")
        if is_fan_device(device):
            expected_uids.add(f"{device.device_id}_fan")
        if is_media_device(device):
            expected_uids.add(f"{device.device_id}_media_player")
        if is_image_device(device):
            expected_uids.add(f"{device.device_id}_image")
        if firmware_states(device):
            expected_uids.add(f"{device.device_id}_firmware_update")

    stale_duplicate_rows: list[object] = []
    removed_entity_ids: set[str] = set()

    def remove_registry_entity(entity_id: str) -> None:
        """Remove one row and release its ID for this same migration pass."""
        if not inventory.ready:
            return
        if registry.async_get(entity_id) is None:
            return
        registry.async_remove(entity_id)
        removed_entity_ids.add(entity_id)
        current_entity_ids.discard(entity_id)

    owner_device_cache: dict[str, object | None] = {}

    def owner_device_for(entity_entry: object) -> object | None:
        """Resolve the Bridge owner for this exact registry row."""
        entity_uid = getattr(entity_entry, "unique_id", "")
        if entity_uid in owner_device_cache:
            return owner_device_cache[entity_uid]
        owner_device = next(
            (
                device
                for device in inventory.devices.values()
                if device.location_id == entry.data[CONF_LOCATION_ID]
                and (
                    entity_uid == device.device_id
                    or entity_uid.startswith(device.device_id + "_")
                )
            ),
            None,
        )
        owner_device_cache[entity_uid] = owner_device
        return owner_device

    for entity_entry in registry_entries:
        if entity_entry.platform != DOMAIN:
            continue
        entity_uid = entity_entry.unique_id
        owner_device = owner_device_for(entity_entry)
        if (
            owner_device is not None
            and entity_uid not in expected_uids
            and entity_uid not in old_to_new
            and getattr(entity_entry, "name", None) is None
            and not entity_uid.endswith(
                (
                    "_fan",
                    "_media_player",
                    "_image",
                    "_firmware_update",
                    "_refresh",
                    "_climate",
                    "_cover",
                )
            )
            and "_number_" not in entity_uid
        ):
            stale_duplicate_rows.append(entity_entry)
    for entity_entry in stale_duplicate_rows:
        remove_registry_entity(entity_entry.entity_id)

    _relocate_primary_name_collisions(
        hass,
        registry,
        registry_entries,
        inventory,
        entry.data[CONF_LOCATION_ID],
        current_entity_ids,
        removed_entity_ids,
    )
    registry_entries = list(er.async_entries_for_config_entry(registry, entry.entry_id))
    fallback_repair_rows: list[tuple[object, str]] = []
    for candidate_entry in registry_entries:
        if getattr(candidate_entry, "platform", None) != DOMAIN:
            continue
        candidate_owner = owner_device_for(candidate_entry)
        candidate_target = _stale_fallback_generated_entity_id(
            candidate_entry,
            candidate_owner,
            inventory,
        )
        if candidate_target is not None:
            fallback_repair_rows.append((candidate_entry, candidate_target))
    _repair_numbered_fallback_entity_ids(
        hass,
        registry,
        fallback_repair_rows,
        current_entity_ids,
    )
    # Home Assistant replaces immutable RegistryEntry objects on update. Read
    # the rows again so metadata repair uses the renamed entity ID immediately.
    registry_entries = list(er.async_entries_for_config_entry(registry, entry.entry_id))

    for entity_entry in registry_entries:
        if entity_entry.platform != DOMAIN:
            continue
        if entity_entry.entity_id in removed_entity_ids:
            # Already removed by the stale-duplicate pre-pass; the snapshot
            # list still carries it, and updating a removed row would crash.
            continue
        owner_device = owner_device_for(entity_entry)
        registry_entity_id = entity_entry.entity_id
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_firmware_sensor_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_event_sensor_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_null_sensor_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.UPDATE
            and entity_entry.unique_id in stale_null_update_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and entity_entry.unique_id in stale_primary_sensor_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SWITCH
            and entity_entry.unique_id in stale_unobserved_switch_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.BUTTON
            and entity_entry.unique_id in stale_noncanonical_refresh_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.BUTTON
            and entity_entry.unique_id in synthetic_refresh_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.NUMBER
            and entity_entry.unique_id in stale_registry_number_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
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
            remove_registry_entity(entity_entry.entity_id)
            continue
        if entity_entry.domain == Platform.NUMBER and entity_entry.unique_id in duplicate_number_ids:
            new_unique_id = old_to_new[entity_entry.unique_id]
            existing = registry.async_get_entity_id(entity_entry.domain, DOMAIN, new_unique_id)
            if existing is None:
                registry.async_update_entity(entity_entry.entity_id, new_unique_id=new_unique_id)
            else:
                remove_registry_entity(entity_entry.entity_id)
            continue
        if entity_entry.domain == Platform.BINARY_SENSOR and entity_entry.unique_id in switch_ids:
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SWITCH
            and entity_entry.unique_id in primary_domain_switch_ids
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.FAN
            and _stale_fan_unique_id(entity_entry.unique_id, current_device_ids, current_fan_ids)
        ):
            remove_registry_entity(entity_entry.entity_id)
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
            remove_registry_entity(entity_entry.entity_id)
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
            remove_registry_entity(entity_entry.entity_id)
            continue
        if (
            entity_entry.domain == Platform.SENSOR
            and _stale_non_image_sensor_unique_id(
                entity_entry.unique_id,
                current_device_ids,
                current_image_ids,
            )
        ):
            remove_registry_entity(entity_entry.entity_id)
            continue
        new_entity_id = _deduplicated_generated_entity_id(
            entity_entry,
            current_device_ids,
            current_entity_ids,
        )
        canonical_primary_entity_id = _canonical_generated_primary_entity_id(
            entity_entry,
            owner_device,
            inventory,
        )
        if canonical_primary_entity_id is not None:
            new_entity_id = canonical_primary_entity_id
        canonical_state_entity_id = _canonical_generated_state_entity_id(
            entity_entry,
            owner_device,
            inventory,
        )
        if canonical_state_entity_id is not None:
            new_entity_id = canonical_state_entity_id
        numbered_entity_id = _canonical_numbered_generated_entity_id(
            entity_entry,
            owner_device,
            inventory,
        )
        if (
            numbered_entity_id is not None
            and canonical_primary_entity_id is None
            and canonical_state_entity_id is None
        ):
            new_entity_id = numbered_entity_id
        renamed_this_entry = False
        if new_entity_id is not None and registry.async_get(new_entity_id) is not None:
            new_entity_id = None
        if (
            new_entity_id is not None
            and registry.async_get(registry_entity_id) is not None
        ):
            if _rename_generated_registry_entity(
                hass, registry, registry_entity_id, new_entity_id
            ):
                current_entity_ids.discard(registry_entity_id)
                current_entity_ids.add(new_entity_id)
                registry_entity_id = new_entity_id
                renamed_this_entry = True
        if not renamed_this_entry:
            room_named_candidates = _room_named_primary_entity_ids(
                entity_entry,
                inventory,
                current_entity_ids,
            )
            for room_named_entity_id in room_named_candidates:
                if (
                    room_named_entity_id != registry_entity_id
                    and registry.async_get(room_named_entity_id) is None
                    and room_named_entity_id not in current_entity_ids
                    and registry.async_get(registry_entity_id) is not None
                ):
                    if _rename_generated_registry_entity(
                        hass, registry, registry_entity_id, room_named_entity_id
                    ):
                        current_entity_ids.discard(registry_entity_id)
                        current_entity_ids.add(room_named_entity_id)
                        registry_entity_id = room_named_entity_id
                        renamed_this_entry = True
                        break
        if (
            not renamed_this_entry
            and _exact_room_named_device_slug(entity_entry, inventory) is None
        ):
            room_free_candidates = _room_prefixed_generated_entity_ids(
                entity_entry,
                current_device_ids,
                room_slug_prefixes,
                current_entity_ids,
            )
            for room_free_entity_id in room_free_candidates:
                if (
                    room_free_entity_id != registry_entity_id
                    and registry.async_get(room_free_entity_id) is None
                    and room_free_entity_id not in current_entity_ids
                    and registry.async_get(registry_entity_id) is not None
                ):
                    if _rename_generated_registry_entity(
                        hass, registry, registry_entity_id, room_free_entity_id
                    ):
                        current_entity_ids.discard(registry_entity_id)
                        current_entity_ids.add(room_free_entity_id)
                        registry_entity_id = room_free_entity_id
                        break
        current_registry_entry = registry.async_get(registry_entity_id)
        metadata_entry = current_registry_entry or entity_entry
        canonical_suggested_object_id = _canonical_registry_suggested_object_id(
            inventory,
            owner_device,
            metadata_entry,
            registry_entity_id,
        )
        canonical_object_id_base = _canonical_registry_object_id_base(
            inventory,
            owner_device,
            metadata_entry,
        )
        if (
            getattr(metadata_entry, "name", None) is not None
            and not _registry_entry_matches_device_state(metadata_entry, owner_device)
            and not (
                _stale_restore_object_id(getattr(metadata_entry, "object_id_base", None))
                or _stale_restore_object_id(
                    getattr(metadata_entry, "suggested_object_id", None)
                )
            )
        ):
            canonical_object_id_base = None
            canonical_suggested_object_id = None
        if canonical_suggested_object_id is not None:
            canonical_entity_id = (
                f"{getattr(metadata_entry, 'domain', '')}.{canonical_suggested_object_id}"
            )
            if (
                canonical_entity_id != getattr(metadata_entry, "entity_id", None)
                and registry.async_get(canonical_entity_id) is not None
            ):
                final_object_id = registry_entity_id.partition(".")[2]
                numbered_prefix = f"{canonical_suggested_object_id}_"
                numbered_suffix = (
                    final_object_id[len(numbered_prefix) :]
                    if final_object_id.startswith(numbered_prefix)
                    else ""
                )
                if numbered_suffix.isdigit() and int(numbered_suffix) >= 2:
                    canonical_suggested_object_id = final_object_id
                else:
                    canonical_suggested_object_id = None
                    canonical_object_id_base = None
        _refresh_generated_registry_metadata(
            registry,
            entry,
            metadata_entry,
            canonical_object_id_base,
            canonical_suggested_object_id,
        )
        new_unique_id = old_to_new.get(entity_entry.unique_id)
        if new_unique_id is None:
            continue
        existing = registry.async_get_entity_id(entity_entry.domain, DOMAIN, new_unique_id)
        if existing is None and registry.async_get(registry_entity_id) is not None:
            registry.async_update_entity(registry_entity_id, new_unique_id=new_unique_id)
    _remove_orphan_bridge_device_cards(hass, entry, inventory, registry_entries, removed_entity_ids)


def _rename_generated_registry_entity(
    hass: HomeAssistant,
    registry: object,
    current_entity_id: str,
    new_entity_id: str,
) -> bool:
    """Rename a generated row without aborting setup on an HA state reservation."""
    try:
        registry.async_update_entity(current_entity_id, new_entity_id=new_entity_id)
    except ValueError:
        if _remove_stale_restored_state(hass, registry, new_entity_id):
            try:
                registry.async_update_entity(
                    current_entity_id,
                    new_entity_id=new_entity_id,
                )
            except ValueError:
                pass
            else:
                return True
        _LOGGER.warning(
            "Could not restore SmartThings Web entity ID %s to %s because Home "
            "Assistant has reserved the target ID",
            current_entity_id,
            new_entity_id,
        )
        return False
    return True


def _remove_stale_restored_state(
    hass: HomeAssistant,
    registry: object,
    entity_id: str,
) -> bool:
    """Remove an unavailable restored state that no registry row owns."""
    states = getattr(hass, "states", None)
    if states is None or registry.async_get(entity_id) is not None:
        return False
    state = states.get(entity_id)
    if (
        state is None
        or getattr(state, "state", None) != STATE_UNAVAILABLE
        or getattr(state, "attributes", {}).get(ATTR_RESTORED) is not True
    ):
        return False
    states.async_remove(entity_id)
    return True


def _repair_numbered_fallback_entity_ids(
    hass: HomeAssistant,
    registry: object,
    fallback_rows: Sequence[tuple[object, str]],
    current_entity_ids: set[str],
) -> None:
    """Repair fallbacks, advancing past registry and restored-state reservations."""
    reserved = set(current_entity_ids)
    ordered_rows = sorted(
        fallback_rows,
        key=lambda item: (
            item[1],
            str(getattr(item[0], "unique_id", "")),
            str(getattr(item[0], "entity_id", "")),
        ),
    )
    for entity_entry, canonical_entity_id in ordered_rows:
        current_entity_id = str(getattr(entity_entry, "entity_id", ""))
        for index in range(1, 1000):
            candidate = (
                canonical_entity_id
                if index == 1
                else f"{canonical_entity_id}_{index}"
            )
            if candidate == current_entity_id:
                break
            if candidate in reserved or registry.async_get(candidate) is not None:
                continue
            if not _rename_generated_registry_entity(
                hass,
                registry,
                current_entity_id,
                candidate,
            ):
                reserved.add(candidate)
                continue
            current_entity_ids.discard(current_entity_id)
            current_entity_ids.add(candidate)
            reserved.discard(current_entity_id)
            reserved.add(candidate)
            break


def _relocate_primary_name_collisions(
    hass: HomeAssistant,
    registry: object,
    registry_entries: Sequence[object],
    inventory: BridgeInventory,
    location_id: str,
    current_entity_ids: set[str],
    removed_entity_ids: set[str],
) -> None:
    """Give exact device-name IDs priority over HA collision suffixes."""
    primary_rows: list[tuple[object, object, str, str]] = []
    targets: dict[str, list[str]] = {}
    for entity_entry in registry_entries:
        if (
            getattr(entity_entry, "platform", None) != DOMAIN
            or getattr(entity_entry, "entity_id", None) in removed_entity_ids
            or getattr(entity_entry, "name", None) is not None
        ):
            continue
        domain = getattr(entity_entry, "domain", "")
        domain_value = getattr(domain, "value", domain)
        if domain_value not in {"climate", "cover", "fan", "media_player"}:
            continue
        unique_id = str(getattr(entity_entry, "unique_id", ""))
        device = next(
            (
                item
                for item in inventory.devices.values()
                if item.location_id == location_id
                and unique_id == f"{item.device_id}_{domain_value}"
            ),
            None,
        )
        if device is None:
            continue
        object_id = (
            canonical_primary_control_object_id(inventory, device)
            if domain_value == "fan"
            else canonical_entity_object_id(inventory, device)
        )
        if not object_id:
            continue
        target = f"{domain_value}.{object_id}"
        primary_rows.append((entity_entry, device, domain_value, target))
        targets.setdefault(target, []).append(unique_id)

    reserved_targets = set(targets)
    for entity_entry, _device, _domain, own_target in primary_rows:
        current_entity_id = str(getattr(entity_entry, "entity_id", ""))
        unique_id = str(getattr(entity_entry, "unique_id", ""))
        target_owners = targets.get(current_entity_id, [])
        if (
            current_entity_id == own_target
            or not target_owners
            or all(owner == unique_id for owner in target_owners)
        ):
            continue
        for index in range(1, 100):
            candidate = own_target if index == 1 else f"{own_target}_{index}"
            if candidate == current_entity_id:
                continue
            if candidate in reserved_targets and candidate != own_target:
                continue
            if candidate in current_entity_ids or registry.async_get(candidate) is not None:
                continue
            if not _rename_generated_registry_entity(
                hass, registry, current_entity_id, candidate
            ):
                continue
            current_entity_ids.discard(current_entity_id)
            current_entity_ids.add(candidate)
            break


def _canonical_registry_suggested_object_id(
    inventory: BridgeInventory,
    device: object | None,
    entity_entry: object,
    final_entity_id: str,
) -> str | None:
    """Derive restore metadata from the final canonical registry target."""
    if device is None:
        return None
    domain = getattr(entity_entry, "domain", "")
    domain_value = getattr(domain, "value", domain)
    device_id = str(getattr(device, "device_id", ""))
    unique_id = str(getattr(entity_entry, "unique_id", ""))
    primary_domain = domain_value in {"climate", "cover", "fan", "media_player"}
    if primary_domain and unique_id == f"{device_id}_{domain_value}":
        base = (
            canonical_primary_control_object_id(inventory, device)
            if domain_value == "fan"
            else canonical_entity_object_id(inventory, device)
        )
        if not base:
            return None
        final_object_id = final_entity_id.partition(".")[2]
        if final_object_id == base:
            return base
        if final_object_id.startswith(f"{base}_"):
            suffix = final_object_id[len(base) + 1 :]
            if suffix.isdigit():
                return final_object_id
        if _exact_room_named_device_slug(entity_entry, inventory) is not None:
            _legacy_stem, separator, legacy_suffix = final_object_id.rpartition("_")
            if separator and legacy_suffix.isdigit() and int(legacy_suffix) >= 2:
                return f"{base}_{legacy_suffix}"
        return base
    state = next(
        (
            item
            for item in getattr(device, "states", {}).values()
            if entity_unique_id(device_id, item) == unique_id
        ),
        None,
    )
    if state is not None:
        if _registry_state_is_primary_control(domain_value, device, state):
            primary_object_id = canonical_primary_control_object_id(inventory, device)
            final_object_id = final_entity_id.partition(".")[2]
            legacy_object_id = canonical_entity_object_id(inventory, device, "switch")
            if (
                primary_object_id
                and final_object_id in {primary_object_id, legacy_object_id}
            ):
                return primary_object_id
            return final_object_id or primary_object_id
        entity_name = _generated_registry_state_name(
            entity_entry,
            device,
            state,
            inventory,
        )
        secondary_switch_role = secondary_switch_name_overrides(device).get(state.key)
        if (
            domain_value == Platform.SWITCH
            and getattr(state, "attribute", None) == "switch"
            and secondary_switch_role is not None
        ):
            entity_name = secondary_switch_role
        return canonical_entity_object_id(inventory, device, entity_name)
    fallback_suffix = _fallback_entity_suffix_name(entity_entry, device)
    if fallback_suffix is not None:
        return canonical_entity_object_id(inventory, device, fallback_suffix)
    return canonical_entity_object_id(
        inventory,
        device,
        getattr(entity_entry, "object_id_base", None),
    )


def _refresh_generated_registry_metadata(
    registry: object,
    entry: SmartThingsWebConfigEntry,
    entity_entry: object,
    canonical_object_id_base: str | None,
    canonical_suggested_object_id: str | None,
) -> None:
    """Repair generated restore hints through Home Assistant's public API."""
    if getattr(entity_entry, "platform", None) != DOMAIN:
        return
    if getattr(entity_entry, "name", None) is not None and not (
        _stale_restore_object_id(getattr(entity_entry, "object_id_base", None))
        or _stale_restore_object_id(getattr(entity_entry, "suggested_object_id", None))
    ):
        return
    if canonical_suggested_object_id is None:
        return
    get_or_create = getattr(registry, "async_get_or_create", None)
    if not callable(get_or_create):
        return
    get_or_create(
        getattr(entity_entry, "domain", ""),
        DOMAIN,
        getattr(entity_entry, "unique_id", ""),
        config_entry=entry,
        has_entity_name=True,
        object_id_base=canonical_object_id_base,
        suggested_object_id=canonical_suggested_object_id,
    )


def _canonical_registry_object_id_base(
    inventory: BridgeInventory,
    device: object,
    entity_entry: object,
) -> str | None:
    """Return the generated entity-local object ID base without stale fallbacks."""
    unique_id = getattr(entity_entry, "unique_id", None)
    device_id = getattr(device, "device_id", "")
    domain = getattr(entity_entry, "domain", "")
    domain_value = getattr(domain, "value", domain)
    if domain_value == "fan" and unique_id == f"{device_id}_fan":
        return None
    state = next(
        (
            item
            for item in getattr(device, "states", {}).values()
            if entity_unique_id(device_id, item) == unique_id
        ),
        None,
    )
    if state is not None:
        if _registry_state_is_primary_control(domain_value, device, state):
            primary_object_id = canonical_primary_control_object_id(inventory, device)
            legacy_object_id = canonical_entity_object_id(inventory, device, "switch")
            current_object_id = str(
                getattr(entity_entry, "entity_id", "")
            ).partition(".")[2]
            if current_object_id in {primary_object_id, legacy_object_id}:
                return None
        secondary_switch_role = secondary_switch_name_overrides(device).get(state.key)
        if (
            getattr(entity_entry, "domain", "") == Platform.SWITCH
            and getattr(state, "attribute", None) == "switch"
            and secondary_switch_role is not None
        ):
            return slugify(secondary_switch_role) or None
        return slugify(
            _generated_registry_state_name(
                entity_entry,
                device,
                state,
                inventory,
            )
        ) or None
    fallback_suffix = _fallback_entity_suffix_name(entity_entry, device)
    if fallback_suffix is not None:
        return fallback_suffix
    object_id_base = getattr(entity_entry, "object_id_base", None)
    if (
        isinstance(object_id_base, str)
        and object_id_base.strip()
        and not _fallback_state_name_base(object_id_base, device)
    ):
        return slugify(object_id_base) or None
    return None


def _remove_orphan_bridge_device_cards(
    hass: object,
    entry: SmartThingsWebConfigEntry,
    inventory: BridgeInventory,
    registry_entries: Sequence[object],
    removed_entity_ids: set[str],
) -> None:
    """Remove cards for deleted Bridge device aliases without touching locations."""
    if not inventory.ready:
        # A cached or reconnect snapshot may intentionally retain only the last
        # known devices. Destructive cleanup waits for a current complete view.
        return
    device_registry = dr.async_get(hass)
    entity_registry = er.async_get(hass)
    if device_registry is None or entity_registry is None:
        return
    current_device_ids = {
        device.device_id
        for device in inventory.devices.values()
        if device.location_id == entry.data[CONF_LOCATION_ID]
    }

    def entries_for_device(device_id: str) -> list[object]:
        lookup = getattr(er, "async_entries_for_device", None)
        if callable(lookup):
            try:
                return list(
                    lookup(
                        entity_registry,
                        device_id,
                        include_disabled_entities=True,
                    )
                )
            except TypeError:
                return list(lookup(entity_registry, device_id))
        return [
            row
            for row in registry_entries
            if getattr(row, "device_id", None) == device_id
            and getattr(row, "entity_id", None) not in removed_entity_ids
        ]

    for row in _iter_device_registry_rows(device_registry):
        if entry.entry_id not in (getattr(row, "config_entries", None) or set()):
            continue
        row_identifiers = getattr(row, "identifiers", None) or set()
        ours = [
            ident[1]
            for ident in row_identifiers
            if isinstance(ident, tuple) and len(ident) >= 2 and ident[0] == DOMAIN
        ]
        stale_device_aliases = [
            bridge_id
            for bridge_id in ours
            if re.fullmatch(r"dev_[0-9]{3,32}", bridge_id)
            and bridge_id not in current_device_ids
        ]
        if not stale_device_aliases or any(
            bridge_id in current_device_ids for bridge_id in ours
        ):
            continue
        row_id = getattr(row, "id", None)
        if not row_id:
            continue

        for entity_entry in entries_for_device(row_id):
            if getattr(entity_entry, "platform", None) != DOMAIN:
                continue
            config_entry_id = getattr(entity_entry, "config_entry_id", None)
            if config_entry_id not in {None, entry.entry_id}:
                continue
            entity_id = getattr(entity_entry, "entity_id", None)
            if not isinstance(entity_id, str) or not entity_id:
                continue
            if entity_registry.async_get(entity_id) is not None:
                entity_registry.async_remove(entity_id)
                removed_entity_ids.add(entity_id)

        remaining_entries = entries_for_device(row_id)
        remaining_config_entries = set(
            getattr(row, "config_entries", None) or set()
        ) - {entry.entry_id}
        if not remaining_entries and not remaining_config_entries:
            remove_device = getattr(device_registry, "async_remove_device", None)
            if callable(remove_device):
                remove_device(row_id)
                continue
        update_device = getattr(device_registry, "async_update_device", None)
        if callable(update_device):
            try:
                update_device(row_id, remove_config_entry=entry.entry_id)
            except TypeError:
                _LOGGER.warning(
                    "SmartThings Web could not detach a stale shared device card "
                    "because Home Assistant rejected the registry update"
                )


def _iter_device_registry_rows(device_registry: object) -> list[object]:
    """Return device rows for either plain dicts or live registry wrappers."""
    raw_devices = getattr(device_registry, "devices", None)
    if raw_devices is None:
        return []
    from collections.abc import Mapping as _Mapping

    if isinstance(raw_devices, _Mapping):
        return list(raw_devices.values())
    return [row for row in raw_devices if hasattr(row, "identifiers")]


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


def _canonical_numbered_generated_entity_id(
    entity_entry: object,
    device: object | None,
    inventory: BridgeInventory,
) -> str | None:
    """Reclaim a free canonical ID from an HA collision-numbered variant.

    Removed/orphaned registry rows remain reserved during entity creation, so
    HA can initially allocate ``..._4`` even after this integration removes
    the stale rows. An explicit registry rename may safely reclaim the now-free
    canonical ID; active rows are still protected by the caller's global
    registry lookup.
    """
    if device is None or getattr(entity_entry, "name", None) is not None:
        return None
    object_id_base = getattr(entity_entry, "object_id_base", None)
    if not isinstance(object_id_base, str) or not object_id_base.strip():
        return None
    canonical_object_id = canonical_entity_object_id(
        inventory,
        device,
        object_id_base,
    )
    if not canonical_object_id:
        return None
    domain = getattr(entity_entry, "domain", "") or ""
    current_object_id = getattr(entity_entry, "entity_id", "").partition(".")[2]
    numbered_prefix = f"{canonical_object_id}_"
    if not current_object_id.startswith(numbered_prefix):
        return None
    collision_suffix = current_object_id[len(numbered_prefix):]
    if not collision_suffix.isdigit() or int(collision_suffix) < 2:
        return None
    return f"{domain}.{canonical_object_id}"


def _canonical_generated_state_entity_id(
    entity_entry: object,
    device: object | None,
    inventory: BridgeInventory,
) -> str | None:
    """Return the current generated entity ID for state-backed rows."""
    if device is None or getattr(entity_entry, "name", None) is not None:
        return None
    domain = getattr(entity_entry, "domain", "") or ""
    state = next(
        (
            item
            for item in getattr(device, "states", {}).values()
            if entity_unique_id(getattr(device, "device_id", ""), item)
            == getattr(entity_entry, "unique_id", "")
        ),
        None,
    )
    if state is None:
        return None
    if _registry_state_is_primary_control(domain, device, state):
        object_id = canonical_primary_control_object_id(inventory, device)
        if not object_id:
            return None
        legacy_object_id = canonical_entity_object_id(inventory, device, "switch")
        current_object_id = str(
            getattr(entity_entry, "entity_id", "")
        ).partition(".")[2]
        if current_object_id != legacy_object_id:
            return None
        target = f"{domain}.{object_id}"
        return target if target != getattr(entity_entry, "entity_id", "") else None
    role = (
        secondary_switch_name_overrides(device).get(state.key)
        if domain == Platform.SWITCH and getattr(state, "attribute", None) == "switch"
        else None
    )
    if role is not None:
        entity_name = role
    elif _numbered_generated_state_row(entity_entry, device, state, inventory):
        entity_name = _generated_registry_state_name(
            entity_entry,
            device,
            state,
            inventory,
        )
    else:
        return None
    object_id = canonical_entity_object_id(inventory, device, entity_name)
    if not object_id:
        return None
    target = f"{domain}.{object_id}"
    return target if target != getattr(entity_entry, "entity_id", "") else None


def _canonical_generated_primary_entity_id(
    entity_entry: object,
    device: object | None,
    inventory: BridgeInventory,
) -> str | None:
    """Return the stable room-free ID for generated device-level controls."""
    if device is None or getattr(entity_entry, "name", None) is not None:
        return None
    domain = getattr(entity_entry, "domain", "") or ""
    domain_value = getattr(domain, "value", domain)
    device_id = str(getattr(device, "device_id", ""))
    if domain_value != "fan":
        return None
    if getattr(entity_entry, "unique_id", "") != f"{device_id}_{domain_value}":
        return None
    object_id = canonical_primary_control_object_id(inventory, device)
    if not object_id:
        return None
    target = f"{domain_value}.{object_id}"
    return target if target != getattr(entity_entry, "entity_id", "") else None


def _registry_state_is_primary_control(
    domain: object,
    device: object,
    state: object,
) -> bool:
    """Return whether a state row is the device's domain-independent main control."""
    domain_value = getattr(domain, "value", domain)
    if domain_value not in {"light", "switch"}:
        return False
    if getattr(state, "attribute", None) != "switch":
        return False
    if secondary_switch_name_overrides(device).get(getattr(state, "key", ())) is not None:
        return False
    role = str(
        getattr(state, "component_role", None)
        or getattr(state, "component", "")
    ).strip().lower()
    if role == "main":
        return True
    switch_states = [
        candidate
        for candidate in getattr(device, "states", {}).values()
        if getattr(candidate, "attribute", None) == "switch"
    ]
    return len(switch_states) == 1


def _numbered_generated_state_row(
    entity_entry: object,
    device: object,
    state: object,
    inventory: BridgeInventory,
) -> bool:
    """Return whether a generated numbered row can now use a stable role."""
    siblings = [
        item
        for item in getattr(device, "states", {}).values()
        if getattr(item, "attribute", None) == getattr(state, "attribute", None)
    ]
    sibling_count = len(siblings)
    location_backed_main_presence = (
        getattr(state, "attribute", None) == "presence"
        and str(getattr(state, "component_role", "")).strip().lower() == "main"
        and getattr(device, "location_id", None) in inventory.locations
    )
    if sibling_count < 2 or (
        not _registry_state_qualifier_names(state)
        and not location_backed_main_presence
    ):
        return False
    values = (
        getattr(entity_entry, "original_name", None),
        getattr(entity_entry, "object_id_base", None),
        getattr(entity_entry, "suggested_object_id", None),
        getattr(entity_entry, "entity_id", "").partition(".")[2],
    )
    return any(
        isinstance(value, str)
        and _generated_numeric_qualifier(value, sibling_count) is not None
        for value in values
    )

def _stale_fallback_generated_entity_id(
    entity_entry: object,
    device: object | None,
    inventory: BridgeInventory,
) -> str | None:
    """Rebase IDs frozen from ``SmartThings device <id>`` onto the real name."""
    if device is None:
        return None
    device_id = getattr(device, "device_id", "")
    fallback_object_id = slugify(f"SmartThings device {device_id}") or None
    if fallback_object_id is None:
        return None
    entity_id = getattr(entity_entry, "entity_id", "")
    domain, separator, object_id = entity_id.partition(".")
    if not separator:
        return None
    if object_id != fallback_object_id and not object_id.startswith(
        f"{fallback_object_id}_"
    ):
        return None
    state = next(
        (
            item
            for item in getattr(device, "states", {}).values()
            if entity_unique_id(device_id, item) == getattr(entity_entry, "unique_id", "")
        ),
        None,
    )
    if state is not None:
        object_name = _generated_registry_state_name(
            entity_entry,
            device,
            state,
            inventory,
        )
        canonical_object_id = canonical_entity_object_id(inventory, device, object_name)
    else:
        object_name = _fallback_entity_suffix_name(entity_entry, device)
        canonical_object_id = _canonical_registry_suggested_object_id(
            inventory,
            device,
            entity_entry,
            entity_id,
        ) if object_name is None else canonical_entity_object_id(inventory, device, object_name)
    if not canonical_object_id or canonical_object_id == object_id:
        return None
    return f"{domain}.{canonical_object_id}"


def _stale_restore_object_id(value: object) -> bool:
    """Return whether HA restore metadata still carries the early fallback slug."""
    if not isinstance(value, str):
        return False
    return slugify(value).startswith("smartthings_device_dev_")


def _registry_entry_matches_device_state(
    entity_entry: object,
    device: object | None,
) -> bool:
    """Return whether this registry row is backed by a current Bridge state."""
    if device is None:
        return False
    device_id = str(getattr(device, "device_id", ""))
    unique_id = getattr(entity_entry, "unique_id", "")
    return any(
        entity_unique_id(device_id, state) == unique_id
        for state in getattr(device, "states", {}).values()
    )


def _generated_registry_state_name(
    entity_entry: object,
    device: object,
    state: object,
    inventory: BridgeInventory,
) -> str:
    """Return the entity-local name that current setup would suggest."""
    base = None
    for candidate in (
        getattr(entity_entry, "object_id_base", None),
        getattr(entity_entry, "original_name", None),
    ):
        if (
            isinstance(candidate, str)
            and candidate.strip()
            and not _fallback_state_name_base(candidate, device)
        ):
            base = candidate
            break
    siblings = [
        item
        for item in getattr(device, "states", {}).values()
        if getattr(item, "attribute", None) == getattr(state, "attribute", None)
    ]
    main_presence_name = (
        location_name(inventory, getattr(device, "location_id", ""))
        if getattr(state, "attribute", None) == "presence"
        and getattr(device, "location_id", None) in inventory.locations
        else None
    )
    if base is None:
        base = _readable_registry_state_attribute(state)
    base = _normalized_registry_state_name_base(
        base.strip(),
        state,
        len(siblings),
        additional_qualifiers=(
            (main_presence_name,)
            if main_presence_name is not None
            and str(getattr(state, "component_role", "")).strip().lower()
            == "main"
            else ()
        ),
    )
    names = disambiguated_state_names(
        [(item, base) for item in siblings],
        all_states=getattr(device, "states", {}).values(),
        main_presence_name=main_presence_name,
    )
    name = names.get(getattr(state, "key", ()), base)
    prefix = f"{base} ("
    if name.startswith(prefix) and name.endswith(")"):
        return f"{base} {name[len(prefix):-1]}"
    return name


def _normalized_registry_state_name_base(
    base: str,
    state: object,
    sibling_count: int,
    *,
    additional_qualifiers: Sequence[str] = (),
) -> str:
    """Remove stale role suffixes before current sibling disambiguation runs."""
    for qualifier in (*_registry_state_qualifier_names(state), *additional_qualifiers):
        qualifier_variants = list(
            dict.fromkeys(
                candidate
                for candidate in (qualifier, slugify(qualifier))
                if isinstance(candidate, str) and candidate.strip()
            )
        )
        while True:
            trimmed_base = None
            for candidate in qualifier_variants:
                for suffix in (
                    f" ({candidate})",
                    f" {candidate}",
                    f"_{candidate}",
                    f"-{candidate}",
                ):
                    if not base.casefold().endswith(suffix.casefold()):
                        continue
                    trimmed = base[: -len(suffix)].strip()
                    if trimmed:
                        trimmed_base = trimmed
                        break
                if trimmed_base is not None:
                    break
            if trimmed_base is None:
                break
            base = trimmed_base
    numeric_qualifier = _generated_numeric_qualifier(base, sibling_count)
    if numeric_qualifier is not None:
        match = re.search(r"(?:\((\d+)\)|[\s_-]+(\d+))$", base.strip())
        if match is not None:
            trimmed = base[: match.start()].strip(" _-")
            if trimmed:
                base = trimmed
    return base


def _generated_numeric_qualifier(value: str, sibling_count: int) -> int | None:
    """Return an old generated sibling number when it is in the valid range."""
    if sibling_count < 2:
        return None
    match = re.search(r"(?:\((\d+)\)|[\s_-]+(\d+))$", value.strip())
    if match is None:
        return None
    number = int(match.group(1) or match.group(2))
    return number if 1 <= number <= sibling_count else None


def _registry_state_qualifier_names(state: object) -> tuple[str, ...]:
    """Return readable role/name tokens that HA may have persisted in old bases."""
    names: list[str] = []
    for field_name in (
        "component_role",
        "capability_role",
        "component",
        "capability",
    ):
        value = getattr(state, field_name, None)
        if not isinstance(value, str):
            continue
        normalized = value.strip()
        if not normalized or normalized.lower().startswith("identifier_"):
            continue
        if field_name in {"component_role", "component"} and normalized.lower() == "main":
            continue
        normalized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", normalized)
        normalized = re.sub(r"[_-]+", " ", normalized).strip()
        if normalized and normalized not in names:
            names.append(normalized.title())
    return tuple(names)


def _fallback_state_name_base(value: str, device: object) -> bool:
    """Return whether a registry name base came from the early fallback ID."""
    device_id = getattr(device, "device_id", "")
    fallback_object_id = slugify(f"SmartThings device {device_id}") or ""
    value_object_id = slugify(value) or value.strip().lower().replace(" ", "_")
    return bool(
        fallback_object_id
        and (
            value_object_id == fallback_object_id
            or value_object_id.startswith(f"{fallback_object_id}_")
        )
    )


def _fallback_entity_suffix_name(entity_entry: object, device: object) -> str | None:
    """Return the meaningful suffix from old SmartThings-device fallback IDs."""
    device_id = getattr(device, "device_id", "")
    fallback_object_id = slugify(f"SmartThings device {device_id}") or ""
    if not fallback_object_id:
        return None
    values = [
        getattr(entity_entry, "object_id_base", None),
        getattr(entity_entry, "suggested_object_id", None),
        getattr(entity_entry, "entity_id", "").partition(".")[2],
    ]
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        object_id = slugify(value) or value.strip().lower().replace(" ", "_")
        prefix = f"{fallback_object_id}_"
        if object_id.startswith(prefix):
            suffix = object_id[len(prefix) :]
            return suffix or None
    return None


def _readable_registry_state_attribute(state: object) -> str:
    """Return a clean state attribute token for generated object IDs."""
    attribute = str(getattr(state, "attribute", "")).strip()
    return attribute or "state"


def _registry_uuid_room_slugs(
    hass: object,
    device_room_slugs: dict[str, str | None],
) -> dict[str, list[str]]:
    """Map device-registry UUIDs to their Bridge devices' room-name slugs.

    Entity registry rows reference the opaque device-registry UUID while the
    inventory keys use the Bridge's own device IDs. Both the Bridge room name
    and the user-assigned area ID are considered — SmartThings rooms may be
    written in Hangul while users historically romanized their HA area IDs
    (데이터룸 vs deiteorum), so legacy IDs may embed either form.
    """
    device_registry = dr.async_get(hass)
    if device_registry is None:
        return {}
    area_ids = set()
    try:
        from homeassistant.helpers import area_registry as arreg

        area_registry = arreg.async_get(hass)
        raw_areas = getattr(area_registry, "areas", None)
        if isinstance(raw_areas, dict):
            # Live Home Assistant stores AreaEntries keyed by their ID.
            area_entries = list(raw_areas.values())
        else:
            area_entries = list(raw_areas or ())
        for entry in area_entries:
            area_id = getattr(entry, "id", None)
            if area_id:
                area_ids.add(area_id)
    except ImportError:
        pass
    mapping: dict[str, list[str]] = {}
    raw_devices = getattr(device_registry, "devices", None)
    device_rows: list[Any] = []
    if raw_devices is not None:
        from collections.abc import Mapping as _Mapping

        if isinstance(raw_devices, _Mapping):
            device_rows = list(raw_devices.values())
        else:
            device_rows = [row for row in raw_devices if hasattr(row, "identifiers")]
    for row in device_rows:
        # Newer Home Assistant builds attach more than two elements to each
        # device identifier (e.g. a config-subentry part); only the first
        # two ever matter here.
        identifiers = getattr(row, "identifiers", None) or set()
        row_area = getattr(row, "area_id", None)
        for entry_identifier in identifiers:
            if not isinstance(entry_identifier, tuple) or len(entry_identifier) < 2:
                continue
            domain, bridge_device_id = entry_identifier[0], entry_identifier[1]
            if domain != DOMAIN:
                continue
            slugs: list[str] = []
            inventory_slug = device_room_slugs.get(bridge_device_id)
            if inventory_slug:
                slugs.append(inventory_slug)
            if row_area and row_area in area_ids and row_area not in slugs:
                slugs.append(row_area)
            if slugs and getattr(row, "id", None):
                existing = mapping.setdefault(row.id, [])
                for slug in slugs:
                    if slug not in existing:
                        existing.append(slug)
    return mapping


def _room_prefixed_generated_entity_ids(
    entity_entry: object,
    current_device_ids: set[str],
    room_slug_prefixes: list[tuple[str, str, str | None]],
    current_entity_ids: set[str],
) -> list[str]:
    """Candidate IDs repairing only a generated room-name template prefix.

    Entity IDs never regenerate on their own, so devices whose SmartThings
    name once carried the room prefix keep stale IDs like
    switch.deiteorum_status_home even after inventory names are corrected.
    A room token that belongs to the SmartThings device name itself is kept;
    for example ``작은방 재실센서`` remains
    ``jageunbang_jaesilsenseo_presence``. Older migrations that removed that
    token are repaired in the opposite direction.
    Only this integration's own entities for known devices of the configured
    location qualify and user renames are respected. When the exact target is
    already occupied (for example by another integration), the current ID is
    retained instead of rotating through numbered fallbacks.
    """
    unique_id = getattr(entity_entry, "unique_id", "")
    candidate_slugs: list[tuple[str, str | None]] = []
    direct_key = getattr(entity_entry, "device_id", None)
    for device_key, room_slug, device_name_slug in room_slug_prefixes:
        if direct_key and device_key == direct_key:
            candidate = (room_slug, device_name_slug)
            if candidate not in candidate_slugs:
                candidate_slugs.append(candidate)
        elif unique_id == device_key or unique_id.startswith(f"{device_key}_"):
            candidate = (room_slug, device_name_slug)
            if candidate not in candidate_slugs:
                candidate_slugs.append(candidate)
    # The same entity is normally resolved twice: once from its Bridge unique
    # ID (which knows the SmartThings device name) and once from the HA device
    # registry UUID (which only knows the room).  Keeping both for the same
    # room made the name-aware branch preserve/restore the legitimate room
    # token while the anonymous fallback stripped it on the next pass.  Prefer
    # the name-aware binding; retain anonymous fallbacks only for distinct
    # legacy area slugs that cannot be matched to the inventory room.
    name_aware_room_slugs = {
        room_slug
        for room_slug, device_name_slug in candidate_slugs
        if device_name_slug is not None
    }
    candidate_slugs = [
        (room_slug, device_name_slug)
        for room_slug, device_name_slug in candidate_slugs
        if device_name_slug is not None or room_slug not in name_aware_room_slugs
    ]
    if not any(
        room_slug for room_slug, _device_name_slug in candidate_slugs
    ) and not any(
        unique_id == device_id or unique_id.startswith(f"{device_id}_")
        for device_id in current_device_ids
    ):
        return []
    if getattr(entity_entry, "name", None) is not None:
        return []
    domain_part = getattr(entity_entry, "domain", "") or ""
    object_id = getattr(entity_entry, "entity_id", "").partition(".")[2]
    original_entity_id = getattr(entity_entry, "entity_id", "")
    candidates: list[str] = []
    for room_slug, device_name_slug in candidate_slugs:
        room_prefix = f"{room_slug}_"
        if room_prefix == "_":
            continue
        device_name_prefix = f"{device_name_slug}_" if device_name_slug else ""
        device_name_has_room = bool(
            device_name_slug
            and (
                device_name_slug == room_slug
                or device_name_slug.startswith(room_prefix)
            )
        )
        if device_name_has_room and (
            object_id == device_name_slug
            or object_id.startswith(device_name_prefix)
        ):
            continue
        if device_name_has_room and device_name_slug is not None:
            device_remainder = device_name_slug[len(room_prefix):]
            if device_remainder and (
                object_id == device_remainder
                or object_id.startswith(f"{device_remainder}_")
            ):
                candidates.append(f"{domain_part}.{room_slug}_{object_id}")
                continue
        if not object_id.startswith(room_prefix):
            continue
        rest = object_id[len(room_prefix):]
        if not rest:
            continue
        if device_name_has_room and device_name_slug is not None and not (
            rest == device_name_slug or rest.startswith(f"{device_name_slug}_")
        ):
            continue
        candidates.append(f"{domain_part}.{rest}")
    seen: set[str] = set()
    ordered_unique: list[str] = []
    for candidate in candidates:
        if (
            candidate != original_entity_id
            and candidate not in current_entity_ids
            and candidate not in seen
        ):
            seen.add(candidate)
            ordered_unique.append(candidate)
    return ordered_unique


def _room_named_primary_entity_ids(
    entity_entry: object,
    inventory: BridgeInventory,
    current_entity_ids: set[str],
) -> list[str]:
    """Rebase legacy type-label primary IDs onto an exact room-name slug.

    Earlier releases replaced devices named exactly like their room with a
    localized type label. Existing primary entities therefore froze as opaque
    IDs such as ``media_player.3_4``. Only automatic primary-domain rows whose
    stable unique ID proves the owning device are eligible. A legacy numeric
    collision suffix is tried first, so ``3_4`` becomes ``geosil_4`` instead
    of being renumbered to the first free candidate. Once an ID is one of the
    room-slug candidates, later migration passes leave it untouched.
    """
    if getattr(entity_entry, "name", None) is not None:
        return []
    domain = getattr(entity_entry, "domain", "") or ""
    if domain not in {"climate", "cover", "fan", "image", "media_player"}:
        return []
    unique_id = getattr(entity_entry, "unique_id", "") or ""
    device = next(
        (
            item
            for item in inventory.devices.values()
            if unique_id == f"{item.device_id}_{domain}"
        ),
        None,
    )
    room_slug = _exact_room_named_device_slug(entity_entry, inventory)
    if device is None or room_slug is None:
        return []
    original_entity_id = getattr(entity_entry, "entity_id", "")
    base = f"{domain}.{room_slug}"
    object_id = original_entity_id.partition(".")[2]
    suffix_parts = object_id.rsplit("_", 1)
    preserved_suffix = (
        int(suffix_parts[1])
        if len(suffix_parts) == 2
        and suffix_parts[1].isdigit()
        and int(suffix_parts[1]) >= 2
        else None
    )
    preferred = f"{base}_{preserved_suffix}" if preserved_suffix is not None else base
    candidates = [preferred]
    candidates.extend(
        candidate
        for candidate in [base, *(f"{base}_{index}" for index in range(2, 100))]
        if candidate != preferred
    )
    if original_entity_id in candidates:
        return []
    return [candidate for candidate in candidates if candidate not in current_entity_ids]


def _exact_room_named_device_slug(
    entity_entry: object,
    inventory: BridgeInventory,
) -> str | None:
    """Return the room slug when the entity's device uses that exact name."""
    unique_id = getattr(entity_entry, "unique_id", "") or ""
    device = next(
        (
            item
            for item in inventory.devices.values()
            if unique_id == item.device_id or unique_id.startswith(f"{item.device_id}_")
        ),
        None,
    )
    if device is None or device.room_id is None:
        return None
    room = inventory.rooms.get(device.room_id)
    if (
        room is None
        or room[0] != device.location_id
        or device.name.strip().casefold() != room[1].strip().casefold()
    ):
        return None
    return slugify(room[1].strip()) or None


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

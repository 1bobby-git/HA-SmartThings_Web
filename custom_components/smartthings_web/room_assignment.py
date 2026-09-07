"""Match verified SmartThings rooms and reconcile device areas without entity rewrites."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any, Protocol
import unicodedata


class NamedArea(Protocol):
    """Public area fields required for name matching."""

    id: str
    name: str


def room_name_key(value: str) -> str:
    """Normalize Unicode and whitespace, retaining meaningful word boundaries."""
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def matching_room_area(room_name: str, areas: Iterable[NamedArea]) -> NamedArea | None:
    """Prefer one exact area; otherwise require one normalized match.

    No substring, translated name, area-id slug, or first-match fallback is used.
    A name shared by multiple area IDs is ambiguous and must not move a device.
    """
    key = room_name_key(room_name)
    if not key:
        return None
    exact: dict[str, NamedArea] = {}
    normalized: dict[str, NamedArea] = {}
    for area in areas:
        if area.name == room_name:
            exact[area.id] = area
        if room_name_key(area.name) == key:
            normalized[area.id] = area
    candidates = exact or normalized
    return next(iter(candidates.values())) if len(candidates) == 1 else None


def repair_missing_device_area(
    device_registry: object,
    device_id: str,
    config_entry_id: str,
    area_id: str | None,
) -> bool:
    """Fill an existing unassigned device, never overwrite a user's area.

    DeviceRegistry's suggested_area applies only when a device is first created.
    Room metadata can arrive after entity/device registration, so an explicit,
    idempotent update is needed for an existing device that still has no area.
    """
    if not area_id:
        return False
    device = device_registry.async_get(device_id)
    if device is None or device.area_id is not None:
        return False
    if not _owned_device(device, config_entry_id):
        return False
    device_registry.async_update_device(device_id, area_id=area_id)
    return True


class RoomAreaRegistry(Protocol):
    """Public area registry operations used during topology registration."""

    def async_list_areas(self) -> Iterable[NamedArea]: ...

    def async_get_or_create(self, name: str) -> NamedArea: ...


def resolve_room_area(registry: RoomAreaRegistry, room_name: str) -> NamedArea | None:
    """Reuse a unique existing area, creating one only when no name matches.

    Ambiguous normalized names are not made less ambiguous by creating another
    duplicate. The caller must also verify that the room belongs to its location.
    """
    key = room_name_key(room_name)
    if not key:
        return None
    areas = tuple(registry.async_list_areas())
    matched = matching_room_area(room_name, areas)
    if matched is not None:
        return matched
    if any(room_name_key(area.name) == key for area in areas):
        return None
    return registry.async_get_or_create(" ".join(unicodedata.normalize("NFC", room_name).split()))


def sync_device_area(
    device_registry: object,
    device_id: str,
    config_entry_id: str,
    area_id: str | None,
    *,
    follow_room: bool = False,
    room_confirmed: bool = False,
) -> bool:
    """Follow a verified room only after explicit opt-in, retaining safe defaults.

    Older assignments have no reliable automatic/manual provenance. Never infer
    ownership from an area's name. Entity-level area overrides are not touched.
    A confirmed null room may clear a device area only in follow mode.
    """
    if not follow_room:
        return repair_missing_device_area(
            device_registry, device_id, config_entry_id, area_id
        )
    if not room_confirmed:
        return False
    device = device_registry.async_get(device_id)
    if device is None or device.area_id == area_id:
        return False
    if not _owned_device(device, config_entry_id):
        return False
    device_registry.async_update_device(device_id, area_id=area_id)
    return True


def _owned_device(device: object, config_entry_id: str) -> bool:
    """Refuse shared or contradictory ownership, on old and current registries."""
    owners = getattr(device, "config_entries", None)
    owner = getattr(device, "config_entry_id", None)
    if owners is not None and set(owners) != {config_entry_id}:
        return False
    if owner is not None and owner != config_entry_id:
        return False
    return owners is not None or owner == config_entry_id


def subscribe_room_registry_changes(
    hass: Any, config_entry_id: str, reconcile: Callable[[], None], invalidate: Callable[[], None],
) -> Callable[[], None]:
    """Re-evaluate areas on relevant HA edits, coalescing self-generated events.

    No network requests, polling, registry deletion, or entity-level area writes.
    Disabling/unloading cancels a scheduled callback and both event subscriptions.
    """
    bus = getattr(hass, "bus", None)
    if bus is None or not callable(getattr(bus, "async_listen", None)):
        return lambda: None
    from homeassistant.helpers import device_registry as dr

    pending = None
    active = True

    def run():
        nonlocal pending
        pending = None
        if active:
            invalidate()
            reconcile()

    async def changed(event):
        nonlocal pending
        if not active:
            return
        if event.event_type == "device_registry_updated":
            data = event.data
            changes = data.get("changes")
            if data.get("action") != "update" or not isinstance(changes, dict) or "area_id" not in changes:
                return
            device = dr.async_get(hass).async_get(data.get("device_id"))
            if device is None:
                return
            owners = set(getattr(device, "config_entries", ()))
            owner = getattr(device, "config_entry_id", None)
            if config_entry_id not in owners and owner != config_entry_id:
                return
        if pending is None:
            pending = hass.loop.call_soon(run)

    unsubscribers = [bus.async_listen(event, changed) for event in (
        "area_registry_updated", "device_registry_updated",
    )]

    def unsubscribe():
        nonlocal active, pending
        active = False
        if pending is not None:
            pending.cancel()
            pending = None
        for remove in unsubscribers:
            remove()

    return unsubscribe

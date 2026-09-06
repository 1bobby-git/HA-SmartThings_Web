"""Resolve observed Web rooms without replacing Home Assistant user assignments."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol
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
    owner = getattr(device, "config_entry_id", None)
    if owner is not None:
        if owner != config_entry_id:
            return False
    elif set(getattr(device, "config_entries", ())) != {config_entry_id}:
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

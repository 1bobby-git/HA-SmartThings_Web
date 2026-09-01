"""Stable Home Assistant names derived from SmartThings inventory."""

from __future__ import annotations

from homeassistant.util import slugify

from .models import BridgeDevice, BridgeInventory


def canonical_entity_object_id(
    inventory: BridgeInventory,
    device: BridgeDevice,
    entity_name: str | None = None,
) -> str | None:
    """Build one stable object ID from the actual SmartThings device name."""
    base = _canonical_device_slug(inventory, device)
    if not base:
        return None
    suffix = slugify(entity_name) if entity_name else ""
    if not suffix or base == suffix:
        return base
    suffix = _collapse_repeated_slug_prefix(suffix, base)
    if suffix.startswith(f"{base}_"):
        return suffix
    if base.endswith(f"_{suffix}"):
        return base
    return f"{base}_{suffix}"


def canonical_primary_control_object_id(
    inventory: BridgeInventory,
    device: BridgeDevice,
) -> str | None:
    """Return the stable room-free ID shared by a device's main control.

    SmartThings device names often repeat the assigned room (for example
    ``화장실 환풍기`` in room ``화장실``).  Home Assistant may represent the
    same physical power control as a switch today and a fan tomorrow, so the
    main control must keep the device's own base name rather than inheriting a
    room prefix or a platform suffix.
    """
    device_name = device.name.strip()
    if device.room_id:
        room = inventory.rooms.get(device.room_id)
        if room is not None and room[0] == device.location_id:
            room_name = room[1].strip()
            has_room_prefix = (
                bool(room_name)
                and device_name.casefold().startswith(room_name.casefold())
                and len(device_name) > len(room_name)
                and device_name[len(room_name)] in " _-"
            )
            if has_room_prefix:
                remainder = device_name[len(room_name) :].strip(" _-")
                remainder_slug = slugify(remainder)
                if remainder_slug:
                    return remainder_slug
    return slugify(device_name) or None


def _canonical_device_slug(
    inventory: BridgeInventory,
    device: BridgeDevice,
) -> str | None:
    """Return the device-name slug with a matching room token at most once."""
    device_name = device.name.strip()
    device_slug = slugify(device_name)
    if not device.room_id:
        return device_slug or None
    room = inventory.rooms.get(device.room_id)
    if room is None or room[0] != device.location_id:
        return device_slug or None
    room_name = room[1].strip()
    room_slug = slugify(room_name)
    if not room_name or not room_slug:
        return device_slug or None
    if device_name.casefold() == room_name.casefold():
        return room_slug
    if device_name.casefold().startswith(room_name.casefold()):
        remainder = device_name[len(room_name):].strip(" _-")
        remainder_slug = slugify(remainder)
        if remainder_slug:
            return f"{room_slug}_{remainder_slug}"
    duplicate_prefix = f"{room_slug}_{room_slug}_"
    if device_slug.startswith(duplicate_prefix):
        return f"{room_slug}_{device_slug[len(duplicate_prefix):]}"
    return device_slug or None


def _collapse_repeated_slug_prefix(value: str, prefix: str) -> str:
    """Collapse generated ``device_device_suffix`` feedback loops."""
    duplicate_prefix = f"{prefix}_{prefix}_"
    while value.startswith(duplicate_prefix):
        value = value[len(prefix) + 1 :]
    return value

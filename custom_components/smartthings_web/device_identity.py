"""Strong identity canonicalization for proven SmartThings device mirrors."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime

from .models import (
    BridgeAdvancedDeviceMetadata,
    BridgeDevice,
    BridgeState,
)


@dataclass(frozen=True)
class CanonicalizedDevices:
    """Canonical inventory devices and hidden-source aliases."""

    devices: dict[str, BridgeDevice]
    aliases: dict[str, str]


def canonicalize_duplicate_devices(
    devices: dict[str, BridgeDevice],
) -> CanonicalizedDevices:
    """Merge only an unambiguous same-owner Cloud/Local child pair."""
    result = deepcopy(devices)
    aliases: dict[str, str] = {}
    groups: dict[
        tuple[str, str | None, str, str | None, str], list[BridgeDevice]
    ] = {}
    for device in devices.values():
        metadata = device.advanced
        owner_id = getattr(metadata, "owner_id", None)
        if not isinstance(owner_id, str) or not owner_id:
            continue
        key = (
            device.location_id,
            device.room_id,
            " ".join(device.name.casefold().split()),
            device.device_type.casefold() if device.device_type else None,
            owner_id,
        )
        groups.setdefault(key, []).append(device)

    for candidates in groups.values():
        pair = _strong_cloud_local_pair(candidates)
        if pair is None:
            continue
        cloud, local = pair
        result[cloud.device_id] = _merge_pair(cloud, local)
        result.pop(local.device_id, None)
        aliases[local.device_id] = cloud.device_id

    return CanonicalizedDevices(result, aliases)


def _strong_cloud_local_pair(
    candidates: list[BridgeDevice],
) -> tuple[BridgeDevice, BridgeDevice] | None:
    if len(candidates) != 2:
        return None
    cloud = next(
        (
            device
            for device in candidates
            if getattr(device.advanced, "execution_context", None) == "CLOUD"
        ),
        None,
    )
    local = next(
        (
            device
            for device in candidates
            if getattr(device.advanced, "execution_context", None) == "LOCAL"
        ),
        None,
    )
    if cloud is None or local is None or cloud is local:
        return None
    if not getattr(local.advanced, "parent_device_id", None):
        return None
    cloud_signature = _state_signature(cloud)
    local_signature = _state_signature(local)
    overlap = cloud_signature & local_signature
    required = {"switch", "level", "hue", "saturation"}
    if not required.issubset(overlap):
        return None
    if not set(local.controls).issubset(cloud.controls):
        return None
    return cloud, local


def _state_signature(device: BridgeDevice) -> set[str]:
    return {
        state.attribute
        for state in device.states.values()
        if (state.component_role or "").strip().lower() == "main"
    }


def _merge_pair(cloud: BridgeDevice, local: BridgeDevice) -> BridgeDevice:
    merged = deepcopy(cloud)
    for key, candidate in local.states.items():
        current = merged.states.get(key)
        if current is None or _state_is_newer(candidate, current):
            merged.states[key] = deepcopy(candidate)
    merged.online = cloud.online or local.online
    merged.health_updated_at = _newer_timestamp_value(
        cloud.health_updated_at,
        local.health_updated_at,
    )
    cloud_metadata = cloud.advanced
    local_metadata = local.advanced
    linked = {
        *getattr(cloud_metadata, "linked_device_ids", ()),
        *getattr(local_metadata, "linked_device_ids", ()),
        local.device_id,
    }
    merged.advanced = BridgeAdvancedDeviceMetadata(
        owner_id=getattr(cloud_metadata, "owner_id", None),
        parent_device_id=getattr(local_metadata, "parent_device_id", None),
        execution_context=getattr(cloud_metadata, "execution_context", None),
        linked_device_ids=tuple(sorted(linked)),
    )
    return merged


def _state_is_newer(candidate: BridgeState, current: BridgeState) -> bool:
    candidate_time = _timestamp(candidate.updated_at)
    current_time = _timestamp(current.updated_at)
    if candidate_time is None:
        return False
    return current_time is None or candidate_time > current_time


def _newer_timestamp_value(left: str | None, right: str | None) -> str | None:
    left_time = _timestamp(left)
    right_time = _timestamp(right)
    if right_time is not None and (left_time is None or right_time > left_time):
        return right
    return left


def _timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

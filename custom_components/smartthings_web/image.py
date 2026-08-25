"""Camera image entities for SmartThings Web."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError
from .entity import SmartThingsWebDeviceEntity
from .models import BridgeDevice, SmartThingsWebRuntime, is_image_device


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create image entities for camera-like devices."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id or not is_image_device(device):
                continue
            if device.device_id in known:
                continue
            known.add(device.device_id)
            entities.append(SmartThingsWebImage(hass, runtime, device))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebImage(SmartThingsWebDeviceEntity, ImageEntity):
    """Latest SmartThings camera still metadata."""

    def __init__(
        self, hass: HomeAssistant, runtime: SmartThingsWebRuntime, device: BridgeDevice
    ) -> None:
        ImageEntity.__init__(self, hass)
        SmartThingsWebDeviceEntity.__init__(self, runtime, device, "image", "Image")
        self._last_image_updated = self.image_last_updated

    @property
    def image_last_updated(self) -> datetime | None:
        """Return the latest image-related update timestamp."""
        device = self.bridge_device
        if device is None:
            return None
        timestamps = [
            _parse_time(state.updated_at)
            for state in device.states.values()
            if state.attribute in {"captureTime", "clip", "image", "imageTransferProgress", "stream"}
            and state.updated_at is not None
        ]
        return max((timestamp for timestamp in timestamps if timestamp is not None), default=None)

    async def async_image(self) -> bytes | None:
        """Return the latest authenticated still if the Bridge can provide bytes."""
        try:
            data, content_type = await self.runtime.client.async_get_image(self.device_id)
        except BridgeClientError:
            return None
        if content_type:
            self._attr_content_type = content_type
        return data

    async def async_added_to_hass(self) -> None:
        """Rotate the image URL token whenever pushed image metadata changes."""
        def handle_update() -> None:
            current = self.image_last_updated
            if current == self._last_image_updated:
                return
            self._last_image_updated = current
            self.async_update_token()
            self.async_write_ha_state()

        self.async_on_remove(self.runtime.subscribe(handle_update))


def _parse_time(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None

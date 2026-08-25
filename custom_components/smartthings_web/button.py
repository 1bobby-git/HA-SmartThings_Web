"""Device action buttons for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError
from .entity import SmartThingsWebDeviceEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    SmartThingsWebRuntime,
    button_controls,
    control_label,
    is_refreshable_device,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create refresh buttons and discover newly capable devices."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            controls = button_controls(device)
            if controls:
                for control in controls:
                    unique_id = f"{device.device_id}_button_{control.control_id}"
                    if unique_id in known:
                        continue
                    known.add(unique_id)
                    entities.append(SmartThingsWebRefreshButton(runtime, device, control))
                continue
            if not is_refreshable_device(device):
                continue
            unique_id = f"{device.device_id}_refresh"
            if unique_id not in known:
                known.add(unique_id)
                entities.append(SmartThingsWebRefreshButton(runtime, device, None))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebRefreshButton(SmartThingsWebDeviceEntity, ButtonEntity):
    """Run one observed device action through SmartThings Web."""

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        control: BridgeControl | None,
    ) -> None:
        self.control = control
        suffix = f"button_{control.control_id}" if control else "refresh"
        super().__init__(
            runtime,
            device,
            suffix,
            control_label(control, "Refresh") if control else "Refresh",
        )

    async def async_press(self) -> None:
        """Request a device action without optimistic state mutation."""
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                control_id=self.control.control_id if self.control else None,
                control_label=self.control.label if self.control else None,
                component=self.control.component if self.control else None,
                capability=self.control.capability if self.control else None,
                attribute=self.control.attribute if self.control else None,
                command="press" if self.control else "refresh",
                arguments=[],
            )
        except BridgeClientError as err:
            raise HomeAssistantError("SmartThings Web did not confirm the button action") from err

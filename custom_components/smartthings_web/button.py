"""Device action buttons for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebDeviceEntity, suggested_entity_object_id
from .models import (
    BridgeControl,
    BridgeDevice,
    SmartThingsWebRuntime,
    button_controls,
    control_label,
    refresh_controls,
    safe_observed_control,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create only buttons observed in SmartThings Web device details."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            controls = button_controls(device)
            if controls:
                actual_refresh_ids = {
                    control.control_id for control in refresh_controls(device)
                }
                for control in controls:
                    if _mentions_refresh(control) and control.control_id not in actual_refresh_ids:
                        continue
                    unique_id = f"{device.device_id}_button_{control.control_id}"
                    if unique_id in known:
                        continue
                    known.add(unique_id)
                    entities.append(SmartThingsWebButton(runtime, device, control))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


def _mentions_refresh(control: BridgeControl) -> bool:
    """Return whether a button control text indicates a refresh action."""
    haystack = " ".join(
        item
        for item in (
            control.control_id,
            control.label,
            control.attribute or "",
            *control.commands,
        )
        if item
    ).lower()
    return "refresh" in haystack


class SmartThingsWebButton(SmartThingsWebDeviceEntity, ButtonEntity):
    """Run one observed device action through SmartThings Web."""

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        control: BridgeControl,
    ) -> None:
        self.control = control
        suffix = f"button_{control.control_id}"
        refresh = any(
            candidate.control_id == control.control_id
            for candidate in refresh_controls(device)
        )
        super().__init__(
            runtime,
            device,
            suffix,
            None if refresh else control_label(control, "Button"),
        )
        if refresh:
            self._attr_translation_key = "refresh"
            self._attr_entity_picture = None
            self._attr_icon = "mdi:refresh"
            self._attr_entity_category = EntityCategory.CONFIG
            self._attr_suggested_object_id = suggested_entity_object_id(
                runtime, device, "refresh"
            )
            if self._attr_suggested_object_id is not None:
                self.entity_id = f"button.{self._attr_suggested_object_id}"

    @property
    def available(self) -> bool:
        """Stay available only while the exact observed button still exists."""
        device = self.bridge_device
        control = (
            device.controls.get(self.control.control_id) if device is not None else None
        )
        return (
            super().available
            and control is not None
            and control.kind == "button"
            and safe_observed_control(control)
        )

    async def async_press(self) -> None:
        """Request a device action without optimistic state mutation."""
        device = self.bridge_device
        control = (
            device.controls.get(self.control.control_id) if device is not None else None
        )
        if (
            control is None
            or control.kind != "button"
            or not safe_observed_control(control)
        ):
            raise HomeAssistantError("SmartThings Web button control is unavailable")
        try:
            command = (
                "refresh"
                if any(
                    candidate.control_id == control.control_id
                    for candidate in refresh_controls(device)
                )
                else "press"
            )
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                control_id=control.control_id,
                control_label=control.label,
                component=control.component,
                capability=control.capability,
                attribute=control.attribute,
                command=command,
                arguments=[],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("button command", err)) from err

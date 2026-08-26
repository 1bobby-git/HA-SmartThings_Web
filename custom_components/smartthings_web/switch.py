"""Safe switch controls for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    control_kind,
    safe_observed_control,
    safe_generic_toggle_control,
    toggle_control_for_state,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create verified safe switch controls and discover new ones from inventory pushes."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            for state in device.states.values():
                unique_id = "_".join((device.device_id, *state.key))
                control = toggle_control_for_state(device, state)
                primary_switch = control_kind(device, state) == "switch"
                generic_toggle = (
                    control is not None
                    and state.attribute not in {"switch", "mute", "windowShade"}
                    and safe_generic_toggle_control(control)
                )
                if (
                    control is not None
                    and safe_observed_control(control)
                    and (primary_switch or generic_toggle)
                    and unique_id not in known
                ):
                    known.add(unique_id)
                    entities.append(
                        SmartThingsWebSwitch(runtime, device, state, control)
                    )
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebSwitch(SmartThingsWebEntity, SwitchEntity):
    """One switch confirmed only by the SmartThings push stream."""

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState,
        control: BridgeControl | None = None,
    ) -> None:
        self.control = control
        super().__init__(
            runtime,
            device,
            state,
            control.label if control is not None and state.attribute != "switch" else None,
        )

    @property
    def available(self) -> bool:
        """Stay available only while the exact safe toggle still exists."""
        device = self.runtime.inventory.devices.get(self.device_id)
        state = device.states.get(self.state_key) if device is not None else None
        control = (
            toggle_control_for_state(device, state)
            if device is not None and state is not None
            else None
        )
        return (
            super().available
            and control is not None
            and safe_observed_control(control)
        )

    @property
    def is_on(self) -> bool | None:
        """Return the last pushed switch state."""
        state = self.bridge_state
        if state is None:
            return None
        if isinstance(state.value, bool):
            return state.value
        return str(state.value).strip().lower() in {"on", "enabled", "true", "active"}

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Preserve the exact pushed toggle value on the primary switch entity."""
        state = self.bridge_state
        return {"smartthings_raw_value": state.value} if state is not None else {}

    async def async_turn_on(self, **kwargs: object) -> None:
        """Request ON and wait for the Bridge's push confirmation."""
        await self._async_command("on")

    async def async_turn_off(self, **kwargs: object) -> None:
        """Request OFF and wait for the Bridge's push confirmation."""
        await self._async_command("off")

    async def _async_command(self, command: str) -> None:
        device = self.runtime.inventory.devices.get(self.device_id)
        state = device.states.get(self.state_key) if device is not None else None
        control = (
            toggle_control_for_state(device, state)
            if device is not None and state is not None
            else None
        )
        if control is None or not safe_observed_control(control):
            raise HomeAssistantError("SmartThings Web switch has no observed toggle control")
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=self.state_key[0],
                capability=self.state_key[1],
                attribute=self.state_key[2],
                control_id=control.control_id,
                control_label=control.label,
                command=command,
                arguments=[],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("switch command", err)) from err

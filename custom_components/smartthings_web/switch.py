"""Safe switch controls for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebEntity, migrate_entity_original_name
from .models import (
    BridgeControl,
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    control_supports_command,
    control_kind,
    primary_switch_state,
    safe_observed_control,
    safe_generic_toggle_control,
    switch_name_overrides,
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
            name_overrides = switch_name_overrides(device)
            for state in device.states.values():
                unique_id = "_".join((device.device_id, *state.key))
                control = toggle_control_for_state(device, state)
                primary_switch = control_kind(device, state) == "switch"
                generic_toggle = (
                    control is not None
                    and state.attribute not in {"switch", "mute", "windowShade"}
                    and safe_generic_toggle_control(control)
                )
                if (primary_switch or generic_toggle) and unique_id not in known:
                    observed_control = (
                        control
                        if control is not None and safe_observed_control(control)
                        else None
                    )
                    name_override = name_overrides.get(state.key)
                    migrate_entity_original_name(
                        hass,
                        "switch",
                        unique_id,
                        name_override,
                    )
                    known.add(unique_id)
                    entities.append(
                        SmartThingsWebSwitch(
                            runtime,
                            device,
                            state,
                            observed_control,
                            name_override=name_override,
                        )
                    )
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebSwitch(SmartThingsWebEntity, SwitchEntity):
    """One switch driven by observed SmartThings state with bounded command confirmation."""

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState,
        control: BridgeControl | None = None,
        name_override: str | None = None,
    ) -> None:
        self.control = control
        self._pending_target: bool | None = None
        self._pending_state_marker: tuple[object, str | None, bool] | None = None
        is_primary_control = primary_switch_state(device, state)
        name = (
            name_override
            if name_override is not None
            else control.label
            if control is not None and state.attribute != "switch"
            else None
        )
        super().__init__(
            runtime,
            device,
            state,
            name,
            primary_control=is_primary_control,
        )

    @property
    def available(self) -> bool:
        """Expose pushed switch state even when its write control is absent."""
        device = self.runtime.inventory.devices.get(self.device_id)
        state = device.states.get(self.state_key) if device is not None else None
        if (
            device is not None
            and state is not None
            and control_kind(device, state) == "switch"
        ):
            return super().available
        control = (
            toggle_control_for_state(device, state)
            if device is not None and state is not None
            else None
        )
        return (
            super().available
            and control is not None
            and safe_observed_control(control)
            and safe_generic_toggle_control(control)
        )

    @staticmethod
    def _state_marker(state: BridgeState | None) -> tuple[object, str | None, bool] | None:
        """Return the observed fields that distinguish a newer switch state."""
        if state is None:
            return None
        return (state.value, state.updated_at, state.command_read_verified)

    def _pending_waits_for_observation(self, state: BridgeState | None) -> bool:
        """Keep an accepted command pending only while HA still has the old observation."""
        if self._pending_target is None:
            return False
        if self._state_marker(state) == self._pending_state_marker:
            return True
        self._pending_target = None
        self._pending_state_marker = None
        return False

    def _write_pending_state(self) -> None:
        """Refresh HA immediately when command certainty changes."""
        writer = getattr(self, "async_write_ha_state", None)
        if callable(writer):
            writer()

    @property
    def is_on(self) -> bool | None:
        """Return observed switch state, or unknown while a newer command is pending."""
        state = self.bridge_state
        if self._pending_waits_for_observation(state):
            return None
        if state is None:
            return None
        if isinstance(state.value, bool):
            return state.value
        return str(state.value).strip().lower() in {"on", "enabled", "true", "active"}

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Expose raw observed state and bounded pending-command diagnostics."""
        state = self.bridge_state
        attributes = (
            {"smartthings_raw_value": state.value} if state is not None else {}
        )
        if self._pending_waits_for_observation(state):
            attributes["smartthings_command_pending"] = True
            attributes["smartthings_pending_target"] = (
                "on" if self._pending_target else "off"
            )
        return attributes

    async def async_turn_on(self, **kwargs: object) -> None:
        """Request ON; the Bridge returns after confirmation or a bounded accepted receipt."""
        await self._async_command("on")

    async def async_turn_off(self, **kwargs: object) -> None:
        """Request OFF; the Bridge returns after confirmation or a bounded accepted receipt."""
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
        if control.commands and not control_supports_command(control, command):
            current_is_on = self.is_on
            if current_is_on is (command == "on"):
                return
            raise HomeAssistantError(
                "SmartThings Web switch has not observed the requested toggle command"
            )
        self._pending_target = command == "on"
        self._pending_state_marker = self._state_marker(state)
        self._write_pending_state()
        try:
            result = await self.runtime.client.async_execute_command(
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
            self._pending_target = None
            self._pending_state_marker = None
            self._write_pending_state()
            raise HomeAssistantError(bridge_error_message("switch command", err)) from err

        status = getattr(result, "status", None)
        if status not in {"accepted_unconfirmed", "confirmed"}:
            self._pending_target = None
            self._pending_state_marker = None
        else:
            self._pending_waits_for_observation(self.bridge_state)
        self._write_pending_state()

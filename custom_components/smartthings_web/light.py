"""Fail-closed light controls for SmartThings Web."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
import logging

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_HS_COLOR,
    ColorMode,
    LightEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebEntity
from .models import (
    BridgeCommandResult,
    BridgeDevice,
    BridgeState,
    LightScalarControl,
    SmartThingsWebRuntime,
    control_kind,
    finite_number,
    light_scalar_control,
    light_scalar_command,
    light_color_command,
    light_state,
    primary_state_attributes,
    safe_observed_control,
    toggle_control_for_state,
)


_LOGGER = logging.getLogger(__name__)
_COMMAND_QUEUE_TIMEOUT = 10
_STATE_CATCHUP_TIMEOUT = 3


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create only lights with light-specific state evidence."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            for state in device.states.values():
                unique_id = "_".join((device.device_id, *state.key))
                if (
                    control_kind(device, state) == "light"
                    and (toggle := toggle_control_for_state(device, state)) is not None
                    and safe_observed_control(toggle)
                    and unique_id not in known
                ):
                    known.add(unique_id)
                    entities.append(SmartThingsWebLight(runtime, device, state))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebLight(SmartThingsWebEntity, LightEntity):
    """One light whose commands are confirmed by a newer push event."""

    def __init__(
        self, runtime: SmartThingsWebRuntime, device: BridgeDevice, state: BridgeState
    ) -> None:
        primary_role = (state.component_role or state.component).strip().lower()
        light_states = [
            candidate
            for candidate in device.states.values()
            if control_kind(device, candidate) == "light"
        ]
        super().__init__(
            runtime,
            device,
            state,
            None,
            primary_control=primary_role == "main" or len(light_states) == 1,
        )
        self._command_lock = asyncio.Lock()
        self._confirmed_color_mode: ColorMode | None = None

    def _control(self, attribute: str) -> LightScalarControl | None:
        return light_scalar_control(self.bridge_device, self.state_key[0], attribute)

    def _state(self, attribute: str) -> BridgeState | None:
        control = self._control(attribute)
        if control is not None:
            return control.state
        return light_state(self.bridge_device, self.state_key[0], attribute)

    @property
    def supported_color_modes(self) -> set[ColorMode]:
        """Reevaluate late Web/catalog discovery without replacing the entity."""
        modes = set()
        level = self._control("level")
        if level is not None:
            if self._control("colorTemperature") is not None:
                modes.add(ColorMode.COLOR_TEMP)
            hue, saturation = self._control("hue"), self._control("saturation")
            if (hue and saturation and hue.state.capability == saturation.state.capability) or (
                self.runtime.inventory.light_plan_supported
                and light_color_command(self.bridge_device, self.state_key[0]) is not None
            ):
                modes.add(ColorMode.HS)
        return modes or {ColorMode.BRIGHTNESS if level else ColorMode.ONOFF}

    @property
    def color_mode(self) -> ColorMode:
        """Use reported mode/timestamps; never infer the current color from a request."""
        modes = self.supported_color_modes
        if len(modes) == 1:
            return next(iter(modes))
        explicit = self._state("colorMode")
        if explicit is not None:
            token = str(explicit.value).lower().replace("_", "")
            mode = {"color": ColorMode.HS, "hs": ColorMode.HS, "rgb": ColorMode.HS,
                    "colortemperature": ColorMode.COLOR_TEMP, "temperature": ColorMode.COLOR_TEMP,
                    "ct": ColorMode.COLOR_TEMP}.get(token)
            if mode in modes:
                return mode
        color_at = max(_updated_at(self._state("hue")), _updated_at(self._state("saturation")))
        temperature_at = _updated_at(self._state("colorTemperature"))
        if color_at > temperature_at:
            return ColorMode.HS
        if temperature_at > color_at:
            return ColorMode.COLOR_TEMP
        return self._confirmed_color_mode if self._confirmed_color_mode in modes else ColorMode.COLOR_TEMP

    @property
    def min_color_temp_kelvin(self) -> int:
        control = self._control("colorTemperature")
        return int(control.minimum) if control else 1500

    @property
    def max_color_temp_kelvin(self) -> int:
        control = self._control("colorTemperature")
        return int(control.maximum) if control else 9000

    async def async_added_to_hass(self) -> None:
        """A light depends on multiple states and catalog/control metadata."""
        self.async_on_remove(
            self.runtime.subscribe_device(self.device_id, self.async_write_ha_state)
        )

    @property
    def available(self) -> bool:
        """Stay available only while the exact safe power toggle still exists."""
        device = self.bridge_device
        state = device.states.get(self.state_key) if device is not None else None
        control = (
            toggle_control_for_state(device, state)
            if device is not None and state is not None
            else None
        )
        return (
            super().available
            and device is not None
            and device.location_id == getattr(self.runtime, "location_id", device.location_id)
            and control is not None
            and safe_observed_control(control)
            and control_kind(device, state) == "light"
        )

    @property
    def is_on(self) -> bool | None:
        """Return the last pushed switch state."""
        state = self.bridge_state
        if state is None:
            return None
        return str(state.value).lower() == "on"

    @property
    def brightness(self) -> int | None:
        """Convert the actual 0..100 level to HA's 0..255 scale."""
        value = _number(self._state("level"), 0, 100)
        return round(value * 255 / 100) if value is not None else None

    @property
    def color_temp_kelvin(self) -> int | None:
        value = _number(self._state("colorTemperature"), 1, 100000)
        return round(value) if value is not None else None

    @property
    def hs_color(self) -> tuple[float, float] | None:
        """SmartThings hue is 0..100; HA hue is 0..360 degrees."""
        hue_state, saturation_state = self._state("hue"), self._state("saturation")
        if not hue_state or not saturation_state or hue_state.capability != saturation_state.capability:
            return None
        hue, saturation = _number(hue_state, 0, 100), _number(saturation_state, 0, 100)
        if hue is None or saturation is None:
            return None
        return round(hue * 3.6, 4), saturation

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Preserve pushed light metadata not represented by core light fields."""
        device = self.bridge_device
        if device is None:
            return {}
        attributes = {
            "colorMode",
            "colorTemperature",
            "colorTemperatureRange",
            "hue",
            "level",
            "levelRange",
            "saturation",
            "switch",
            "supportedColorModes",
        }
        return primary_state_attributes(
            device,
            attributes,
            component=self.state_key[0],
        )

    async def async_turn_on(self, **kwargs: object) -> None:
        """Validate all requested features before dispatch; keep pushed values intact."""
        async with _command_slot(self._command_lock):
            plan: list[tuple[str, int | float]] = []
            mode = None
            if ATTR_BRIGHTNESS in kwargs:
                value = _input_number(kwargs[ATTR_BRIGHTNESS], 0, 255)
                if value == 0:
                    result = None
                    try:
                        result = await self._async_command("off")
                    finally:
                        await self._async_catch_up_state(result, {"switch": "off"})
                    return
                # HA brightness 1 must not round to a native OFF level of zero.
                plan.append(("level", max(1, round(value * 100 / 255))))
            if ATTR_COLOR_TEMP_KELVIN in kwargs:
                value = _input_number(kwargs[ATTR_COLOR_TEMP_KELVIN], self.min_color_temp_kelvin,
                                      self.max_color_temp_kelvin)
                plan.append(("colorTemperature", round(value)))
                mode = ColorMode.COLOR_TEMP
            if ATTR_HS_COLOR in kwargs:
                hs = kwargs[ATTR_HS_COLOR]
                if (not isinstance(hs, (tuple, list)) or len(hs) != 2
                        or ATTR_COLOR_TEMP_KELVIN in kwargs):
                    raise HomeAssistantError("SmartThings Web light received an invalid color")
                hue, saturation = _input_number(hs[0], 0, 360), _input_number(hs[1], 0, 100)
                if ColorMode.HS not in self.supported_color_modes:
                    raise HomeAssistantError("SmartThings Web light has no verified color control")
                plan.extend((("hue", hue * 100 / 360), ("saturation", saturation)))
                mode = ColorMode.HS
            batch = self._verified_plan(plan) if plan else None
            for attribute, value in plan:
                if batch is None and self._control(attribute) is None:
                    raise HomeAssistantError(f"SmartThings Web light has no verified {attribute} control")
            result = None
            expected: dict[str, object] = {"switch": "on", **dict(plan)}
            try:
                if batch is not None:
                    result = await self._async_apply_plan(batch)
                else:
                    result = await self._async_command("on")
                    for attribute, value in plan:
                        # A failure must still catch up even after an earlier confirmed step.
                        result = None
                        result = await self._async_set_number(attribute, value)
                if mode is not None:
                    # A fallback mode hint only after confirmed commands, never a color value.
                    self._confirmed_color_mode = mode
                    if getattr(self, "hass", None) is not None:
                        self.async_write_ha_state()
            finally:
                await self._async_catch_up_state(result, expected)

    def _verified_plan(self, values: list[tuple[str, int | float]]) -> list[dict[str, object]] | None:
        """Use the advertised batch feature only with exact current catalog contracts."""
        device = self.bridge_device
        if not self.runtime.inventory.light_plan_supported or device is None:
            return None
        component, capability, _ = self.state_key
        power = [command for command in device.commands
                 if (command.component, command.capability, command.command) == (component, capability, "on")]
        if (len(power) != 1 or power[0].arguments or power[0].confirmation != "state"
                or any(item.component == component and item.capability == capability
                       and item.command in (None, "on") for item in device.command_omissions)):
            return None
        payload: list[dict[str, object]] = [
            {"attribute": "switch", "capability": capability, "command": "on", "arguments": []}]
        requested = dict(values)
        color = light_color_command(device, component) if "hue" in requested else None
        for attribute, value in values:
            if color is not None and attribute in {"hue", "saturation"}:
                if attribute == "saturation":
                    continue
                numbers = {}
                properties = color.arguments[0].schema["properties"]
                for name in ("hue", "saturation"):
                    schema = properties[name]
                    number = _input_number(requested[name], schema["minimum"], schema["maximum"])
                    numbers[name] = round(number) if schema["type"] == "integer" else round(number, 4)
                payload.append({"attribute": "color", "capability": color.capability,
                                "command": "setColor", "arguments": [numbers]})
                continue
            state = light_state(device, component, attribute)
            descriptor = light_scalar_command(device, state) if state is not None else None
            binding = self._control(attribute)
            if descriptor is None or binding is None:
                return None
            converted = binding.convert(value)
            schema = descriptor.arguments[0].schema
            # Web range and current Advanced range must both be satisfied.
            _input_number(converted, schema.get("minimum", binding.minimum), schema.get("maximum", binding.maximum))
            if schema["type"] == "integer" and int(converted) != converted:
                return None
            payload.append({"attribute": attribute, "capability": descriptor.capability,
                            "command": descriptor.command, "arguments": [converted]})
        return payload

    async def _async_apply_plan(self, payload: list[dict[str, object]]) -> BridgeCommandResult:
        """One POST, then one joint confirmation: hue cannot block saturation/brightness."""
        if not self.available:
            raise HomeAssistantError("SmartThings Web light has no observed power control")
        try:
            return await self.runtime.client.async_execute_command(
                target_type="device", target_id=self.device_id,
                component=self.state_key[0], capability=self.state_key[1], attribute="switch",
                command="applyLight", arguments=payload, require_advanced=True, confirm=True,
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("light plan command", err)) from err

    async def async_turn_off(self, **kwargs: object) -> None:
        async with _command_slot(self._command_lock):
            result = None
            try:
                result = await self._async_command("off")
            finally:
                await self._async_catch_up_state(result, {"switch": "off"})

    async def _async_catch_up_state(
        self, result: BridgeCommandResult | None = None,
        expected: dict[str, object] | None = None,
    ) -> None:
        """Read the Bridge once after a plan, even if a later step failed.

        This catches up a lagging SSE stream without changing request/receipt
        values into state or masking the original command failure.
        """
        sequence = getattr(result, "sequence", None)
        if (getattr(result, "status", None) in {"confirmed", "already_confirmed"}
                and isinstance(sequence, int) and not isinstance(sequence, bool)
                and self.runtime.inventory.sequence >= sequence
                and expected and all(self._matches_observed(key, value) for key, value in expected.items()
                                     if key != "hue" or expected.get("saturation") != 0)):
            return
        try:
            async with asyncio.timeout(_STATE_CATCHUP_TIMEOUT):
                inventory = await self.runtime.client.async_get_inventory()
                self.runtime.apply_inventory(inventory)
        except (BridgeClientError, TimeoutError):
            _LOGGER.debug("SmartThings Web light state catch-up unavailable; waiting for events")

    def _matches_observed(self, attribute: str, expected: object) -> bool:
        """A caught-up push, not a requested value, permits skipping a full GET."""
        state = self.bridge_state if attribute == "switch" else self._state(attribute)
        if state is None:
            return False
        actual = state.value
        if attribute == "switch":
            return isinstance(actual, str) and actual.strip().lower() == expected
        if not finite_number(actual) or not finite_number(expected):
            return False
        if attribute == "colorTemperature":
            return 1 <= actual <= 30000 and expected > 0 and abs(1e6 / actual - 1e6 / expected) <= 1
        if not 0 <= actual <= 100:
            return False
        distance = abs(actual - expected)
        return (min(distance, 100 - distance) if attribute == "hue" else distance) <= 0.5

    async def _async_command(self, command: str) -> BridgeCommandResult:
        device = self.bridge_device
        state = device.states.get(self.state_key) if device is not None else None
        control = (
            toggle_control_for_state(device, state)
            if device is not None and state is not None
            else None
        )
        if (
            not self.available
            or control is None
            or not safe_observed_control(control)
            or control_kind(device, state) != "light"
        ):
            raise HomeAssistantError("SmartThings Web light has no observed power control")
        try:
            return await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component,
                capability=control.capability,
                attribute=control.attribute,
                control_id=control.control_id,
                control_label=control.label,
                command=command,
                arguments=[],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message(f"light {command} command", err)) from err

    async def _async_set_number(self, attribute: str, value: int | float) -> BridgeCommandResult | None:
        binding = self._control(attribute)
        if not self.available or binding is None:
            raise HomeAssistantError(f"SmartThings Web light has no verified {attribute} control")
        value = binding.convert(value)
        try:
            if binding.descriptor is not None:
                descriptor = binding.descriptor
                return await self.runtime.client.async_execute_command(
                    target_type="device", target_id=self.device_id,
                    component=descriptor.component, capability=descriptor.capability,
                    attribute=attribute, command=descriptor.command, arguments=[value],
                    require_advanced=True, confirm=True,
                )
            elif binding.control is not None:
                control = binding.control
                return await self.runtime.client.async_execute_command(
                    target_type="device", target_id=self.device_id,
                    component=control.component, capability=control.capability,
                    attribute=control.attribute, control_id=control.control_id,
                    control_label=control.label, command="setNumber", arguments=[value],
                )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message(f"light {attribute} command", err)) from err


def _number(state: BridgeState | None, minimum: float, maximum: float) -> float | None:
    if state is None or not finite_number(state.value) or not minimum <= state.value <= maximum:
        return None
    return float(state.value)


def _input_number(value: object, minimum: float, maximum: float) -> float:
    if not finite_number(value) or not minimum <= value <= maximum:
        raise HomeAssistantError("SmartThings Web light value is outside its supported range")
    return float(value)


def _updated_at(state: BridgeState | None) -> float:
    if state is None or not state.updated_at:
        return 0
    try:
        return datetime.fromisoformat(state.updated_at.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0


@asynccontextmanager
async def _command_slot(lock: asyncio.Lock) -> AsyncIterator[None]:
    """Reject queued stale UI requests, but never interrupt a dispatched command."""
    try:
        async with asyncio.timeout(_COMMAND_QUEUE_TIMEOUT):
            await lock.acquire()
    except TimeoutError as err:
        raise HomeAssistantError("SmartThings Web light command failed: command_queue_timeout") from err
    try:
        yield
    finally:
        lock.release()

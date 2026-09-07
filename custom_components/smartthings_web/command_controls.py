"""Command-only controls from the observed Advanced catalog, without state guesses."""

from __future__ import annotations

from collections import Counter
from hashlib import sha256
from math import isfinite
from typing import Any

from homeassistant.exceptions import HomeAssistantError

from .bridge_client import BridgeClientError, bridge_error_message
from .models import (
    BridgeCommandDescriptor,
    BridgeControl,
    BridgeDevice,
    SmartThingsWebRuntime,
    refresh_controls,
    safe_observed_control,
)

_STATELESS_BUTTONS = frozenset({"refresh", "push", "press", "momentary", "ping", "beep", "identify"})
_MAX_SAFE_INTEGER = 2**53 - 1
# Existing native platforms retain ownership of their established command paths.
_NATIVE_COMMANDS = frozenset({
    "on", "off", "setNumber", "setVolume", "setOption", "setFanMode", "setInputSource",
    "setRepeat", "setShuffle", "setPosition", "fanSpeed", "volume", "play", "pause",
    "stop", "mute", "unmute", "open", "close", "openShade", "closeShade",
    "nextTrack", "previousTrack", "fastForward", "rewind", "playTrackAndResume",
})


def command_identity(command: BridgeCommandDescriptor) -> tuple[str, str, str]:
    """Keep opaque component/capability aliases intact."""
    return command.component, command.capability, command.command


def command_suffix(kind: str, command: BridgeCommandDescriptor) -> str:
    """Stable new IDs; do not rename or migrate existing Web entity IDs."""
    digest = sha256("\0".join(command_identity(command)).encode()).hexdigest()[:24]
    return f"command_{kind}_{digest}"


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and abs(value) <= _MAX_SAFE_INTEGER and isfinite(value)


def command_kind(command: BridgeCommandDescriptor) -> str | None:
    """Expose only exact, non-sensitive, directly representable input schemas."""
    if command.command in _NATIVE_COMMANDS or command.transport != "advanced" or any(arg.sensitive for arg in command.arguments):
        return None
    # Retain the integration's actuator restrictions; the Bridge independently
    # rechecks its stricter catalog policy immediately before every dispatch.
    safety_control = BridgeControl(
        "catalog", "button", command.label,
        component=command.component, capability=command.capability,
        commands=(command.command, command.component_role or "", command.capability_role or ""),
    )
    if not safe_observed_control(safety_control):
        return None
    if not command.arguments:
        return "button" if command.command in _STATELESS_BUTTONS and command.confirmation == "accepted_receipt" else None
    if len(command.arguments) != 1 or not command.arguments[0].required:
        return None
    schema = command.arguments[0].schema
    if schema.get("type") == "string":
        options = schema.get("enum")
        minimum, maximum = schema.get("minLength", 1), schema.get("maxLength", 2048)
        if (
            isinstance(options, list) and 0 < len(options) <= 128
            and type(minimum) is int and type(maximum) is int
            and 0 <= minimum <= maximum <= 2048
            and all(isinstance(value, str) and max(1, minimum) <= len(value) <= maximum
                    and not any(ord(char) < 32 or ord(char) == 127 for char in value)
                    for value in options)
            and len(set(options)) == len(options)
        ):
            return "select"
    if schema.get("type") == "integer" and "enum" not in schema:
        minimum, maximum = schema.get("minimum"), schema.get("maximum")
        if (_finite(minimum) and _finite(maximum) and minimum <= maximum
                and float(minimum).is_integer() and float(maximum).is_integer()):
            return "number"
    return None


def catalog_commands(device: BridgeDevice, kind: str) -> list[BridgeCommandDescriptor]:
    """Find missing commands, rejecting ambiguous/omitted or already exposed ones."""
    counts = Counter(command_identity(command) for command in device.commands)
    result = []
    for command in device.commands:
        if counts[command_identity(command)] != 1 or command_kind(command) != kind:
            continue
        if any(
            omission.component == command.component and omission.capability == command.capability
            and (omission.command is None or omission.command == command.command)
            for omission in device.command_omissions
        ):
            continue
        if command.command == "refresh" and refresh_controls(device):
            continue
        if any(
            control.component == command.component and control.capability == command.capability
            and safe_observed_control(control)
            and (command.command in (*control.commands, *control.option_commands.values())
                 or control.kind == {"number": "slider", "select": "enumerated", "button": "button"}[kind])
            for control in device.controls.values()
        ):
            continue
        result.append(command)
    return sorted(result, key=command_identity)


class CatalogCommandEntityMixin:
    """Shared exact-target dispatch for command-only number/select/button entities."""

    _command_kind: str

    def __init__(self, runtime: SmartThingsWebRuntime, device: BridgeDevice,
                 command: BridgeCommandDescriptor) -> None:
        self._catalog_identity = command_identity(command)
        super().__init__(
            runtime, device, command_suffix(self._command_kind, command),
            command.label or command.command,
        )

    @property
    def _current_descriptor(self) -> BridgeCommandDescriptor | None:
        device = self.bridge_device
        if device is None or device.location_id != self.runtime.location_id:
            return None
        return next((command for command in catalog_commands(device, self._command_kind)
                     if command_identity(command) == self._catalog_identity), None)

    @property
    def available(self) -> bool:
        return super().available and self._current_descriptor is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "smartthings_command": self._catalog_identity[2],
            "smartthings_command_only": True,
            "smartthings_confirmation": "accepted_receipt",
        }

    async def _async_send(self, arguments: list[Any]) -> None:
        command = self._current_descriptor
        if not self.available or command is None:
            raise HomeAssistantError("SmartThings Web catalog command is unavailable")
        # A catalog lists accepted inputs, not a verified command-to-state binding.
        # Request receipt-only execution explicitly; never fake a confirmed state.
        try:
            await self.runtime.client.async_execute_command(
                target_type="device", target_id=self.device_id,
                component=command.component, capability=command.capability,
                command=command.command, arguments=arguments,
                require_advanced=True, confirm=False,
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("catalog command", err)) from err

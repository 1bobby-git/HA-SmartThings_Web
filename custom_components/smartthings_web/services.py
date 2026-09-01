"""Domain services for SmartThings Web."""

from __future__ import annotations

import json
from math import isfinite
import re
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
import voluptuous as vol

if TYPE_CHECKING:
    from homeassistant.core import ServiceCall
else:
    ServiceCall = Any

from .const import (
    DOMAIN,
    SERVICE_EXECUTE_COMMAND,
    SERVICE_LIST_COMMANDS,
    SERVICE_RECONNECT_REALTIME,
    SERVICE_REFRESH_DEVICE,
    SERVICE_RELOAD_INVENTORY,
    SERVICE_SPEAK,
)


_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
_DEVICE_ALIAS_PATTERN = re.compile(r"^dev_[A-Za-z0-9_-]{3,64}$")
_TARGET_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
_CONTROL_CHARS_PATTERN = re.compile(r"[\u0000-\u001f\u007f]")
_MAX_ARGUMENT_DEPTH = 16
_MAX_ARGUMENT_NODES = 512
_MAX_ARGUMENT_BYTES = 8192

_TOKEN = vol.Match(_TOKEN_PATTERN)
_DEVICE_TARGET = vol.Match(_TARGET_PATTERN)


def _phrase(value: Any) -> str:
    if not isinstance(value, str):
        raise vol.Invalid("phrase")
    if not value or len(value) > 1024 or _CONTROL_CHARS_PATTERN.search(value):
        raise vol.Invalid("phrase")
    return value


def _arguments(value: Any) -> list[Any]:
    if not isinstance(value, list) or len(value) > 16:
        raise vol.Invalid("arguments")
    nodes = [0]
    result = [_json_argument(item, depth=0, nodes=nodes) for item in value]
    try:
        if len(json.dumps(result, sort_keys=True, separators=(",", ":"))) > _MAX_ARGUMENT_BYTES:
            raise vol.Invalid("arguments")
    except (TypeError, ValueError) as err:
        raise vol.Invalid("arguments") from err
    return result


def _json_argument(value: Any, *, depth: int, nodes: list[int]) -> Any:
    nodes[0] += 1
    if depth > _MAX_ARGUMENT_DEPTH or nodes[0] > _MAX_ARGUMENT_NODES:
        raise vol.Invalid("arguments")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float) and isfinite(value):
        return value
    if isinstance(value, str):
        if len(value) > 2048 or _CONTROL_CHARS_PATTERN.search(value):
            raise vol.Invalid("arguments")
        return value
    if isinstance(value, list):
        if len(value) > 64:
            raise vol.Invalid("arguments")
        return [_json_argument(item, depth=depth + 1, nodes=nodes) for item in value]
    if isinstance(value, dict):
        if len(value) > 64:
            raise vol.Invalid("arguments")
        result: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 160:
                raise vol.Invalid("arguments")
            result[key] = _json_argument(item, depth=depth + 1, nodes=nodes)
        return result
    raise vol.Invalid("arguments")

EXECUTE_COMMAND_SCHEMA = vol.Schema(
    {
        vol.Required("device_id"): _DEVICE_TARGET,
        vol.Required("component", default="main"): _TOKEN,
        vol.Required("capability"): _TOKEN,
        vol.Required("command"): _TOKEN,
        vol.Optional("arguments", default=list): _arguments,
        vol.Optional("confirm", default=True): bool,
        vol.Optional("timeout", default=30): vol.All(
            int, lambda value: value if 1 <= value <= 120 else vol.Invalid("timeout")
        ),
    },
    extra=vol.PREVENT_EXTRA,
)

REFRESH_DEVICE_SCHEMA = vol.Schema(
    {vol.Required("device_id"): _DEVICE_TARGET}, extra=vol.PREVENT_EXTRA
)
LIST_COMMANDS_SCHEMA = vol.Schema(
    {vol.Required("device_id"): _DEVICE_TARGET}, extra=vol.PREVENT_EXTRA
)
SPEAK_SCHEMA = vol.Schema(
    {
        vol.Required("device_id"): _DEVICE_TARGET,
        vol.Required("phrase"): _phrase,
        vol.Optional("timeout", default=30): vol.All(
            int, lambda value: value if 1 <= value <= 120 else vol.Invalid("timeout")
        ),
    },
    extra=vol.PREVENT_EXTRA,
)
EMPTY_SCHEMA = vol.Schema({}, extra=vol.PREVENT_EXTRA)


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register SmartThings Web services once per Home Assistant process."""
    services = getattr(hass, "services", None)
    if services is None:
        return
    has_service = getattr(services, "has_service", None)
    register = getattr(services, "async_register", None)
    if callable(register):
        registrations = (
            (
                SERVICE_EXECUTE_COMMAND,
                async_handle_execute_command,
                EXECUTE_COMMAND_SCHEMA,
            ),
            (
                SERVICE_LIST_COMMANDS,
                async_handle_list_commands,
                LIST_COMMANDS_SCHEMA,
            ),
            (
                SERVICE_SPEAK,
                async_handle_speak,
                SPEAK_SCHEMA,
            ),
            (
                SERVICE_RELOAD_INVENTORY,
                async_handle_reload_inventory,
                EMPTY_SCHEMA,
            ),
            (
                SERVICE_REFRESH_DEVICE,
                async_handle_refresh_device,
                REFRESH_DEVICE_SCHEMA,
            ),
            (
                SERVICE_RECONNECT_REALTIME,
                async_handle_reconnect_realtime,
                EMPTY_SCHEMA,
            ),
        )
        for service, handler, schema in registrations:
            if callable(has_service) and has_service(DOMAIN, service):
                continue
            kwargs: dict[str, Any] = {}
            if service == SERVICE_LIST_COMMANDS:
                kwargs["supports_response"] = _supports_response_only()
            register(
                DOMAIN,
                service,
                lambda call, handler=handler: handler(hass, call),
                schema=schema,
                **kwargs,
            )


async def async_handle_execute_command(hass: HomeAssistant, call: ServiceCall) -> None:
    """Route one validated device command to the owning config entry."""
    data: dict[str, Any] = dict(call.data)
    device_id = _bridge_alias_for_device(hass, data["device_id"])
    runtime = _runtime_for_device(hass, device_id)
    if runtime is not None:
        client = runtime.client
        await client.async_execute_command(
            target_type="device",
            target_id=device_id,
            component=data["component"],
            capability=data["capability"],
            command=data["command"],
            arguments=list(data["arguments"]),
            require_advanced=True,
            confirm=data["confirm"],
            timeout=data["timeout"],
        )
        return
    _raise_device_not_found()


async def async_handle_list_commands(
    hass: HomeAssistant, call: ServiceCall
) -> dict[str, Any]:
    """Return the safe Advanced command catalog for one device."""
    device_id = _bridge_alias_for_device(hass, call.data["device_id"])
    runtime = _runtime_for_device(hass, device_id)
    if runtime is None:
        _raise_device_not_found()
    catalog = await runtime.client.async_list_commands(device_id)
    return {
        "device_id": catalog.device_id,
        "commands": [_command_descriptor_response(command) for command in catalog.commands],
        "omissions": dict(catalog.omissions),
    }


async def async_handle_speak(hass: HomeAssistant, call: ServiceCall) -> None:
    """Speak one phrase through a unique safe speechSynthesis.speak descriptor."""
    data: dict[str, Any] = dict(call.data)
    device_id = _bridge_alias_for_device(hass, data["device_id"])
    runtime = _runtime_for_device(hass, device_id)
    if runtime is None:
        _raise_device_not_found()
    catalog = await runtime.client.async_list_commands(device_id)
    matches = [
        command
        for command in catalog.commands
        if command.capability == "speechSynthesis" and command.command == "speak"
    ]
    if not matches:
        _raise_service_error("command_control_not_found")
    if len(matches) > 1:
        _raise_service_error("command_control_ambiguous")
    descriptor = matches[0]
    if (
        len(descriptor.arguments) != 1
        or descriptor.arguments[0].name != "phrase"
        or descriptor.arguments[0].schema.get("type") != "string"
    ):
        _raise_service_error("invalid_arguments")
    await runtime.client.async_execute_command(
        target_type="device",
        target_id=device_id,
        component=descriptor.component,
        capability=descriptor.capability,
        command=descriptor.command,
        arguments=[data["phrase"]],
        require_advanced=True,
        confirm=False,
        timeout=data["timeout"],
    )


async def async_handle_reload_inventory(hass: HomeAssistant, _call: ServiceCall) -> None:
    """Reload Advanced inventory once for each loaded local client."""
    for client in _unique_clients(hass):
        await client.async_reload_inventory()


async def async_handle_reconnect_realtime(
    hass: HomeAssistant, _call: ServiceCall
) -> None:
    """Request one bounded realtime reconnect per loaded local client."""
    for client in _unique_clients(hass):
        await client.async_reconnect_realtime()


async def async_handle_refresh_device(hass: HomeAssistant, call: ServiceCall) -> None:
    """Execute the observed stateless refresh command for one device."""
    device_id = _bridge_alias_for_device(hass, call.data["device_id"])
    runtime = _runtime_for_device(hass, device_id)
    if runtime is None:
        _raise_device_not_found()
    device = runtime.inventory.devices[device_id]
    controls = getattr(device, "controls", {})
    refresh = next(
        (
            control
            for control in controls.values()
            if getattr(control, "command", None) == "refresh"
            or "refresh" in getattr(control, "commands", ())
        ),
        None,
    )
    if refresh is None:
        _raise_service_error("capability_not_found")
    await runtime.client.async_execute_command(
        target_type="device",
        target_id=device_id,
        component=refresh.component,
        capability=refresh.capability,
        command="refresh",
        arguments=[],
        control_id=refresh.control_id,
        control_label=refresh.label,
        confirm=False,
        timeout=30,
    )


def _runtime_for_device(hass: HomeAssistant, device_id: str) -> Any | None:
    for entry in hass.config_entries.async_entries(DOMAIN):
        runtime = getattr(entry, "runtime_data", None)
        devices = getattr(getattr(runtime, "inventory", None), "devices", {})
        if runtime is not None and device_id in devices and getattr(runtime, "client", None):
            return runtime
    return None


def _bridge_alias_for_device(hass: HomeAssistant, target: str) -> str:
    """Resolve a Bridge device alias from either dev_N or HA Device Registry ID."""
    if not isinstance(target, str) or not _TARGET_PATTERN.fullmatch(target):
        _raise_device_not_found()
    if _DEVICE_ALIAS_PATTERN.fullmatch(target):
        return target
    try:
        from homeassistant.helpers import device_registry as dr
    except ImportError:
        _raise_device_not_found()
    async_get = getattr(dr, "async_get", None)
    if not callable(async_get):
        _raise_device_not_found()
    registry = async_get(hass)
    entry = registry.async_get(target) if registry is not None else None
    if entry is None:
        _raise_device_not_found()
    matches = sorted(
        identifier[1]
        for identifier in getattr(entry, "identifiers", set())
        if (
            isinstance(identifier, tuple)
            and len(identifier) == 2
            and identifier[0] == DOMAIN
            and isinstance(identifier[1], str)
            and _DEVICE_ALIAS_PATTERN.fullmatch(identifier[1])
        )
    )
    if not matches:
        _raise_device_not_found()
    if len(matches) > 1:
        _raise_service_error("device_ambiguous")
    return matches[0]


def _command_descriptor_response(command: Any) -> dict[str, Any]:
    return {
        "component": command.component,
        "component_role": command.component_role,
        "capability": command.capability,
        "capability_version": command.capability_version,
        "command": command.command,
        "arguments": [
            {
                "name": argument.name,
                "required": argument.required,
                "sensitive": argument.sensitive,
                "schema": dict(argument.schema),
                **({"unit": argument.unit} if argument.unit else {}),
            }
            for argument in command.arguments
        ],
        "transport": command.transport,
        "confirmation": command.confirmation,
        "label": command.label,
        "label_source": command.label_source,
    }


def _supports_response_only() -> Any:
    try:
        from homeassistant.core import SupportsResponse
    except ImportError:
        return "only"
    return getattr(SupportsResponse, "ONLY", "only")


def _unique_clients(hass: HomeAssistant) -> list[Any]:
    clients: list[Any] = []
    seen: set[int] = set()
    for entry in hass.config_entries.async_entries(DOMAIN):
        client = getattr(getattr(entry, "runtime_data", None), "client", None)
        if client is None or id(client) in seen:
            continue
        seen.add(id(client))
        clients.append(client)
    return clients


def _raise_device_not_found() -> None:
    _raise_service_error("device_not_found")


def _raise_service_error(code: str) -> None:
    try:
        from homeassistant.exceptions import HomeAssistantError
    except ImportError:  # Minimal test environments do not ship Home Assistant.
        HomeAssistantError = RuntimeError
    raise HomeAssistantError(code)

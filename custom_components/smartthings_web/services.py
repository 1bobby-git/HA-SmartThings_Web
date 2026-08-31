"""Domain services for SmartThings Web."""

from __future__ import annotations

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
    SERVICE_RECONNECT_REALTIME,
    SERVICE_REFRESH_DEVICE,
    SERVICE_RELOAD_INVENTORY,
)


_TOKEN = vol.Match(r"^[A-Za-z0-9_.:-]{1,160}$")
_DEVICE_ID = vol.Match(r"^dev_[A-Za-z0-9_-]{3,64}$")

EXECUTE_COMMAND_SCHEMA = vol.Schema(
    {
        vol.Required("device_id"): _DEVICE_ID,
        vol.Required("component", default="main"): _TOKEN,
        vol.Required("capability"): _TOKEN,
        vol.Required("command"): _TOKEN,
        vol.Optional("arguments", default=list): vol.All(list, vol.Length(max=16)),
        vol.Optional("confirm", default=True): bool,
        vol.Optional("timeout", default=30): vol.All(
            int, lambda value: value if 1 <= value <= 120 else vol.Invalid("timeout")
        ),
    },
    extra=vol.PREVENT_EXTRA,
)

REFRESH_DEVICE_SCHEMA = vol.Schema(
    {vol.Required("device_id"): _DEVICE_ID}, extra=vol.PREVENT_EXTRA
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
            register(
                DOMAIN,
                service,
                lambda call, handler=handler: handler(hass, call),
                schema=schema,
            )


async def async_handle_execute_command(hass: HomeAssistant, call: ServiceCall) -> None:
    """Route one validated device command to the owning config entry."""
    data: dict[str, Any] = dict(call.data)
    device_id = data["device_id"]
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
            confirm=data["confirm"],
            timeout=data["timeout"],
        )
        return
    _raise_device_not_found()


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
    device_id = call.data["device_id"]
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

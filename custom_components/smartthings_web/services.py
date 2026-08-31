"""Domain services for SmartThings Web."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
import voluptuous as vol

if TYPE_CHECKING:
    from homeassistant.core import ServiceCall
else:
    ServiceCall = Any

from .const import DOMAIN, SERVICE_EXECUTE_COMMAND


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


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register SmartThings Web services once per Home Assistant process."""
    services = getattr(hass, "services", None)
    if services is None:
        return
    has_service = getattr(services, "has_service", None)
    if callable(has_service) and has_service(DOMAIN, SERVICE_EXECUTE_COMMAND):
        return
    register = getattr(services, "async_register", None)
    if callable(register):
        register(
            DOMAIN,
            SERVICE_EXECUTE_COMMAND,
            lambda call: async_handle_execute_command(hass, call),
            schema=EXECUTE_COMMAND_SCHEMA,
        )


async def async_handle_execute_command(hass: HomeAssistant, call: ServiceCall) -> None:
    """Route one validated device command to the owning config entry."""
    data: dict[str, Any] = dict(call.data)
    device_id = data["device_id"]
    entries = hass.config_entries.async_entries(DOMAIN)
    for entry in entries:
        runtime = getattr(entry, "runtime_data", None)
        inventory = getattr(runtime, "inventory", None)
        devices = getattr(inventory, "devices", {})
        if device_id not in devices:
            continue
        client = getattr(runtime, "client", None)
        if client is None:
            break
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
    try:
        from homeassistant.exceptions import HomeAssistantError
    except ImportError:  # Minimal test environments do not ship Home Assistant.
        HomeAssistantError = RuntimeError
    raise HomeAssistantError("device_not_found")

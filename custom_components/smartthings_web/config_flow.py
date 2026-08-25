"""Config flow for SmartThings Web."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .bridge_client import BridgeAuthError, BridgeClientError, SmartThingsWebBridgeClient
from .const import (
    CONF_BRIDGE_TOKEN,
    CONF_BRIDGE_URL,
    CONF_LOCATION_ID,
    DEFAULT_BRIDGE_URL,
    DOMAIN,
)
from .models import BridgeInventory, location_name


class SmartThingsWebConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure the local Bridge."""

    VERSION = 1
    _pending_pairing: tuple[str, str, BridgeInventory] | None = None

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """Pair with the Bridge and select its main device location."""
        errors: dict[str, str] = {}
        if user_input is not None:
            client = SmartThingsWebBridgeClient(
                async_get_clientsession(self.hass), user_input[CONF_BRIDGE_URL]
            )
            try:
                token = await client.async_pair(user_input["pairing_code"])
                inventory = await client.async_get_inventory()
            except BridgeAuthError:
                errors["base"] = "invalid_pairing_code"
            except BridgeClientError:
                errors["base"] = "cannot_connect"
            else:
                location_ids = set(inventory.locations)
                location_ids.update(device.location_id for device in inventory.devices.values())
                if not location_ids:
                    errors["base"] = "no_devices"
                else:
                    self._pending_pairing = (
                        user_input[CONF_BRIDGE_URL].rstrip("/"),
                        token,
                        inventory,
                    )
                    return await self.async_step_location()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_BRIDGE_URL, default=DEFAULT_BRIDGE_URL): str,
                    vol.Required("pairing_code"): str,
                }
            ),
            errors=errors,
        )

    async def async_step_location(self, user_input: dict[str, Any] | None = None):
        """Let the user choose the SmartThings location represented by this entry."""
        if self._pending_pairing is None:
            return self.async_abort(reason="invalid_flow")
        bridge_url, token, inventory = self._pending_pairing
        location_ids = set(inventory.locations)
        location_ids.update(device.location_id for device in inventory.devices.values())
        choices = {
            location_id: location_name(inventory, location_id)
            if location_id in inventory.locations
            else f"Location {index}"
            for index, location_id in enumerate(sorted(location_ids), start=1)
        }
        if user_input is not None:
            location_id = user_input.get(CONF_LOCATION_ID)
            if location_id not in choices:
                return self.async_show_form(
                    step_id="location",
                    data_schema=vol.Schema(
                        {vol.Required(CONF_LOCATION_ID): vol.In(choices)}
                    ),
                    errors={CONF_LOCATION_ID: "invalid_location"},
                )
            await self.async_set_unique_id(location_id)
            self._abort_if_unique_id_configured()
            self._pending_pairing = None
            return self.async_create_entry(
                title=choices[location_id],
                data={
                    CONF_BRIDGE_URL: bridge_url,
                    CONF_BRIDGE_TOKEN: token,
                    CONF_LOCATION_ID: location_id,
                },
            )
        return self.async_show_form(
            step_id="location",
            data_schema=vol.Schema(
                {vol.Required(CONF_LOCATION_ID): vol.In(choices)}
            ),
        )

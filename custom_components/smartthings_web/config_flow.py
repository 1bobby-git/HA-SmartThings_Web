"""Config flow for SmartThings Web."""

from __future__ import annotations

from collections import Counter
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


class SmartThingsWebConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure the local Bridge."""

    VERSION = 1

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
                counts = Counter(device.location_id for device in inventory.devices.values())
                if not counts:
                    errors["base"] = "no_devices"
                else:
                    location_id = counts.most_common(1)[0][0]
                    await self.async_set_unique_id(location_id)
                    self._abort_if_unique_id_configured()
                    title = inventory.locations.get(location_id, "SmartThings Web")
                    return self.async_create_entry(
                        title=title,
                        data={
                            CONF_BRIDGE_URL: user_input[CONF_BRIDGE_URL].rstrip("/"),
                            CONF_BRIDGE_TOKEN: token,
                            CONF_LOCATION_ID: location_id,
                        },
                    )

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


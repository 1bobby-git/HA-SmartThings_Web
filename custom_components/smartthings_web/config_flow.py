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
    CONF_COMMAND_CONFIRMATION_TIMEOUT,
    CONF_CONTROL_MODE,
    CONF_DEBUG_PROTOCOL_LOGGING,
    CONF_DOM_FALLBACK_ENABLED,
    CONF_INVENTORY_RECONCILIATION_INTERVAL,
    CONF_LOCATION_ID,
    CONF_STATUS_RECHECK_ENABLED,
    CONTROL_MODE_READ_ONLY,
    CONTROL_MODE_SAFE_CONTROL,
    DEFAULT_BRIDGE_URL,
    DEFAULT_COMMAND_CONFIRMATION_TIMEOUT,
    DEFAULT_INVENTORY_RECONCILIATION_INTERVAL,
    DOMAIN,
)
from .models import BridgeInventory, location_name


CONTROL_MODE_OPTIONS = {
    CONTROL_MODE_READ_ONLY: "Read only",
    CONTROL_MODE_SAFE_CONTROL: "Safe control",
}


class SmartThingsWebConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure the local Bridge."""

    VERSION = 1
    _pending_pairing: tuple[str, str, BridgeInventory] | None = None
    _reauth_data: dict[str, Any] | None = None

    @staticmethod
    def async_get_options_flow(
        _config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        """Return the options flow for this entry."""
        return SmartThingsWebOptionsFlow()

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
                options={
                    CONF_CONTROL_MODE: CONTROL_MODE_SAFE_CONTROL,
                    CONF_COMMAND_CONFIRMATION_TIMEOUT: DEFAULT_COMMAND_CONFIRMATION_TIMEOUT,
                    CONF_STATUS_RECHECK_ENABLED: True,
                    CONF_INVENTORY_RECONCILIATION_INTERVAL: DEFAULT_INVENTORY_RECONCILIATION_INTERVAL,
                    CONF_DOM_FALLBACK_ENABLED: True,
                    CONF_DEBUG_PROTOCOL_LOGGING: False,
                },
            )
        return self.async_show_form(
            step_id="location",
            data_schema=vol.Schema(
                {vol.Required(CONF_LOCATION_ID): vol.In(choices)}
            ),
        )

    async def async_step_reauth(self, entry_data: dict[str, Any]):
        """Start local Bridge token reauthentication."""
        self._reauth_data = entry_data
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None):
        """Exchange a new pairing code for the local Bridge token."""
        errors: dict[str, str] = {}
        if self._reauth_data is None:
            return self.async_abort(reason="invalid_flow")
        if user_input is not None:
            client = SmartThingsWebBridgeClient(
                async_get_clientsession(self.hass),
                self._reauth_data[CONF_BRIDGE_URL],
            )
            try:
                token = await client.async_pair(user_input["pairing_code"])
            except BridgeAuthError:
                errors["base"] = "invalid_pairing_code"
            except BridgeClientError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(
                    self._get_reauth_entry(),
                    data_updates={CONF_BRIDGE_TOKEN: token},
                )

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required("pairing_code"): str}),
            errors=errors,
        )


_OptionsFlowBase = getattr(config_entries, "OptionsFlowWithReload", config_entries.OptionsFlow)


class SmartThingsWebOptionsFlow(_OptionsFlowBase):
    """Configure SmartThings Web runtime behavior."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        """Update integration options."""
        entry = self._entry
        current = entry.options.get(CONF_CONTROL_MODE, CONTROL_MODE_SAFE_CONTROL)
        confirmation_timeout = entry.options.get(
            CONF_COMMAND_CONFIRMATION_TIMEOUT, DEFAULT_COMMAND_CONFIRMATION_TIMEOUT
        )
        status_recheck = entry.options.get(CONF_STATUS_RECHECK_ENABLED, True)
        reconciliation_interval = entry.options.get(
            CONF_INVENTORY_RECONCILIATION_INTERVAL,
            DEFAULT_INVENTORY_RECONCILIATION_INTERVAL,
        )
        dom_fallback = entry.options.get(CONF_DOM_FALLBACK_ENABLED, True)
        debug_protocol = entry.options.get(CONF_DEBUG_PROTOCOL_LOGGING, False)
        if user_input is not None:
            return self.async_create_entry(
                title="",
                data={
                    CONF_CONTROL_MODE: user_input.get(CONF_CONTROL_MODE, current),
                    CONF_COMMAND_CONFIRMATION_TIMEOUT: user_input.get(
                        CONF_COMMAND_CONFIRMATION_TIMEOUT, confirmation_timeout
                    ),
                    CONF_STATUS_RECHECK_ENABLED: user_input.get(
                        CONF_STATUS_RECHECK_ENABLED, status_recheck
                    ),
                    CONF_INVENTORY_RECONCILIATION_INTERVAL: user_input.get(
                        CONF_INVENTORY_RECONCILIATION_INTERVAL,
                        reconciliation_interval,
                    ),
                    CONF_DOM_FALLBACK_ENABLED: user_input.get(
                        CONF_DOM_FALLBACK_ENABLED, dom_fallback
                    ),
                    CONF_DEBUG_PROTOCOL_LOGGING: user_input.get(
                        CONF_DEBUG_PROTOCOL_LOGGING, debug_protocol
                    ),
                },
            )
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_CONTROL_MODE, default=current): vol.In(
                        CONTROL_MODE_OPTIONS
                    ),
                    vol.Required(
                        CONF_COMMAND_CONFIRMATION_TIMEOUT,
                        default=confirmation_timeout,
                    ): vol.All(int, vol.Range(min=1, max=120)),
                    vol.Required(
                        CONF_STATUS_RECHECK_ENABLED, default=status_recheck
                    ): bool,
                    vol.Required(
                        CONF_INVENTORY_RECONCILIATION_INTERVAL,
                        default=reconciliation_interval,
                    ): vol.All(int, vol.Range(min=900, max=604800)),
                    vol.Required(
                        CONF_DOM_FALLBACK_ENABLED, default=dom_fallback
                    ): bool,
                    vol.Required(
                        CONF_DEBUG_PROTOCOL_LOGGING, default=debug_protocol
                    ): bool,
                }
            ),
        )

    @property
    def _entry(self) -> config_entries.ConfigEntry:
        entry = self.config_entry
        if entry is None:
            raise RuntimeError("Options flow config entry is not available")
        return entry

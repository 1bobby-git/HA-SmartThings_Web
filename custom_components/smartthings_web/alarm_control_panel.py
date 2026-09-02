"""SmartThings Home Monitor alarm panel for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.alarm_control_panel import (
    AlarmControlPanelEntity,
    AlarmControlPanelEntityFeature,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .const import DOMAIN
from .models import (
    SmartThingsWebRuntime,
    location_arm_state,
    location_name,
    location_unique_id,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create SmartThings Home Monitor as soon as the configured location exists."""
    runtime = entry.runtime_data
    known = False

    def discover() -> None:
        nonlocal known
        if known or runtime.location_id not in runtime.inventory.locations:
            return
        known = True
        async_add_entities([SmartThingsWebHomeMonitor(runtime)])

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebHomeMonitor(AlarmControlPanelEntity):
    """SmartThings Home Monitor state for one location."""

    _attr_should_poll = False
    _attr_supported_features = (
        AlarmControlPanelEntityFeature.ARM_AWAY
        | AlarmControlPanelEntityFeature.ARM_HOME
    )

    def __init__(self, runtime: SmartThingsWebRuntime) -> None:
        self.runtime = runtime
        self._attr_name = f"{location_name(runtime.inventory, runtime.location_id)} Home Monitor"
        self._attr_unique_id = location_unique_id(runtime.location_id, "home_monitor")
        self._attr_device_info = {
            "identifiers": {(DOMAIN, runtime.location_id)},
            "name": location_name(runtime.inventory, runtime.location_id),
            "manufacturer": "SmartThings",
        }

    @property
    def available(self) -> bool:
        """Return whether the configured SmartThings location is present.

        Home Monitor arm state is push-driven and may be absent until the
        location has emitted its first security event. A valid location must
        remain controllable during that initial unknown-state window.
        """
        return self.runtime.location_id in self.runtime.inventory.locations

    @property
    def state(self) -> str | None:
        """Return the HA alarm state from the latest Bridge inventory."""
        value = location_arm_state(self.runtime.inventory, self.runtime.location_id)
        if value is None:
            return None
        normalized = value.lower()
        return {
            "disarmed": "disarmed",
            "off": "disarmed",
            "stay": "armed_home",
            "armed_home": "armed_home",
            "armed_stay": "armed_home",
            "armedstay": "armed_home",
            "away": "armed_away",
            "armed_away": "armed_away",
            "armedaway": "armed_away",
        }.get(normalized, normalized)

    async def async_added_to_hass(self) -> None:
        """Subscribe to Bridge pushes."""
        self.async_on_remove(self.runtime.subscribe(self.async_write_ha_state))

    async def async_alarm_disarm(self, code: str | None = None) -> None:
        """Disarm SmartThings Home Monitor."""
        await self._async_arm("disarm")

    async def async_alarm_arm_home(self, code: str | None = None) -> None:
        """Arm SmartThings Home Monitor in stay mode."""
        await self._async_arm("armStay")

    async def async_alarm_arm_away(self, code: str | None = None) -> None:
        """Arm SmartThings Home Monitor in away mode."""
        await self._async_arm("armAway")

    async def _async_arm(self, command: str) -> None:
        try:
            await self.runtime.client.async_execute_command(
                target_type="location",
                target_id=self.runtime.location_id,
                command=command,
                arguments=[],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("Home Monitor command", err)) from err

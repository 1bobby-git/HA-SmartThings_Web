"""SmartThings Home Monitor alarm panel for SmartThings Web."""

from __future__ import annotations

import asyncio
import logging

from homeassistant.components.alarm_control_panel import (
    AlarmControlPanelEntity,
    AlarmControlPanelEntityFeature,
    AlarmControlPanelState,
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
    # SmartThings Web session authentication replaces a keypad code.
    _attr_code_arm_required = False
    _attr_code_format = None
    _attr_supported_features = (
        AlarmControlPanelEntityFeature.ARM_AWAY
        | AlarmControlPanelEntityFeature.ARM_HOME
    )

    def __init__(self, runtime: SmartThingsWebRuntime) -> None:
        self.runtime = runtime
        self._pending_command: str | None = None
        self._pending_token: object | None = None
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

    def _observed_state(self) -> str | None:
        """Return only the state actually received in the Bridge inventory."""
        value = location_arm_state(self.runtime.inventory, self.runtime.location_id)
        if value is None:
            return None
        normalized = value.strip().lower()
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

    @property
    def alarm_state(self) -> AlarmControlPanelState | None:
        """Show request progress separately from confirmed home/away states."""
        if not self.available:
            return None
        observed = self._observed_state()
        # A triggered alarm/entry countdown always outranks local command progress.
        if self._pending_command and observed not in {"triggered", "pending"}:
            expected = {"armAway": "armed_away", "armStay": "armed_home", "disarm": "disarmed"}[self._pending_command]
            if observed != expected:
                return (AlarmControlPanelState.DISARMING if self._pending_command == "disarm"
                        else AlarmControlPanelState.ARMING)
        try:
            return AlarmControlPanelState(observed) if observed is not None else None
        except ValueError:
            return None

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Do not mistake a local request for the server's final security mode."""
        return {"command_pending": self._pending_command,
                "confirmed_state": self._observed_state()}

    def _publish_pending(self) -> None:
        if getattr(self, "hass", None) is not None:
            self.async_write_ha_state()

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
        # Keep the Bridge's existing command ordering. A newer request (including
        # disarm) must not be rejected merely to manage a local progress indicator.
        token = object()
        self._pending_token = token
        self._pending_command = command
        self._publish_pending()
        try:
            await self._async_execute_arm(command)
        finally:
            # Includes timeout, rejected request and task cancellation. Never leave
            # a local progress state stuck or manufacture a successful arm mode.
            if self._pending_token is token:
                self._pending_token = None
                self._pending_command = None
                self._publish_pending()

    async def _async_execute_arm(self, command: str) -> None:
        try:
            result = await self.runtime.client.async_execute_command(
                target_type="location",
                target_id=self.runtime.location_id,
                command=command,
                arguments=[],
            )
        except BridgeClientError as err:
            if str(err) in {"command_transition_disarm_failed", "command_transition_rearm_failed"}:
                # An intermediate disarm may have succeeded. Read actual state once;
                # never present the requested or previous mode as a substitute.
                try:
                    async with asyncio.timeout(3):
                        latest = await self.runtime.client.async_get_inventory()
                    self.runtime.apply_inventory(latest)
                except (BridgeClientError, TimeoutError):
                    pass
                logging.getLogger(__name__).error(
                    "Home Monitor mode transition incomplete; the location may be disarmed. Verify its actual security state (%s)",
                    str(err),
                )
            raise HomeAssistantError(bridge_error_message("Home Monitor command", err)) from err
        if getattr(result, "status", None) not in {"confirmed", "already_confirmed"}:
            return
        sequence = getattr(result, "sequence", None)
        expected_state = {"armAway": "armed_away", "armStay": "armed_home", "disarm": "disarmed"}.get(command)
        if (
            isinstance(sequence, int)
            and not isinstance(sequence, bool)
            and self.runtime.inventory.sequence >= sequence
            and self._observed_state() == expected_state
        ):
            # The verified result has already arrived through SSE. Avoid a redundant full read.
            return
        try:
            # One post-command read closes the SSE delivery race; never set a requested mode.
            # A delayed read cannot overwrite a newer snapshot (apply_inventory checks sequence).
            async with asyncio.timeout(3):
                latest = await self.runtime.client.async_get_inventory()
            self.runtime.apply_inventory(latest)
        except (BridgeClientError, TimeoutError):
            logging.getLogger(__name__).warning(
                "Home Monitor command confirmed; immediate inventory read unavailable, waiting for Bridge events"
            )

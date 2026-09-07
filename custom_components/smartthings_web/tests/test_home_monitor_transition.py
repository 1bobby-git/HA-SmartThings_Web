"""Transition errors must never create an optimistic armed state."""
from dataclasses import replace
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from test_alarm_control_panel import (
    _runtime,
    BridgeClientError,
    BridgeLocation,
    SmartThingsWebHomeMonitor,
)


class HomeMonitorTransitionTests(unittest.IsolatedAsyncioTestCase):
    async def test_rearm_failure_reads_actual_disarmed_state_once(self):
        runtime = _runtime(BridgeLocation("loc_001", "Synthetic", "ARMED_AWAY"))
        actual = replace(runtime.inventory, sequence=2,
                         locations={"loc_001": BridgeLocation("loc_001", "Synthetic", "DISARMED")})
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(side_effect=BridgeClientError("command_transition_rearm_failed")),
            async_get_inventory=AsyncMock(return_value=actual),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        with self.assertRaises(Exception):
            await entity.async_alarm_arm_home()
        self.assertEqual(entity.state, "disarmed")
        runtime.client.async_execute_command.assert_awaited_once()
        runtime.client.async_get_inventory.assert_awaited_once()

    async def test_failed_disarm_confirmation_does_not_pretend_to_be_home(self):
        runtime = _runtime(BridgeLocation("loc_001", "Synthetic", "ARMED_AWAY"))
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(side_effect=BridgeClientError("command_transition_disarm_failed")),
            async_get_inventory=AsyncMock(side_effect=BridgeClientError("bridge_request_failed")),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        with self.assertRaises(Exception):
            await entity.async_alarm_arm_home()
        self.assertEqual(entity.state, "armed_away")
        runtime.client.async_execute_command.assert_awaited_once()
        runtime.client.async_get_inventory.assert_awaited_once()

    async def test_old_failure_snapshot_cannot_replace_newer_real_state(self):
        runtime = _runtime(BridgeLocation("loc_001", "Synthetic", "ARMED_STAY"))
        old = replace(runtime.inventory, sequence=1,
                      locations={"loc_001": BridgeLocation("loc_001", "Synthetic", "DISARMED")})
        runtime.inventory = replace(runtime.inventory, sequence=3)
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(side_effect=BridgeClientError("command_transition_rearm_failed")),
            async_get_inventory=AsyncMock(return_value=old),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        with self.assertRaises(Exception):
            await entity.async_alarm_arm_home()
        self.assertEqual(entity.state, "armed_home")
        self.assertEqual(runtime.inventory.sequence, 3)

    async def test_unrelated_error_does_not_add_inventory_reads(self):
        runtime = _runtime(BridgeLocation("loc_001", "Synthetic", "ARMED_AWAY"))
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(side_effect=BridgeClientError("command_control_not_found")),
            async_get_inventory=AsyncMock(),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        with self.assertRaises(Exception):
            await entity.async_alarm_arm_home()
        runtime.client.async_get_inventory.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()

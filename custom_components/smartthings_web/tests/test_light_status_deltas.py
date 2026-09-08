"""Command status deltas use observed values, without reloading 229 devices."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from models import BridgeDevice, BridgeInventory, BridgeState, SmartThingsWebRuntime  # noqa: E402

STAMP = "2026-09-08T00:00:00Z"


def fixture():
    state = BridgeState("main", "colorControl", "hue", 0, None, STAMP)
    lamp = BridgeDevice("dev_300", "loc_001", None, "Fixture light", "light", True,
                        states={state.key: state})
    devices = {lamp.device_id: lamp}
    for index in range(228):
        device = deepcopy(lamp); device.device_id = f"dev_other_{index}"
        devices[device.device_id] = device
    inventory = BridgeInventory(10, True, "1.8.27", "5:test", {}, {}, devices,
                                light_plan_supported=True, light_latest_wins_supported=True)
    client = AsyncMock()
    client.async_get_inventory.side_effect = AssertionError("Unexpected full inventory GET")
    return SmartThingsWebRuntime(client, "loc_001", inventory)


def delta(sequence=11, value=34, stamp=STAMP, verified=True, source="COMMAND_STATUS_RECHECK"):
    return {"schemaVersion": 1, "type": "state", "sequence": sequence, "deviceId": "dev_300",
            "state": {"component": "main", "capability": "colorControl", "attribute": "hue",
                      "value": value, "unit": None, "updatedAt": stamp,
                      "source": source, "commandReadVerified": verified}}


class LightStatusDeltaTests(unittest.IsolatedAsyncioTestCase):
    async def test_corroborated_delta_updates_only_target_and_needs_zero_full_gets(self):
        runtime = fixture(); notifications = []
        runtime.subscribe_device("dev_300", lambda: notifications.append("light"))
        runtime.subscribe_device("dev_other_0", lambda: notifications.append("other"))
        untouched = runtime.inventory.devices["dev_other_0"]
        self.assertTrue(await runtime.handle_event(delta()))
        self.assertEqual(runtime.inventory.devices["dev_300"].states[("main", "colorControl", "hue")].value, 34)
        self.assertIs(runtime.inventory.devices["dev_other_0"], untouched)
        self.assertEqual(notifications, ["light"])
        self.assertEqual(runtime.inventory.sequence, 11)
        runtime.client.async_get_inventory.assert_not_awaited()

    async def test_normal_newer_read_delta_works_without_exceptional_marker(self):
        runtime = fixture()
        self.assertTrue(await runtime.handle_event(delta(stamp="2026-09-08T00:00:01Z", verified=False)))
        runtime.client.async_get_inventory.assert_not_awaited()

    async def test_full_inventory_event_still_resynchronizes(self):
        runtime = fixture(); latest = deepcopy(runtime.inventory); latest.sequence = 11
        runtime.client.async_get_inventory.side_effect = None
        runtime.client.async_get_inventory.return_value = latest
        await runtime.handle_event({"type": "inventory", "sequence": 11})
        runtime.client.async_get_inventory.assert_awaited_once()

    async def test_gap_resynchronization_remains_mandatory(self):
        runtime = fixture(); latest = deepcopy(runtime.inventory); latest.sequence = 11
        runtime.client.async_get_inventory.side_effect = None
        runtime.client.async_get_inventory.return_value = latest
        self.assertTrue(await runtime.handle_event(delta(sequence=12)))
        runtime.client.async_get_inventory.assert_awaited_once()
        self.assertEqual(runtime.inventory.sequence, 12)

    async def test_older_dated_read_cannot_roll_back_current_state(self):
        runtime = fixture()
        self.assertFalse(await runtime.handle_event(delta(stamp="2026-09-07T00:00:00Z")))
        self.assertEqual(runtime.inventory.devices["dev_300"].states[("main", "colorControl", "hue")].value, 0)

    async def test_unverified_equal_timestamp_is_not_authoritative(self):
        for verified, source in ((False, "COMMAND_STATUS_RECHECK"), (True, "LOCATION_EVENT")):
            with self.subTest(verified=verified, source=source):
                runtime = fixture()
                self.assertFalse(await runtime.handle_event(delta(verified=verified, source=source)))

    async def test_missing_feature_negotiation_keeps_old_timestamp_semantics(self):
        runtime = fixture(); runtime.inventory.light_latest_wins_supported = False
        self.assertFalse(await runtime.handle_event(delta()))

    async def test_security_attribute_cannot_use_light_read_exception(self):
        runtime = fixture(); event = delta(value="DISARMED")
        event["state"]["attribute"] = "armState"
        state = BridgeState("main", "colorControl", "armState", "ARMED_AWAY", None, STAMP)
        runtime.inventory.devices["dev_300"].states[state.key] = state
        self.assertFalse(await runtime.handle_event(event))
        self.assertEqual(runtime.inventory.devices["dev_300"].states[state.key].value, "ARMED_AWAY")

    async def test_consecutive_observed_color_channels_and_replay_protection(self):
        runtime = fixture()
        saturation = BridgeState("main", "colorControl", "saturation", 0, None, STAMP)
        runtime.inventory.devices["dev_300"].states[saturation.key] = saturation
        first = delta(); second = delta(sequence=12, value=96); second["state"]["attribute"] = "saturation"
        self.assertTrue(await runtime.handle_event(first))
        self.assertTrue(await runtime.handle_event(second))
        self.assertFalse(await runtime.handle_event(first))
        self.assertEqual(runtime.inventory.sequence, 12)
        runtime.client.async_get_inventory.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()

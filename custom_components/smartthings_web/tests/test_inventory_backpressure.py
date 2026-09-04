"""Regression tests for full-inventory event and registry backpressure."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import (  # noqa: E402
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)


def make_inventory(sequence: int, count: int = 1) -> BridgeInventory:
    devices: dict[str, BridgeDevice] = {}
    for index in range(count):
        device_id = f"dev_{index:03d}"
        temperature = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            20 + index,
            "C",
            "2026-09-04T00:00:00Z",
        )
        battery = BridgeState(
            "main",
            "battery",
            "battery",
            90,
            "%",
            "2026-09-04T00:00:00Z",
        )
        devices[device_id] = BridgeDevice(
            device_id,
            "loc_001",
            None,
            f"Sensor {index}",
            "sensor",
            True,
            states={temperature.key: temperature, battery.key: battery},
            health_updated_at="2026-09-04T00:00:00Z",
        )
    return BridgeInventory(
        sequence,
        True,
        "0.1.175",
        "5",
        {"loc_001": "Home"},
        {},
        devices,
    )


class InventoryBackpressureTests(unittest.TestCase):
    def test_300_device_timestamp_refresh_advances_sequence_without_callbacks(self) -> None:
        current = make_inventory(1, 300)
        latest = deepcopy(current)
        latest.sequence = 2
        for device in latest.devices.values():
            device.health_updated_at = "2026-09-04T00:01:00Z"
            for state in device.states.values():
                state.updated_at = "2026-09-04T00:01:00Z"
        runtime = SmartThingsWebRuntime(object(), "loc_001", current)
        callbacks: list[str] = []
        sample = current.devices["dev_123"]
        state_key = next(iter(sample.states))
        runtime.subscribe(lambda: callbacks.append("global"))
        runtime.subscribe_device("dev_123", lambda: callbacks.append("device"))
        runtime.subscribe_state(
            "dev_123", state_key, lambda: callbacks.append("state")
        )

        changed = runtime.apply_inventory(latest)

        self.assertFalse(changed)
        self.assertEqual(runtime.inventory.sequence, 2)
        self.assertEqual(callbacks, [])
        self.assertEqual(
            runtime.inventory.devices["dev_123"].states[state_key].updated_at,
            "2026-09-04T00:01:00Z",
        )

    def test_one_changed_state_notifies_only_its_state_and_device(self) -> None:
        current = make_inventory(1, 300)
        latest = deepcopy(current)
        latest.sequence = 2
        device = latest.devices["dev_123"]
        temperature_key = ("main", "temperatureMeasurement", "temperature")
        battery_key = ("main", "battery", "battery")
        device.states[temperature_key].value = "invalid"
        for candidate in latest.devices.values():
            candidate.health_updated_at = "2026-09-04T00:01:00Z"
            for state in candidate.states.values():
                state.updated_at = "2026-09-04T00:01:00Z"
        runtime = SmartThingsWebRuntime(object(), "loc_001", current)
        callbacks: list[str] = []
        runtime.subscribe(lambda: callbacks.append("global"))
        runtime.subscribe_device("dev_123", lambda: callbacks.append("device"))
        runtime.subscribe_state(
            "dev_123", temperature_key, lambda: callbacks.append("temperature")
        )
        runtime.subscribe_state(
            "dev_123", battery_key, lambda: callbacks.append("battery")
        )

        changed = runtime.apply_inventory(latest)

        self.assertTrue(changed)
        self.assertCountEqual(callbacks, ["device", "temperature"])

    def test_online_change_notifies_every_state_for_that_device(self) -> None:
        current = make_inventory(1)
        latest = deepcopy(current)
        latest.sequence = 2
        latest.devices["dev_000"].online = False
        latest.devices["dev_000"].health_updated_at = "2026-09-04T00:01:00Z"
        runtime = SmartThingsWebRuntime(object(), "loc_001", current)
        callbacks: list[str] = []
        runtime.subscribe(lambda: callbacks.append("global"))
        runtime.subscribe_device("dev_000", lambda: callbacks.append("device"))
        for state_key in current.devices["dev_000"].states:
            runtime.subscribe_state(
                "dev_000",
                state_key,
                lambda key=state_key: callbacks.append(key[2]),
            )

        changed = runtime.apply_inventory(latest)

        self.assertTrue(changed)
        self.assertCountEqual(
            callbacks,
            ["device", "temperature", "battery"],
        )

    def test_new_state_notifies_global_discovery_once(self) -> None:
        current = make_inventory(1)
        latest = deepcopy(current)
        latest.sequence = 2
        humidity = BridgeState(
            "main",
            "relativeHumidityMeasurement",
            "humidity",
            50,
            "%",
            "2026-09-04T00:01:00Z",
        )
        latest.devices["dev_000"].states[humidity.key] = humidity
        runtime = SmartThingsWebRuntime(object(), "loc_001", current)
        callbacks: list[str] = []
        runtime.subscribe(lambda: callbacks.append("global"))

        changed = runtime.apply_inventory(latest)

        self.assertTrue(changed)
        self.assertEqual(callbacks, ["global"])

    def test_registry_fingerprint_does_not_include_live_value_type(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "__init__.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("type(state.value).__name__", source)


class RuntimeListenerCoalescingTests(unittest.IsolatedAsyncioTestCase):
    async def test_burst_updates_write_one_latest_entity_state(self) -> None:
        inventory = make_inventory(1)
        runtime = SmartThingsWebRuntime(
            object(), "loc_001", inventory, listener_coalesce_ms=25
        )
        key = ("main", "temperatureMeasurement", "temperature")
        callbacks: list[float] = []
        runtime.subscribe_state(
            "dev_000", key,
            lambda: callbacks.append(runtime.inventory.devices["dev_000"].states[key].value),
        )
        for sequence, value in ((2, 21), (3, 22)):
            runtime.apply_state({
                "sequence": sequence,
                "deviceId": "dev_000",
                "state": {
                    "component": "main",
                    "capability": "temperatureMeasurement",
                    "attribute": "temperature",
                    "value": value,
                    "unit": "C",
                    "updatedAt": f"2026-09-05T00:00:0{sequence - 1}Z",
                },
            })
        self.assertEqual(callbacks, [])
        await asyncio.sleep(0.06)
        self.assertEqual(callbacks, [22])


if __name__ == "__main__":
    unittest.main()

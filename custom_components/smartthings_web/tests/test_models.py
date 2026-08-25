"""Regression tests for SmartThings Web runtime event ordering."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import (  # noqa: E402
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
    control_kind,
    entity_unique_id,
    parse_command_result,
    sensor_extra_attributes,
    sensor_native_value,
    sensor_state_allowed,
)


class FakeClient:
    """Return queued full inventories without network access."""

    def __init__(self, *inventories: BridgeInventory) -> None:
        self.inventories = list(inventories)
        self.calls = 0

    async def async_get_inventory(self) -> BridgeInventory:
        self.calls += 1
        return self.inventories.pop(0)


class SmartThingsWebRuntimeTests(unittest.TestCase):
    """Cover reconnect, gap, and stale-event behavior."""

    def test_inventory_marker_fetches_and_atomically_merges_latest_inventory(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(11, 21, "2026-08-24T21:01:00Z")
        client = FakeClient(latest)
        runtime = SmartThingsWebRuntime(client, "loc_001", current)
        observations: list[int] = []
        runtime.subscribe(lambda: observations.append(sensor_value(runtime)))

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11}))

        self.assertTrue(changed)
        self.assertEqual(client.calls, 1)
        self.assertEqual(runtime.inventory.sequence, 11)
        self.assertEqual(sensor_value(runtime), 21)
        self.assertEqual(observations, [21])

    def test_inventory_merge_does_not_lose_devices_from_an_incomplete_restart_snapshot(self) -> None:
        current = inventory(50, 20, "2026-08-24T21:00:00Z")
        partial = BridgeInventory(
            sequence=1,
            ready=False,
            bridge_version="0.1.27",
            protocol_version="1",
            locations={"loc_001": "Home"},
            rooms={},
            devices={},
        )
        runtime = SmartThingsWebRuntime(FakeClient(partial), "loc_001", current)

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 1}))

        self.assertTrue(changed)
        self.assertEqual(runtime.inventory.sequence, 1)
        self.assertIn("dev_001", runtime.inventory.devices)
        self.assertEqual(sensor_value(runtime), 20)

    def test_sequence_gap_immediately_resynchronizes_from_a_full_snapshot(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(12, 22, "2026-08-24T21:02:00Z")
        client = FakeClient(latest)
        runtime = SmartThingsWebRuntime(client, "loc_001", current)

        changed = asyncio.run(
            runtime.handle_event(
                state_event(12, 99, "2026-08-24T21:01:00Z")
            )
        )

        self.assertTrue(changed)
        self.assertEqual(client.calls, 1)
        self.assertEqual(runtime.inventory.sequence, 12)
        self.assertEqual(sensor_value(runtime), 22)

    def test_stale_sequence_and_timestamp_cannot_overwrite_current_state(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )

        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(10, 10, "2026-08-24T21:11:00Z")))
        )
        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(11, 10, "2026-08-24T21:09:00Z")))
        )
        self.assertEqual(runtime.inventory.sequence, 11)
        self.assertEqual(sensor_value(runtime), 20)

    def test_timestamp_without_timezone_is_rejected_and_left_for_gap_resync(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )

        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(11, 99, "2026-08-24T21:11:00")))
        )
        self.assertEqual(runtime.inventory.sequence, 10)
        self.assertEqual(sensor_value(runtime), 20)

    def test_control_kind_keeps_plain_switches_out_of_binary_sensor_and_light(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        switch = BridgeState(
            component="identifier_component_main",
            capability="identifier_capability_switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch}

        self.assertEqual(control_kind(device, switch), "switch")

    def test_control_kind_requires_light_specific_state_evidence(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        switch = BridgeState(
            component="identifier_component_main",
            capability="identifier_capability_switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        color_range = BridgeState(
            component=switch.component,
            capability="identifier_capability_color_temperature",
            attribute="colorTemperatureRange",
            value={"minimum": 2200, "maximum": 6500},
            unit="K",
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch, color_range.key: color_range}

        self.assertEqual(control_kind(device, switch), "light")

    def test_unique_id_contains_attribute_once(self) -> None:
        state = next(iter(inventory(10, 20, "2026-08-24T21:10:00Z").devices["dev_001"].states.values()))

        unique_id = entity_unique_id("dev_001", state)

        self.assertEqual(
            unique_id,
            "dev_001_identifier_component_main_identifier_capability_temperature_temperature",
        )

    def test_generic_sensor_keeps_signal_metrics_and_structured_values(self) -> None:
        self.assertTrue(sensor_state_allowed("signalMetrics"))
        self.assertTrue(sensor_state_allowed("value"))
        self.assertFalse(sensor_state_allowed("contact"))
        self.assertFalse(sensor_state_allowed("switch"))
        self.assertEqual(sensor_native_value("rssi: -61, lqi: 99"), "rssi: -61, lqi: 99")
        structured = {"rssi": -61, "lqi": 99}
        self.assertEqual(sensor_native_value(structured), "data")
        self.assertEqual(sensor_extra_attributes(structured), {"value": structured})

    def test_command_result_accepts_only_push_confirmed_response(self) -> None:
        result = parse_command_result(
            {
                "schemaVersion": 1,
                "clientRequestId": "request_12345678",
                "status": "confirmed",
                "sequence": 42,
                "transport": "smartthings_web_ui",
                "confirmation": "device_event",
            },
            "request_12345678",
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.sequence, 42)
        self.assertEqual(result.confirmation, "device_event")

    def test_command_result_rejects_wrong_request_or_unverified_confirmation(self) -> None:
        base = {
            "schemaVersion": 1,
            "clientRequestId": "request_12345678",
            "status": "confirmed",
            "sequence": 42,
            "transport": "smartthings_web_ui",
            "confirmation": "device_event",
        }

        self.assertIsNone(parse_command_result({**base, "clientRequestId": "other_12345678"}, "request_12345678"))
        self.assertIsNone(parse_command_result({**base, "confirmation": "button_click"}, "request_12345678"))


def inventory(sequence: int, value: int, updated_at: str) -> BridgeInventory:
    state = BridgeState(
        component="identifier_component_main",
        capability="identifier_capability_temperature",
        attribute="temperature",
        value=value,
        unit="C",
        updated_at=updated_at,
    )
    device = BridgeDevice(
        device_id="dev_001",
        location_id="loc_001",
        room_id=None,
        name="Sensor",
        device_type=None,
        online=True,
        states={state.key: state},
    )
    return BridgeInventory(
        sequence=sequence,
        ready=True,
        bridge_version="0.1.27",
        protocol_version="1",
        locations={"loc_001": "Home"},
        rooms={},
        devices={"dev_001": device},
    )


def state_event(sequence: int, value: int, updated_at: str) -> dict[str, object]:
    return {
        "type": "state",
        "sequence": sequence,
        "deviceId": "dev_001",
        "state": {
            "component": "identifier_component_main",
            "capability": "identifier_capability_temperature",
            "attribute": "temperature",
            "value": value,
            "unit": "C",
            "updatedAt": updated_at,
        },
    }


def sensor_value(runtime: SmartThingsWebRuntime) -> int:
    device = runtime.inventory.devices["dev_001"]
    return next(iter(device.states.values())).value


if __name__ == "__main__":
    unittest.main()

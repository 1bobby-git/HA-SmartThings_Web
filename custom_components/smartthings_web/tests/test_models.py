"""Regression tests for SmartThings Web runtime event ordering."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import FrozenInstanceError
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import models as models_module  # noqa: E402

from models import (  # noqa: E402
    BridgeAdvancedDeviceMetadata,
    BridgeCommandArgument,
    BridgeCommandDescriptor,
    BridgeCommandOmission,
    BridgeControl,
    BridgeDevice,
    BridgeDevicePresentation,
    BridgeInventory,
    BridgeLocation,
    BridgeScene,
    BridgeState,
    SmartThingsWebRuntime,
    climate_controls,
    control_kind,
    control_supports_command,
    cover_controls,
    device_model,
    entity_unique_id,
    firmware_states,
    is_climate_device,
    is_cover_device,
    is_fan_device,
    is_image_device,
    is_media_device,
    is_refreshable_device,
    is_readonly_appliance_switch,
    parse_device_presentation,
    refresh_controls,
    toggle_control_for_state,
    _safe_device_asset_url,
    location_arm_state,
    location_name,
    number_controls,
    numeric_range_for,
    option_values,
    parse_control,
    parse_command_result,
    primary_switch_state,
    primary_state_attributes,
    safe_generic_toggle_control,
    select_controls,
    sensor_extra_attributes,
    sensor_native_value,
    sensor_state_allowed,
    sensor_state_owned_by_primary_domain,
    signal_metrics_native_value,
    state_has_entity_value,
    token_values,
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

    def test_matching_inventory_marker_does_not_refetch_the_snapshot(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        client = FakeClient()
        runtime = SmartThingsWebRuntime(client, "loc_001", current)

        changed = asyncio.run(
            runtime.handle_event({"type": "inventory", "sequence": 10})
        )

        self.assertFalse(changed)
        self.assertEqual(client.calls, 0)
        self.assertEqual(runtime.inventory.sequence, 10)

    def test_inventory_merge_updates_device_presentation_atomically(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(11, 21, "2026-08-24T21:01:00Z")
        current.devices["dev_001"].presentation = BridgeDevicePresentation(
            asset_type="contact_sensor",
            icon_url="https://client.smartthings.com/icons/oneui/contact/off",
        )
        latest.devices["dev_001"].presentation = BridgeDevicePresentation(
            asset_type="contact_sensor",
            icon_url="https://client.smartthings.com/icons/oneui/contact/on",
            animation_url="https://app-asset.samsungiotcloud.com/assets/icons/published/contact_sensor/contact_sensor.json",
        )
        runtime = SmartThingsWebRuntime(FakeClient(latest), "loc_001", current)

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11}))

        self.assertTrue(changed)
        self.assertEqual(
            runtime.inventory.devices["dev_001"].presentation,
            latest.devices["dev_001"].presentation,
        )

    def test_inventory_merge_clears_presentation_removed_by_latest_snapshot(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(11, 21, "2026-08-24T21:01:00Z")
        current.devices["dev_001"].presentation = BridgeDevicePresentation(
            asset_type="contact_sensor",
            icon_url="https://client.smartthings.com/icons/oneui/contact/on",
        )
        self.assertIsNone(latest.devices["dev_001"].presentation)
        runtime = SmartThingsWebRuntime(FakeClient(latest), "loc_001", current)

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11}))

        self.assertTrue(changed)
        self.assertIsNone(runtime.inventory.devices["dev_001"].presentation)

    def test_reconnect_inventory_merge_does_not_lose_devices_from_an_incomplete_restart_snapshot(self) -> None:
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

        changed = runtime.apply_reconnect_inventory(partial)

        self.assertTrue(changed)
        self.assertEqual(runtime.inventory.sequence, 1)
        self.assertIn("dev_001", runtime.inventory.devices)
        self.assertEqual(sensor_value(runtime), 20)

    def test_stale_inventory_marker_in_same_epoch_does_not_rewind_or_delete_topology(self) -> None:
        current = inventory(50, 20, "2026-08-24T21:00:00Z")
        stale = inventory(49, 19, "2026-08-24T20:59:00Z")
        stale.devices = {}
        client = FakeClient(stale)
        runtime = SmartThingsWebRuntime(client, "loc_001", current)

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 49}))

        self.assertFalse(changed)
        self.assertEqual(client.calls, 0)
        self.assertEqual(runtime.inventory.sequence, 50)
        self.assertIn("dev_001", runtime.inventory.devices)
        self.assertEqual(sensor_value(runtime), 20)

    def test_ready_reconnect_preserves_selected_location_when_snapshot_omits_every_device(self) -> None:
        spark_state = BridgeState(
            "main",
            "switch",
            "switch",
            "on",
            None,
            "2026-09-03T00:00:00Z",
        )
        current = BridgeInventory(
            sequence=50,
            ready=True,
            bridge_version="0.1.166",
            protocol_version="5",
            locations={"loc_home": "Home", "loc_office": "ExampleOffice"},
            rooms={
                "room_home": ("loc_home", "Living room"),
                "room_spark": ("loc_office", "Office"),
            },
            devices={
                "dev_home": BridgeDevice(
                    "dev_home",
                    "loc_home",
                    "room_home",
                    "Home switch",
                    "switch",
                    True,
                ),
                "dev_office": BridgeDevice(
                    "dev_office",
                    "loc_office",
                    "room_spark",
                    "ExampleOffice switch",
                    "switch",
                    True,
                    states={spark_state.key: spark_state},
                ),
            },
        )
        latest = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.167",
            protocol_version="5",
            locations={"loc_home": "Home", "loc_office": "ExampleOffice"},
            rooms={"room_home": ("loc_home", "Living room")},
            devices={
                "dev_home": BridgeDevice(
                    "dev_home",
                    "loc_home",
                    "room_home",
                    "Home switch",
                    "switch",
                    True,
                )
            },
        )
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_office", current)

        changed = runtime.apply_reconnect_inventory(latest)

        self.assertTrue(changed)
        self.assertEqual(
            set(runtime.inventory.devices),
            {"dev_home", "dev_office"},
        )
        self.assertEqual(
            runtime.inventory.devices["dev_office"].states[spark_state.key].value,
            "on",
        )
        self.assertEqual(
            runtime.inventory.rooms["room_spark"],
            ("loc_office", "Office"),
        )
    def test_reconnect_inventory_snapshot_starts_new_epoch_with_lower_sequence(self) -> None:
        current = inventory(50, 20, "2026-08-24T21:00:00Z")
        restarted = inventory(1, 21, "2026-08-24T21:01:00Z")
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)

        changed = runtime.apply_reconnect_inventory(restarted)

        self.assertTrue(changed)
        self.assertEqual(runtime.inventory.sequence, 1)
        self.assertEqual(sensor_value(runtime), 21)

    def test_ready_inventory_atomically_removes_items_absent_from_latest_snapshot(self) -> None:
        current = inventory(50, 20, "2026-08-24T21:00:00Z")
        stale = BridgeDevice(
            "dev_002",
            "loc_001",
            "room_stale",
            "Removed sensor",
            "sensor",
            True,
        )
        current.devices[stale.device_id] = stale
        current.rooms["room_stale"] = ("loc_001", "Removed room")
        current.scenes["scene_stale"] = BridgeScene(
            "scene_stale",
            "loc_001",
            "Removed scene",
            "2026-08-24T21:00:00Z",
        )
        latest = inventory(51, 21, "2026-08-24T21:01:00Z")
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)

        changed = runtime.apply_inventory(latest)

        self.assertTrue(changed)
        self.assertEqual(runtime.inventory.devices, latest.devices)
        self.assertEqual(runtime.inventory.rooms, latest.rooms)
        self.assertEqual(runtime.inventory.scenes, latest.scenes)

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

    def test_current_next_unknown_device_event_resyncs_once_and_preserves_event_state(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(10, 20, "2026-08-24T21:00:00Z")
        discovered_state = BridgeState(
            "identifier_component_main",
            "identifier_capability_temperature",
            "temperature",
            30,
            "C",
            "2026-08-24T21:00:00Z",
        )
        latest.devices["dev_new"] = BridgeDevice(
            "dev_new",
            "loc_001",
            None,
            "New sensor",
            "sensor",
            True,
            states={discovered_state.key: discovered_state},
        )
        client = FakeClient(latest)
        runtime = SmartThingsWebRuntime(client, "loc_001", current)

        changed = asyncio.run(
            runtime.handle_event(
                {
                    "type": "state",
                    "sequence": 11,
                    "deviceId": "dev_new",
                    "state": {
                        "component": "identifier_component_main",
                        "capability": "identifier_capability_temperature",
                        "attribute": "temperature",
                        "value": 31,
                        "unit": "C",
                        "updatedAt": "2026-08-24T21:01:00Z",
                    },
                }
            )
        )

        self.assertTrue(changed)
        self.assertEqual(client.calls, 1)
        self.assertEqual(runtime.inventory.sequence, 11)
        self.assertEqual(
            runtime.inventory.devices["dev_new"].states[discovered_state.key].value,
            31,
        )

    def test_stale_sequence_and_timestamp_cannot_overwrite_current_state(self) -> None:
        latest = inventory(12, 22, "2026-08-24T21:12:00Z")
        client = FakeClient(latest)
        runtime = SmartThingsWebRuntime(
            client,
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )

        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(10, 10, "2026-08-24T21:11:00Z")))
        )
        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(11, 10, "2026-08-24T21:09:00Z")))
        )
        self.assertEqual(runtime.inventory.sequence, 10)
        self.assertEqual(sensor_value(runtime), 20)

        self.assertTrue(
            asyncio.run(runtime.handle_event(state_event(12, 99, "2026-08-24T21:12:00Z")))
        )
        self.assertEqual(client.calls, 1)
        self.assertEqual(runtime.inventory.sequence, 12)
        self.assertEqual(sensor_value(runtime), 22)

    def test_timestamp_only_scalar_update_advances_sequence_without_entity_write(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        state = next(iter(current.devices["dev_001"].states.values()))
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("global"))
        runtime.subscribe_state("dev_001", state.key, lambda: calls.append("state"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device"))

        changed = runtime.apply_state(
            state_event(11, state.value, "2026-08-24T21:11:00Z")
        )

        self.assertFalse(changed)
        self.assertEqual(runtime.inventory.sequence, 11)
        self.assertEqual(
            runtime.inventory.devices["dev_001"].states[state.key].updated_at,
            "2026-08-24T21:11:00Z",
        )
        self.assertEqual(calls, [])

    def test_signal_metrics_timestamp_update_remains_visible(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        signal = BridgeState(
            "main",
            "signalMetrics",
            "signalMetrics",
            {"lqi": 100, "rssi": -55},
            None,
            "2026-08-24T21:10:00Z",
        )
        current.devices["dev_001"].states = {signal.key: signal}
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        calls: list[int] = []
        runtime.subscribe_state(
            "dev_001",
            signal.key,
            lambda: calls.append(runtime.inventory.sequence),
        )

        changed = runtime.apply_state(
            {
                "type": "state",
                "sequence": 11,
                "deviceId": "dev_001",
                "state": {
                    "component": "main",
                    "capability": "signalMetrics",
                    "attribute": "signalMetrics",
                    "value": {"lqi": 100, "rssi": -55},
                    "updatedAt": "2026-08-24T21:11:00Z",
                },
            }
        )

        self.assertTrue(changed)
        self.assertEqual(calls, [11])

    def test_repeated_button_events_with_the_same_timestamp_keep_each_sequence(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        button = BridgeState(
            "main",
            "button",
            "button",
            "pushed",
            None,
            "2026-08-24T21:11:00Z",
        )
        current.devices["dev_001"].states[button.key] = button
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        calls: list[int] = []
        runtime.subscribe_state(
            "dev_001",
            button.key,
            lambda: calls.append(runtime.inventory.sequence),
        )

        for sequence in (11, 12):
            changed = asyncio.run(
                runtime.handle_event(
                    {
                        "type": "state",
                        "sequence": sequence,
                        "deviceId": "dev_001",
                        "state": {
                            "component": "main",
                            "capability": "button",
                            "attribute": "button",
                            "value": "pushed",
                            "updatedAt": "2026-08-24T21:11:00Z",
                        },
                    }
                )
            )
            self.assertTrue(changed)

        self.assertEqual(calls, [11, 12])

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

    def test_one_failing_entity_listener_does_not_block_other_push_updates(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )
        observations: list[int] = []

        def failing_listener() -> None:
            raise RuntimeError("entity write failed")

        state = next(iter(runtime.inventory.devices["dev_001"].states.values()))
        runtime.subscribe_state("dev_001", state.key, failing_listener)
        runtime.subscribe_state(
            "dev_001", state.key, lambda: observations.append(sensor_value(runtime))
        )

        with self.assertLogs(level="ERROR") as captured:
            changed = asyncio.run(
                runtime.handle_event(state_event(11, 21, "2026-08-24T21:11:00Z"))
            )

        self.assertTrue(changed)
        self.assertEqual(observations, [21])
        self.assertEqual(len(captured.output), 1)
        self.assertEqual(captured.records[0].getMessage(), "runtime_listener_failed")
        self.assertIsNotNone(captured.records[0].exc_info)

    def test_state_push_notifies_only_matching_state_and_device_listeners(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )
        humidity = next(iter(runtime.inventory.devices["dev_001"].states.values()))
        battery = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-24T21:10:00Z",
        )
        runtime.inventory.devices["dev_001"].states[battery.key] = battery
        runtime.inventory.devices["dev_002"] = BridgeDevice(
            "dev_002",
            "loc_001",
            None,
            "Other sensor",
            "sensor",
            True,
            states={battery.key: battery},
        )
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("global"))
        runtime.subscribe_state("dev_001", humidity.key, lambda: calls.append("humidity"))
        runtime.subscribe_state("dev_001", battery.key, lambda: calls.append("battery"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device_1"))
        runtime.subscribe_device("dev_002", lambda: calls.append("device_2"))

        changed = runtime.apply_state(state_event(11, 21, "2026-08-24T21:11:00Z"))

        self.assertTrue(changed)
        self.assertCountEqual(calls, ["humidity", "device_1"])

    def test_new_state_key_runs_discovery_and_its_device_listener_once(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("discovery"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device"))

        changed = runtime.apply_state(
            {
                "type": "state",
                "sequence": 11,
                "deviceId": "dev_001",
                "state": {
                    "component": "main",
                    "capability": "battery",
                    "attribute": "battery",
                    "value": 80,
                    "unit": "%",
                    "updatedAt": "2026-08-24T21:11:00Z",
                },
            }
        )

        self.assertTrue(changed)
        self.assertCountEqual(calls, ["discovery", "device"])

    def test_null_state_becoming_available_runs_discovery(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        firmware = BridgeState(
            "main",
            "firmwareUpdate",
            "currentVersion",
            None,
            None,
            "2026-08-24T21:10:00Z",
        )
        current.devices["dev_001"].states = {firmware.key: firmware}
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("discovery"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device"))

        changed = runtime.apply_state(
            {
                "type": "state",
                "sequence": 11,
                "deviceId": "dev_001",
                "state": {
                    "component": "main",
                    "capability": "firmwareUpdate",
                    "attribute": "currentVersion",
                    "value": "1.0 (100)",
                    "updatedAt": "2026-08-24T21:11:00Z",
                },
            }
        )

        self.assertTrue(changed)
        self.assertCountEqual(calls, ["discovery", "device"])

    def test_inventory_merge_notifies_only_changed_device_subscribers(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        unchanged_state = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-24T21:10:00Z",
        )
        current.devices["dev_002"] = BridgeDevice(
            "dev_002",
            "loc_001",
            None,
            "Other sensor",
            "sensor",
            True,
            states={unchanged_state.key: unchanged_state},
        )
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        changed_state = next(iter(current.devices["dev_001"].states.values()))
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("global"))
        runtime.subscribe_state("dev_001", changed_state.key, lambda: calls.append("state_1"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device_1"))
        runtime.subscribe_state(
            "dev_002", unchanged_state.key, lambda: calls.append("state_2")
        )
        runtime.subscribe_device("dev_002", lambda: calls.append("device_2"))

        latest = inventory(11, 21, "2026-08-24T21:11:00Z")
        latest.devices["dev_002"] = deepcopy(current.devices["dev_002"])
        changed = runtime.apply_inventory(latest)

        self.assertTrue(changed)
        self.assertCountEqual(calls, ["global", "state_1", "device_1"])

    def test_alias_state_event_updates_the_canonical_device(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        current.device_aliases = {"dev_602": "dev_001"}
        runtime = SmartThingsWebRuntime(FakeClient(deepcopy(current)), "loc_001", current)
        state = next(iter(current.devices["dev_001"].states.values()))

        changed = asyncio.run(
            runtime.handle_event({
                "type": "state",
                "sequence": 11,
                "deviceId": "dev_602",
                "state": {
                    "component": state.component,
                    "capability": state.capability,
                    "attribute": state.attribute,
                    "value": 81,
                    "unit": state.unit,
                    "updatedAt": "2026-08-24T21:11:00Z",
                },
            })
        )

        self.assertTrue(changed)
        self.assertEqual(
            runtime.inventory.devices["dev_001"].states[state.key].value,
            81,
        )

    def test_inventory_merge_retains_only_valid_canonical_aliases(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        current.device_aliases = {"dev_602": "dev_001", "dev_stale": "dev_missing"}
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        latest = inventory(11, 21, "2026-08-24T21:11:00Z")
        latest.device_aliases = {"dev_602": "dev_001"}

        runtime.apply_inventory(latest)

        self.assertEqual(runtime.inventory.device_aliases, {"dev_602": "dev_001"})

    def test_inventory_merge_preserves_advanced_identity_and_health_metadata(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        current_device = current.devices["dev_001"]
        current_device.advanced = BridgeAdvancedDeviceMetadata(
            owner_id="identifier_owner",
            execution_context="CLOUD",
        )
        current_device.health_updated_at = "2026-08-24T21:10:00Z"
        latest = inventory(11, 21, "2026-08-24T21:11:00Z")
        latest_device = latest.devices["dev_001"]
        latest_device.advanced = BridgeAdvancedDeviceMetadata(
            owner_id="identifier_owner",
            parent_device_id="dev_parent",
            execution_context="CLOUD",
            linked_device_ids=("dev_602",),
        )
        latest_device.health_updated_at = "2026-08-24T21:11:00Z"
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)

        runtime.apply_inventory(latest)

        merged = runtime.inventory.devices["dev_001"]
        self.assertEqual(merged.advanced, latest_device.advanced)
        self.assertEqual(merged.health_updated_at, "2026-08-24T21:11:00Z")

    def test_inventory_merge_preserves_command_catalog_and_omissions(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        latest = inventory(11, 21, "2026-08-24T21:11:00Z")
        argument = BridgeCommandArgument(
            name="phrase",
            required=True,
            sensitive=False,
            unit="text",
            schema={"type": "string", "enum": ["Hello"]},
        )
        latest.devices["dev_001"].commands = (
            BridgeCommandDescriptor(
                component="main",
                component_role="main",
                capability="speechSynthesis",
                capability_version=1,
                command="speak",
                arguments=(argument,),
                transport="advanced",
                confirmation="accepted_receipt",
                label="Speak",
                label_source="visible_web",
            ),
        )
        latest.devices["dev_001"].command_omissions = (
            BridgeCommandOmission(
                component="main",
                capability="speechSynthesis",
                command="speak",
                reason="sensitive_argument",
            ),
        )
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)

        runtime.apply_inventory(latest)

        merged = runtime.inventory.devices["dev_001"]
        self.assertEqual(merged.commands[0].arguments[0].schema["enum"], ["Hello"])
        self.assertEqual(
            merged.command_omissions,
            (
                BridgeCommandOmission(
                    component="main",
                    capability="speechSynthesis",
                    command="speak",
                    reason="sensitive_argument",
                ),
            ),
        )
        latest.devices["dev_001"].commands[0].arguments[0].schema["enum"].append("mutated")
        self.assertEqual(merged.commands[0].arguments[0].schema["enum"], ["Hello"])

    def test_command_catalog_models_are_frozen(self) -> None:
        argument = BridgeCommandArgument(
            name="phrase",
            required=True,
            sensitive=False,
            unit=None,
            schema={"type": "string"},
        )
        descriptor = BridgeCommandDescriptor(
            component="main",
            component_role="main",
            capability="speechSynthesis",
            capability_version=1,
            command="speak",
            arguments=(argument,),
            transport="advanced",
            confirmation="accepted_receipt",
            label="Speak",
            label_source="capability",
        )

        with self.assertRaises(FrozenInstanceError):
            argument.name = "other"  # type: ignore[misc]
        with self.assertRaises(FrozenInstanceError):
            descriptor.command = "other"  # type: ignore[misc]

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
        device.controls = {
            "action:main:switch": BridgeControl(
                "action:main:switch",
                "toggle",
                "Power",
                component=switch.component,
                capability=switch.capability,
                attribute=switch.attribute,
                commands=("on", "off"),
            )
        }

        self.assertEqual(control_kind(device, switch), "switch")

    def test_control_kind_avoids_duplicate_power_for_media_and_fan_devices(self) -> None:
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
        playback = BridgeState(
            component="main",
            capability="media",
            attribute="playbackStatus",
            value="paused",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        volume = BridgeState(
            component="main",
            capability="audioVolume",
            attribute="volume",
            value=20,
            unit="%",
            updated_at="2026-08-24T21:10:00Z",
        )
        mute = BridgeState(
            component="main",
            capability="audioMute",
            attribute="mute",
            value="unmuted",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch, playback.key: playback, volume.key: volume, mute.key: mute}

        self.assertIsNone(control_kind(device, switch))

    def test_control_kind_keeps_appliance_power_state_read_only(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.device_type = "dryer"
        device.presentation = BridgeDevicePresentation(asset_type="dryer")
        switch = BridgeState(
            component="main",
            capability="switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch}

        self.assertIsNone(control_kind(device, switch))

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
        device.controls = {
            "action:main:switch": BridgeControl(
                "action:main:switch",
                "toggle",
                "Power",
                component=switch.component,
                capability=switch.capability,
                attribute=switch.attribute,
                commands=("on", "off"),
            )
        }

        self.assertEqual(control_kind(device, switch), "light")

    def test_control_kind_accepts_advanced_reversible_switch_catalog_control(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        switch = BridgeState(
            component="main",
            capability="switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch}
        device.controls = {
            "advanced:main:switch:switch": BridgeControl(
                "advanced:main:switch:switch",
                "toggle",
                "Power",
                component=switch.component,
                capability=switch.capability,
                attribute=switch.attribute,
                commands=("on", "off"),
                transport="advanced",
            )
        }

        self.assertEqual(control_kind(device, switch), "switch")

    def test_single_switch_role_state_is_primary_with_web_power_name(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        state = BridgeState(
            "identifier_component_switch",
            "identifier_capability_switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
            component_role="Switch",
        )
        device.states = {state.key: state}
        device.controls = {
            "advanced:switch:switch:switch": BridgeControl(
                "advanced:switch:switch:switch",
                "toggle",
                "Power",
                component=state.component,
                capability=state.capability,
                attribute=state.attribute,
                commands=("on", "off"),
                transport="advanced",
            )
        }

        self.assertEqual(control_kind(device, state), "switch")
        self.assertTrue(primary_switch_state(device, state))
        self.assertEqual(
            models_module.switch_name_overrides(device),
            {state.key: "전원"},
        )
        self.assertEqual(models_module.secondary_switch_name_overrides(device), {})

    def test_control_kind_accepts_advanced_reversible_light_only_with_light_evidence(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        switch = BridgeState(
            component="main",
            capability="switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        level = BridgeState(
            component="main",
            capability="switchLevel",
            attribute="level",
            value=20,
            unit="%",
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch, level.key: level}
        device.controls = {
            "advanced:main:switch:switch": BridgeControl(
                "advanced:main:switch:switch",
                "toggle",
                "Power",
                component=switch.component,
                capability=switch.capability,
                attribute=switch.attribute,
                commands=("on", "off"),
                transport="advanced",
            ),
            "advanced:main:switchLevel:level": BridgeControl(
                "advanced:main:switchLevel:level",
                "slider",
                "Level",
                component=level.component,
                capability=level.capability,
                attribute=level.attribute,
                commands=("setLevel",),
                transport="advanced",
            ),
        }

        self.assertEqual(control_kind(device, switch), "light")

    def test_same_component_switches_use_distinct_web_labels(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        power = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        status = BridgeState(
            "main",
            "yjswitchstatus",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.name = "멀티탭"
        device.device_type = "outlet_1"
        device.states = {power.key: power, status.key: status}
        device.controls = {
            "power": BridgeControl(
                "power",
                "toggle",
                "Power",
                component=power.component,
                capability=power.capability,
                attribute=power.attribute,
                commands=("on", "off"),
            ),
            "status": BridgeControl(
                "status",
                "toggle",
                "yjswitchstatus",
                component=status.component,
                capability=status.capability,
                attribute=status.attribute,
                commands=("on", "off"),
            ),
        }

        self.assertEqual(
            models_module.switch_name_overrides(device),
            {
                power.key: "전원",
                status.key: "장치 상태",
            },
        )

    def test_same_component_advanced_switches_use_web_detail_labels(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        power = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        status = BridgeState(
            "main",
            "yjswitchstatus",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.name = "멀티탭"
        device.device_type = "outlet_1"
        device.states = {power.key: power, status.key: status}
        device.controls = {
            "advanced:main:switch:switch": BridgeControl(
                "advanced:main:switch:switch",
                "toggle",
                "on",
                component=power.component,
                capability=power.capability,
                attribute=power.attribute,
                commands=("on", "off"),
                transport="advanced",
            ),
            "identifier_power": BridgeControl(
                "identifier_power",
                "toggle",
                "Power",
                component=power.component,
                capability=power.capability,
                attribute=power.attribute,
                commands=("on", "off"),
            ),
            "advanced:main:yjswitchstatus:switch": BridgeControl(
                "advanced:main:yjswitchstatus:switch",
                "toggle",
                "on",
                component=status.component,
                capability=status.capability,
                attribute=status.attribute,
                commands=("on", "off"),
                transport="advanced",
            ),
            "identifier_status": BridgeControl(
                "identifier_status",
                "toggle",
                "yjswitchstatus",
                component=status.component,
                capability=status.capability,
                attribute=status.attribute,
                commands=("on", "off"),
            ),
        }

        power_control = toggle_control_for_state(device, power)
        status_control = toggle_control_for_state(device, status)

        self.assertIsNotNone(power_control)
        self.assertIsNotNone(status_control)
        self.assertEqual(power_control.control_id, "advanced:main:switch:switch")
        self.assertEqual(
            status_control.control_id,
            "advanced:main:yjswitchstatus:switch",
        )
        self.assertEqual(control_kind(device, power), "switch")
        self.assertEqual(control_kind(device, status), "switch")
        self.assertEqual(
            models_module.switch_name_overrides(device),
            {
                power.key: "전원",
                status.key: "장치 상태",
            },
        )

    def test_duplicate_advanced_switch_controls_remain_ambiguous(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        state = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.states = {state.key: state}
        device.controls = {
            "advanced:main:switch:switch": BridgeControl(
                "advanced:main:switch:switch",
                "toggle",
                "on",
                component=state.component,
                capability=state.capability,
                attribute=state.attribute,
                commands=("on", "off"),
                transport="advanced",
            ),
            "advanced:main:switch:switch:duplicate": BridgeControl(
                "advanced:main:switch:switch:duplicate",
                "toggle",
                "on",
                component=state.component,
                capability=state.capability,
                attribute=state.attribute,
                commands=("on", "off"),
                transport="advanced",
            ),
            "identifier_power": BridgeControl(
                "identifier_power",
                "toggle",
                "Power",
                component=state.component,
                capability=state.capability,
                attribute=state.attribute,
                commands=("on", "off"),
            ),
        }

        self.assertIsNone(toggle_control_for_state(device, state))
        self.assertIsNone(control_kind(device, state))

    def test_action_control_stays_preferred_over_advanced_duplicate(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        state = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.states = {state.key: state}
        device.controls = {
            "action:main:switch": BridgeControl(
                "action:main:switch",
                "toggle",
                "Power",
                component=state.component,
                capability=state.capability,
                attribute=state.attribute,
                commands=("on", "off"),
            ),
            "advanced:main:switch:switch": BridgeControl(
                "advanced:main:switch:switch",
                "toggle",
                "on",
                component=state.component,
                capability=state.capability,
                attribute=state.attribute,
                commands=("on", "off"),
                transport="advanced",
            ),
        }

        self.assertEqual(
            toggle_control_for_state(device, state).control_id,
            "action:main:switch",
        )
        self.assertEqual(control_kind(device, state), "switch")

    def test_main_switch_capability_supplies_power_label_when_control_label_blank(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        power = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        status = BridgeState(
            "main",
            "yjswitchstatus",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.states = {power.key: power, status.key: status}
        device.controls = {
            "power": BridgeControl(
                "power",
                "toggle",
                "",
                component=power.component,
                capability=power.capability,
                attribute=power.attribute,
                commands=("on", "off"),
            ),
            "status": BridgeControl(
                "status",
                "toggle",
                "yjswitchstatus",
                component=status.component,
                capability=status.capability,
                attribute=status.attribute,
                commands=("on", "off"),
            ),
        }

        self.assertEqual(
            models_module.switch_name_overrides(device),
            {
                power.key: "전원",
                status.key: "장치 상태",
            },
        )

    def test_switch_name_overrides_keep_safe_unknown_web_label(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        heater = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.states = {heater.key: heater}
        device.controls = {
            "heater": BridgeControl(
                "heater",
                "toggle",
                "Coffee Heater",
                component=heater.component,
                capability=heater.capability,
                attribute=heater.attribute,
                commands=("on", "off"),
            )
        }

        self.assertEqual(
            models_module.switch_name_overrides(device),
            {heater.key: "Coffee Heater"},
        )

    def test_switch_name_overrides_reject_unsafe_web_label_and_fallback(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        state = BridgeState(
            "heater",
            "customAux",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.states = {state.key: state}
        device.controls = {
            "unsafe": BridgeControl(
                "unsafe",
                "toggle",
                "Coffee\nHeater",
                component=state.component,
                capability=state.capability,
                attribute=state.attribute,
                commands=("on", "off"),
            )
        }

        self.assertEqual(
            models_module.switch_name_overrides(device),
            {state.key: "Heater"},
        )

    def test_switch_name_overrides_disambiguate_duplicate_generated_labels(self) -> None:
        current = inventory(10, 20, "2026-09-01T00:00:00Z")
        device = current.devices["dev_001"]
        left = BridgeState(
            "outlet",
            "custom.leftSwitch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        right = BridgeState(
            "outlet",
            "custom.rightSwitch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device.states = {left.key: left, right.key: right}
        device.controls = {
            "left": BridgeControl(
                "left",
                "toggle",
                "",
                component=left.component,
                capability=left.capability,
                attribute=left.attribute,
                commands=("on", "off"),
            ),
            "right": BridgeControl(
                "right",
                "toggle",
                "",
                component=right.component,
                capability=right.capability,
                attribute=right.attribute,
                commands=("on", "off"),
            ),
        }

        self.assertEqual(
            models_module.switch_name_overrides(device),
            {
                left.key: "Outlet (Custom.Left Switch)",
                right.key: "Outlet (Custom.Right Switch)",
            },
        )

    def test_parse_control_rejects_unsupported_transport_value(self) -> None:
        self.assertIsNone(
            parse_control(
                {
                    "id": "advanced:main:switch:switch",
                    "kind": "toggle",
                    "label": "Power",
                    "component": "main",
                    "capability": "switch",
                    "attribute": "switch",
                    "commands": ["on", "off"],
                    "transport": "browser_dom",
                }
            )
        )

    def test_parse_control_rejects_non_string_transport_value(self) -> None:
        for transport in (["advanced"], {"name": "advanced"}, 123, True):
            with self.subTest(transport=transport):
                self.assertIsNone(
                    parse_control(
                        {
                            "id": "advanced:main:switch:switch",
                            "kind": "toggle",
                            "label": "Power",
                            "component": "main",
                            "capability": "switch",
                            "attribute": "switch",
                            "commands": ["on", "off"],
                            "transport": transport,
                        }
                    )
                )

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
        self.assertEqual(
            signal_metrics_native_value(structured, "2026-04-01T11:28:55Z"),
            "KST-9: 2026/04/01 11:28 LQI: 99 RSSI: -61dbm",
        )
        self.assertEqual(sensor_extra_attributes(structured), {"value": structured})

    def test_play_track_control_label_does_not_match_plain_play(self) -> None:
        play = BridgeControl("play", "button", "Play", commands=("play",))
        play_track = BridgeControl(
            "track", "button", "Play track and resume", commands=()
        )

        self.assertFalse(control_supports_command(play, "playTrackAndResume"))
        self.assertTrue(control_supports_command(play_track, "playTrackAndResume"))

    def test_locations_and_scenes_merge_without_stale_metadata_overwrite(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        current.locations["loc_001"] = BridgeLocation(
            "loc_001", "Home", "armedAway", "2026-08-24T21:10:00Z"
        )
        current.scenes["scene_001"] = BridgeScene(
            "scene_001", "loc_001", "Movie", "2026-08-24T21:10:00Z"
        )
        latest = inventory(11, 21, "2026-08-24T21:11:00Z")
        latest.locations["loc_001"] = BridgeLocation(
            "loc_001", "Home", "disarmed", "2026-08-24T21:09:00Z"
        )
        latest.scenes["scene_001"] = BridgeScene(
            "scene_001", "loc_001", "Old Movie", "2026-08-24T21:09:00Z"
        )
        runtime = SmartThingsWebRuntime(FakeClient(latest), "loc_001", current)

        self.assertTrue(asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11})))

        self.assertEqual(location_name(runtime.inventory, "loc_001"), "Home")
        self.assertEqual(location_arm_state(runtime.inventory, "loc_001"), "armedAway")
        self.assertEqual(runtime.inventory.scenes["scene_001"].name, "Movie")

    def test_capability_helpers_identify_added_platform_surfaces(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "Home Camera 360"
        device.device_type = "camera_security"
        states = [
            BridgeState("main", "signal", "signalMetrics", {"rssi": -61}, None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "media", "playbackStatus", "playing", None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "media", "volume", 20, "%", "2026-08-24T21:10:00Z"),
            BridgeState("main", "media", "mute", "unmuted", None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "fan", "fanMode", "auto", None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "fan", "level", 50, "%", "2026-08-24T21:10:00Z"),
            BridgeState("main", "camera", "image", "data", None, "2026-08-24T21:10:00Z"),
        ]
        device.states = {state.key: state for state in states}
        device.controls = {
            "refresh_button": BridgeControl(
                "refresh_button", "button", "Refresh", commands=("refresh",)
            )
        }

        self.assertTrue(is_refreshable_device(device))
        self.assertTrue(is_media_device(device))
        self.assertTrue(is_fan_device(device))
        self.assertTrue(is_image_device(device))

    def test_primary_domain_ownership_keeps_unrelated_state_sensors(self) -> None:
        def state(
            component: str,
            capability: str,
            attribute: str,
            value: object,
            unit: str | None = None,
            *,
            role: str | None = None,
        ) -> BridgeState:
            return BridgeState(
                component,
                capability,
                attribute,
                value,
                unit,
                "2026-08-28T00:00:00Z",
                component_role=role,
            )

        def device(
            device_id: str,
            name: str,
            device_type: str,
            *,
            asset_type: str | None = None,
        ) -> BridgeDevice:
            return BridgeDevice(
                device_id,
                "loc_001",
                None,
                name,
                device_type,
                True,
                presentation=(
                    BridgeDevicePresentation(asset_type=asset_type)
                    if asset_type
                    else None
                ),
            )

        cases = [
            (
                "speaker",
                device("speaker_001", "Kitchen Speaker", "speaker"),
                state("main", "audioVolume", "volume", 15, "%"),
                state("main", "battery", "battery", 81, "%"),
                [state("main", "audioMute", "mute", "unmuted")],
            ),
            (
                "camera",
                device("camera_001", "Home Camera", "camera_security"),
                state("main", "imageCapture", "image", "metadata"),
                state(
                    "main",
                    "legendabsolute60149.signalMetrics",
                    "signalMetrics",
                    {"rssi": -63, "lqi": 99},
                ),
                [],
            ),
            (
                "fan-like appliance",
                device("purifier_001", "Air Purifier", "air_purifier"),
                state("main", "fanMode", "fanMode", "auto"),
                state("main", "dustSensor", "fineDustLevel", 7, "ug/m3"),
                [],
            ),
            (
                "refrigerator/freezer",
                device("fridge_001", "Kitchen Refrigerator", "refrigerator"),
                state("main", "thermostatMode", "thermostatMode", "cool"),
                state(
                    "identifier_component_freezer",
                    "temperatureMeasurement",
                    "temperature",
                    -18,
                    "C",
                    role="freezer",
                ),
                [
                    state(
                        "identifier_component_fridge",
                        "temperatureMeasurement",
                        "temperature",
                        3,
                        "C",
                        role="fridge",
                    )
                ],
            ),
            (
                "hub",
                device("hub_001", "SmartThings Hub", "hub"),
                state("main", "healthCheck", "healthStatus", "online"),
                state(
                    "main",
                    "legendabsolute60149.signalMetrics",
                    "signalMetrics",
                    {"rssi": -55, "lqi": 100},
                ),
                [],
            ),
            (
                "sensor",
                device("sensor_001", "Multipurpose Sensor", "multipurpose_sensor_1"),
                state("main", "contactSensor", "contact", "closed"),
                state("main", "battery", "battery", 92, "%"),
                [],
            ),
            (
                "dryer",
                device("dryer_001", "Laundry Dryer", "dryer", asset_type="dryer"),
                state("main", "switch", "switch", "off"),
                state("main", "dryerOperatingState", "machineState", "stop"),
                [],
            ),
            (
                "dishwasher",
                device(
                    "dishwasher_001",
                    "Dishwasher",
                    "dishwasher",
                    asset_type="dishwasher",
                ),
                state("main", "switch", "switch", "off"),
                state("main", "dishwasherOperatingState", "machineState", "ready"),
                [],
            ),
        ]

        for label, current_device, primary, retained, extra in cases:
            with self.subTest(case=label):
                states = [primary, retained, *extra]
                current_device.states = {item.key: item for item in states}

                self.assertFalse(
                    sensor_state_owned_by_primary_domain(current_device, retained)
                )
                self.assertTrue(
                    sensor_state_allowed(
                        retained.attribute,
                        image_device=is_image_device(current_device),
                    )
                )
                attributes = primary_state_attributes(
                    current_device, {retained.attribute}
                )
                expected_count = sum(
                    1 for item in states if item.attribute == retained.attribute
                )
                self.assertEqual(len(attributes), expected_count)
                self.assertIn(retained.value, attributes.values())

    def test_representative_devices_keep_expected_domain_classification(self) -> None:
        cases = [
            ("dryer", "dryer", False, False, False, False, False, True),
            ("dishwasher", "dishwasher", False, False, False, False, False, True),
            ("refrigerator", "refrigerator", False, False, False, False, False, False),
            ("hub", "hub", False, False, False, False, False, False),
            ("sensor", "multipurpose_sensor_1", False, False, False, False, False, False),
            ("speaker", "speaker", True, False, False, False, False, False),
            ("camera", "camera_security", False, True, False, False, False, False),
            ("air purifier", "air_purifier", False, False, True, False, False, False),
        ]

        for (
            label,
            device_type,
            media,
            image,
            fan,
            cover,
            climate,
            readonly_power,
        ) in cases:
            with self.subTest(device=label):
                device = BridgeDevice(
                    f"{label.replace(' ', '_')}_001",
                    "loc_001",
                    None,
                    label.title(),
                    device_type,
                    True,
                    presentation=BridgeDevicePresentation(asset_type=device_type),
                )
                states = [
                    BridgeState(
                        "main",
                        "battery",
                        "battery",
                        80,
                        "%",
                        "2026-08-28T00:00:00Z",
                    )
                ]
                if media:
                    states.extend(
                        [
                            BridgeState(
                                "main",
                                "audioVolume",
                                "volume",
                                20,
                                "%",
                                "2026-08-28T00:00:00Z",
                            ),
                            BridgeState(
                                "main",
                                "audioMute",
                                "mute",
                                "unmuted",
                                None,
                                "2026-08-28T00:00:00Z",
                            ),
                        ]
                    )
                if image:
                    states.append(
                        BridgeState(
                            "main",
                            "imageCapture",
                            "image",
                            "metadata",
                            None,
                            "2026-08-28T00:00:00Z",
                        )
                    )
                if fan:
                    states.append(
                        BridgeState(
                            "main",
                            "fanMode",
                            "fanMode",
                            "auto",
                            None,
                            "2026-08-28T00:00:00Z",
                        )
                    )
                device.states = {state.key: state for state in states}

                self.assertEqual(is_media_device(device), media)
                self.assertEqual(is_image_device(device), image)
                self.assertEqual(is_fan_device(device), fan)
                self.assertEqual(is_cover_device(device), cover)
                self.assertEqual(is_climate_device(device), climate)
                self.assertEqual(is_readonly_appliance_switch(device), readonly_power)

    def test_window_sensor_image_artifacts_do_not_create_camera_or_metadata_sensors(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "거실창문센서"
        device.device_type = "NONE"
        device.presentation = BridgeDevicePresentation(asset_type="custom_window_h")
        states = [
            BridgeState("main", "contactSensor", "contact", "closed", None, "2026-08-25T02:11:34Z"),
            BridgeState("main", "battery", "battery", 91, "%", "2026-04-01T17:21:43Z"),
            BridgeState(
                "main",
                "legendabsolute60149.signalMetrics",
                "signalMetrics",
                "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm",
                None,
                "2026-04-01T11:28:55Z",
            ),
            BridgeState("main", "imageCapture", "image", "stale", None, "2026-04-01T11:28:55Z"),
            BridgeState(
                "main",
                "imageCapture",
                "imageTransferProgress",
                100,
                "%",
                "2026-04-01T11:28:55Z",
            ),
        ]
        device.states = {state.key: state for state in states}

        self.assertFalse(is_image_device(device))
        self.assertFalse(sensor_state_allowed("image", image_device=False))
        self.assertFalse(sensor_state_allowed("imageTransferProgress", image_device=False))
        self.assertTrue(sensor_state_allowed("battery", image_device=False))
        self.assertTrue(sensor_state_allowed("signalMetrics", image_device=False))
        self.assertTrue(state_has_entity_value(states[0]))
        self.assertFalse(
            state_has_entity_value(
                BridgeState(
                    "main",
                    "firmwareUpdate",
                    "currentVersion",
                    None,
                    None,
                    "2026-04-01T11:28:55Z",
                )
            )
        )
        self.assertEqual(
            sensor_native_value(states[2].value),
            "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm",
        )

    def test_null_firmware_states_do_not_create_update_capability(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        states = [
            BridgeState(
                "main",
                "firmwareUpdate",
                "currentVersion",
                None,
                None,
                "2026-04-01T11:28:55Z",
            ),
            BridgeState(
                "main",
                "firmwareUpdate",
                "availableVersion",
                None,
                None,
                "2026-04-01T11:28:55Z",
            ),
        ]
        device.states = {state.key: state for state in states}

        self.assertEqual(firmware_states(device), {})

    def test_camera_identity_preserves_single_image_state(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "홈카메라 360"
        device.device_type = "NONE"
        image = BridgeState(
            "main", "imageCapture", "image", "metadata", None, "2026-08-25T03:16:00Z"
        )
        device.states = {image.key: image}

        self.assertTrue(is_image_device(device))
        self.assertFalse(sensor_state_allowed("image", image_device=True))
        self.assertTrue(sensor_state_allowed("captureTime", image_device=True))
        self.assertTrue(sensor_state_allowed("imageTransferProgress", image_device=True))
        self.assertTrue(sensor_state_allowed("clip", image_device=True))
        self.assertTrue(sensor_state_allowed("stream", image_device=True))

    def test_audio_volume_without_mute_is_not_a_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "아리"
        device.device_type = "accessory"
        device.presentation = BridgeDevicePresentation(
            asset_type="accessory",
            icon_url=None,
            inactive_icon_url=None,
            animation_url=None,
        )
        states = [
            BridgeState("main", "audioVolume", "volume", 25, "%", "2026-08-24T21:10:00Z"),
        ]
        device.states = {state.key: state for state in states}
        device.controls = {
            "volume": BridgeControl(
                "volume",
                "slider",
                "Volume",
                component="main",
                capability="audioVolume",
                attribute="volume",
                minimum=0,
                maximum=100,
            ),
        }

        self.assertFalse(is_media_device(device))
        self.assertIsNone(control_kind(device, states[0]))

    def test_mute_without_volume_is_not_a_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "거실 가습기"
        device.device_type = "humidifier"
        states = [
            BridgeState("main", "audioMute", "mute", "unmuted", None, "2026-08-24T21:10:00Z"),
        ]
        device.states = {state.key: state for state in states}
        device.controls = {
            "mute": BridgeControl(
                "mute",
                "toggle",
                "Mute",
                component="main",
                capability="audioMute",
                attribute="mute",
                commands=("mute", "unmute"),
            )
        }

        self.assertFalse(is_media_device(device))

    def test_volume_and_mute_keep_speakers_as_media_players(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "거실 스피커"
        device.device_type = "speaker"
        states = [
            BridgeState("main", "audioMute", "mute", "unmuted", None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "audioVolume", "volume", 25, "%", "2026-08-24T21:10:00Z"),
        ]
        device.states = {state.key: state for state in states}

        self.assertTrue(is_media_device(device))

    def test_accessory_with_alarm_volume_and_mute_is_not_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "아리"
        device.device_type = "accessory"
        device.presentation = BridgeDevicePresentation(asset_type="smart_tag_2")
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            6,
            None,
            "2026-08-24T21:10:00Z",
        )
        mute = BridgeState(
            "main",
            "audioMute",
            "mute",
            "unmuted",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {volume.key: volume, mute.key: mute}
        device.controls = {
            "alarm_volume": BridgeControl(
                "alarm_volume",
                "slider",
                "Alarm volume",
                component="main",
                capability="audioVolume",
                attribute="volume",
                minimum=1,
                maximum=10,
                step=1,
            ),
            "alarm_mute": BridgeControl(
                "alarm_mute",
                "toggle",
                "Alarm mute",
                component="main",
                capability="audioMute",
                attribute="mute",
                commands=("mute", "unmute"),
            ),
        }

        self.assertFalse(is_media_device(device))
        self.assertEqual([control.control_id for control in number_controls(device)], ["alarm_volume"])
        self.assertFalse(sensor_state_owned_by_primary_domain(device, volume))

    def test_plain_audio_accessory_volume_and_mute_is_not_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "아리"
        device.device_type = "accessory"
        device.presentation = BridgeDevicePresentation(asset_type="accessory")
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            6,
            None,
            "2026-08-24T21:10:00Z",
        )
        mute = BridgeState(
            "main",
            "audioMute",
            "mute",
            "unmuted",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {volume.key: volume, mute.key: mute}

        self.assertFalse(is_media_device(device))

    def test_galaxy_home_mini_identity_keeps_volume_and_mute_as_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "갤럭시 홈 미니"
        device.device_type = "ai_speaker_lux_one"
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            20,
            "%",
            "2026-08-24T21:10:00Z",
        )
        mute = BridgeState(
            "main",
            "audioMute",
            "mute",
            "unmuted",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {volume.key: volume, mute.key: mute}

        self.assertTrue(is_media_device(device))

    def test_refresh_controls_only_use_button_controls_with_refresh_mention(self) -> None:
        battery_state = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Camera",
            "camera",
            True,
            controls={
                "refresh": BridgeControl(
                    "refresh",
                    "button",
                    "Refresh",
                    commands=("refresh",),
                ),
                "not_refresh": BridgeControl(
                    "not_refresh",
                    "button",
                    "Refresh",
                    commands=(),
                ),
                "slider": BridgeControl(
                    "level",
                    "slider",
                    "Level",
                    minimum=0,
                    maximum=100,
                ),
            },
            states={battery_state.key: battery_state},
        )

        controls = [control.control_id for control in refresh_controls(device)]
        self.assertEqual(controls, ["refresh"])

    def test_is_refreshable_device_depends_on_observed_refresh_control(self) -> None:
        image_state = BridgeState(
            "main",
            "camera",
            "image",
            "data",
            None,
            "2026-08-24T21:10:00Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Camera",
            "camera",
            True,
            controls={
                "battery_only": BridgeControl(
                    "battery_only",
                    "value",
                    "Battery",
                )
            },
            states={image_state.key: image_state},
        )

        self.assertFalse(is_refreshable_device(device))

    def test_refresh_control_with_unsafe_fields_is_rejected_by_url_guard(self) -> None:
        self.assertIsNone(
            _safe_device_asset_url("https://example.com/icons/oneui/contact/on", animation=False)
        )
        parsed = parse_device_presentation(
            {
                "assetType": "oneui",
                "iconUrl": "https://client.smartthings.com/icons/oneui/contact/on",
                "inactiveIconUrl": "https://example.com/icons/oneui/contact/off",
            }
        )
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(
            parsed.icon_url, "https://client.smartthings.com/icons/oneui/contact/on"
        )
        self.assertIsNone(parsed.inactive_icon_url)
        self.assertEqual(parsed.inactive_icon_url, None)

    def test_number_range_and_options_parse_normalized_metadata(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        frequency = BridgeState(
            "main",
            "motion",
            "detectionFrequency",
            30,
            "s",
            "2026-08-24T21:10:00Z",
        )
        range_state = BridgeState(
            "main",
            "motion",
            "detectionFrequencyRange",
            {"minimum": 10, "maximum": 120, "step": 5},
            "s",
            "2026-08-24T21:10:00Z",
        )
        device.states = {frequency.key: frequency, range_state.key: range_state}

        self.assertEqual(numeric_range_for(device, frequency), (10.0, 120.0, 5.0))
        self.assertEqual(option_values({"values": [{"value": "auto"}, {"name": "sleep"}]}), ["auto", "sleep"])

    def test_number_controls_keep_numeric_sliders_without_range_metadata(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        frequency = BridgeState(
            "main",
            "motion",
            "detectionFrequency",
            45,
            "s",
            "2026-08-24T21:10:00Z",
        )
        fan_speed = BridgeState(
            "main",
            "fanSpeed",
            "fanSpeed",
            40,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.states = {frequency.key: frequency, fan_speed.key: fan_speed}
        device.controls = {
            "detection_frequency": BridgeControl(
                "detection_frequency",
                "slider",
                "Detection Frequency",
                component="main",
                capability="motion",
                attribute="detectionFrequency",
            ),
            "fan_speed": BridgeControl(
                "fan_speed",
                "slider",
                "Fan Speed",
                component="main",
                capability="fanSpeed",
                attribute="fanSpeed",
            ),
        }

        self.assertEqual(
            [control.control_id for control in number_controls(device)],
            ["detection_frequency", "fan_speed"],
        )
        self.assertEqual(numeric_range_for(device, frequency), (0.0, 3600.0, 1.0))
        self.assertEqual(numeric_range_for(device, fan_speed), (0.0, 100.0, 1.0))

    def test_number_controls_reject_missing_range_when_state_is_not_numeric(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        mode = BridgeState(
            "main",
            "custom",
            "customValue",
            "auto",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {mode.key: mode}
        device.controls = {
            "custom_value": BridgeControl(
                "custom_value",
                "slider",
                "Custom Value",
                component="main",
                capability="custom",
                attribute="customValue",
            )
        }

        self.assertEqual(number_controls(device), [])

    def test_richer_domains_do_not_create_duplicate_number_entities(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        playback = BridgeState(
            "main",
            "mediaPlayback",
            "playbackStatus",
            "paused",
            None,
            "2026-08-24T21:10:00Z",
        )
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            20,
            "%",
            "2026-08-24T21:10:00Z",
        )
        mute = BridgeState(
            "main",
            "audioMute",
            "mute",
            "unmuted",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {playback.key: playback, volume.key: volume, mute.key: mute}
        device.controls = {
            "volume": BridgeControl(
                "volume",
                "slider",
                "Volume",
                component="main",
                capability="audioVolume",
                attribute="volume",
                minimum=0,
                maximum=100,
                step=1,
            )
        }

        self.assertEqual(number_controls(device), [])

    def test_alarm_volume_controls_do_not_make_smarttag_a_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "Ari"
        device.device_type = "bleD2D"
        device.presentation = BridgeDevicePresentation(asset_type="smart_tag_2")
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            6,
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {volume.key: volume}
        device.controls = {
            "alarm_volume": BridgeControl(
                "alarm_volume",
                "slider",
                "Alarm volume",
                component="main",
                capability="audioVolume",
                attribute="volume",
                minimum=1,
                maximum=10,
                step=1,
            ),
        }

        self.assertFalse(is_media_device(device))
        self.assertEqual([control.control_id for control in number_controls(device)], ["alarm_volume"])
        self.assertFalse(sensor_state_owned_by_primary_domain(device, volume))

    def test_play_sound_button_does_not_make_accessory_a_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "아리"
        device.device_type = "accessory"
        device.presentation = BridgeDevicePresentation(asset_type="smart_tag_2")
        device.states = {}
        device.controls = {
            "play_sound": BridgeControl(
                "play_sound",
                "button",
                "Play sound",
                component="main",
                capability="alarm",
                attribute="sound",
                commands=("play",),
            )
        }

        self.assertFalse(is_media_device(device))

    def test_playback_status_and_controls_make_speaker_a_media_player(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "Living room speaker"
        device.device_type = "speaker"
        playback = BridgeState(
            "main",
            "mediaPlayback",
            "playbackStatus",
            "paused",
            None,
            "2026-08-24T21:10:00Z",
        )
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            20,
            "%",
            "2026-08-24T21:10:00Z",
        )
        mute = BridgeState(
            "main",
            "audioMute",
            "mute",
            "unmuted",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {playback.key: playback, volume.key: volume, mute.key: mute}
        device.controls = {
            "play": BridgeControl(
                "play",
                "button",
                "Play",
                component="main",
                capability="mediaPlayback",
                attribute="playbackStatus",
                commands=("play",),
            ),
            "volume": BridgeControl(
                "volume",
                "slider",
                "Volume",
                component="main",
                capability="audioVolume",
                attribute="volume",
                minimum=0,
                maximum=100,
                step=1,
            ),
        }

        self.assertTrue(is_media_device(device))
        self.assertEqual(number_controls(device), [])

    def test_level_only_devices_are_not_fans_without_fan_identity(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        level = BridgeState(
            "main",
            "switchLevel",
            "level",
            60,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Living Room Mood Light"
        device.device_type = "Light"
        device.states = {level.key: level}
        device.controls = {
            "level_slider": BridgeControl(
                "level_slider",
                "slider",
                "Brightness",
                component="main",
                capability="switchLevel",
                attribute="level",
                minimum=0.0,
                maximum=100.0,
            )
        }

        self.assertFalse(is_fan_device(device))
        self.assertEqual([control.control_id for control in number_controls(device)], ["level_slider"])

    def test_fan_identity_allows_level_based_fan_speed(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        level = BridgeState(
            "main",
            "switchLevel",
            "level",
            60,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Living Room Fan"
        device.device_type = "Fan"
        device.states = {level.key: level}

        self.assertTrue(is_fan_device(device))

    def test_fan_semantic_controls_identify_fans_without_level_fallback(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "Kitchen Air Purifier"
        device.device_type = None
        device.states = {}
        device.controls = {
            "mode": BridgeControl(
                "mode",
                "enumerated",
                "Fan Mode",
                component="main",
                capability="fanMode",
                attribute="fanMode",
                options=("auto", "sleep"),
            )
        }

        self.assertTrue(is_fan_device(device))

    def test_fan_speed_state_identifies_fan_even_with_room_name(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        fan_speed = BridgeState(
            "main",
            "fanSpeed",
            "fanSpeed",
            40,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Living Room"
        device.device_type = None
        device.states = {fan_speed.key: fan_speed}

        self.assertTrue(is_fan_device(device))

    def test_air_purifier_percent_and_space_delimited_modes_are_actionable(self) -> None:
        """Match the pushed shape used by the live Air Purifier devices."""
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        fan_mode = BridgeState(
            "main",
            "fanMode",
            "fanMode",
            "off",
            None,
            "2026-08-24T21:10:00Z",
        )
        percent = BridgeState(
            "main",
            "fanSpeedPercent",
            "percent",
            0,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Air Purifier"
        device.states = {fan_mode.key: fan_mode, percent.key: percent}

        self.assertTrue(is_fan_device(device))
        self.assertEqual(numeric_range_for(device, percent), (0.0, 100.0, 1.0))
        self.assertEqual(option_values("Quiet Mode"), ["Quiet Mode"])
        self.assertEqual(
            token_values("off low medium high auto"),
            ["off", "low", "medium", "high", "auto"],
        )

    def test_cover_helpers_require_cover_state_or_controls(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        shade = BridgeState(
            "main",
            "windowShade",
            "windowShade",
            "partially open",
            None,
            "2026-08-24T21:10:00Z",
        )
        level = BridgeState(
            "main",
            "windowShadeLevel",
            "shadeLevel",
            40,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.states = {shade.key: shade, level.key: level}
        device.controls = {
            "open": BridgeControl("open", "button", "Open", attribute="windowShade", commands=("open",)),
            "level": BridgeControl(
                "level",
                "slider",
                "Shade level",
                attribute="shadeLevel",
                minimum=0.0,
                maximum=100.0,
            ),
        }

        self.assertTrue(is_cover_device(device))
        self.assertEqual([control.control_id for control in cover_controls(device)], ["open", "level"])

    def test_climate_helpers_require_thermostat_state_or_controls(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        mode = BridgeState(
            "main",
            "thermostatMode",
            "thermostatMode",
            "cool",
            None,
            "2026-08-24T21:10:00Z",
        )
        temperature = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            24,
            "C",
            "2026-08-24T21:10:00Z",
        )
        device.states = {mode.key: mode, temperature.key: temperature}
        device.controls = {
            "mode": BridgeControl(
                "mode",
                "enumerated",
                "Thermostat mode",
                attribute="thermostatMode",
                options=("off", "cool", "heat"),
            ),
            "setpoint": BridgeControl(
                "setpoint",
                "slider",
                "Target temperature",
                attribute="targetTemperature",
                minimum=16.0,
                maximum=30.0,
            ),
        }

        self.assertTrue(is_climate_device(device))
        self.assertEqual([control.control_id for control in climate_controls(device)], ["mode", "setpoint"])

    def test_select_helpers_only_return_observed_non_primary_enumerated_options(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.controls = {
            "sound": BridgeControl(
                "sound",
                "enumerated",
                "Sound mode",
                attribute="soundMode",
                options=("standard", "night"),
            ),
            "mode": BridgeControl(
                "mode",
                "enumerated",
                "Thermostat mode",
                attribute="thermostatMode",
                options=("off", "cool"),
            ),
            "value": BridgeControl(
                "value",
                "value",
                "Read only",
                attribute="displayMode",
                options=("a", "b"),
            ),
        }

        self.assertEqual([control.control_id for control in select_controls(device)], ["sound"])

    def test_observed_select_owns_its_mirrored_state_instead_of_a_duplicate_sensor(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        state = BridgeState(
            "main",
            "motionSensitivity",
            "sensitivityAdjustment",
            "high",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {state.key: state}
        device.controls = {
            "sensitivity": BridgeControl(
                "sensitivity",
                "enumerated",
                "Sensitivity adjustment",
                component="main",
                capability="motionSensitivity",
                attribute="sensitivityAdjustment",
                options=("low", "medium", "high"),
            )
        }

        self.assertTrue(sensor_state_owned_by_primary_domain(device, state))

    def test_primary_attributes_preserve_duplicate_components_without_overwrite(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        first = BridgeState(
            "main",
            "audioVolume",
            "volume",
            10,
            "%",
            "2026-08-24T21:10:00Z",
        )
        second = BridgeState(
            "zone2",
            "audioVolume",
            "volume",
            20,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.states = {first.key: first, second.key: second}

        attributes = primary_state_attributes(device, {"volume"})

        self.assertEqual(len(attributes), 2)
        self.assertEqual(set(attributes.values()), {10, 20})
        self.assertNotIn("volume", attributes)

    def test_generic_toggle_rejects_compound_and_localized_dangerous_controls(self) -> None:
        for attribute, label in (
            ("doorLock", "Power"),
            ("lockState", "Power"),
            ("garageDoor", "Power"),
            ("valveState", "Power"),
            ("safeToggle", "문 열기"),
            ("safeToggle", "밸브 제어"),
            ("safeToggle", "현관문"),
            ("safeToggle", "대문"),
        ):
            with self.subTest(attribute=attribute, label=label):
                control = BridgeControl(
                    "toggle",
                    "toggle",
                    label,
                    attribute=attribute,
                    commands=("switchOn", "switchOff"),
                )
                self.assertFalse(safe_generic_toggle_control(control))

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

    def test_command_result_accepts_authoritative_inventory_resync_confirmation(self) -> None:
        result = parse_command_result(
            {
                "schemaVersion": 1,
                "clientRequestId": "request_12345678",
                "status": "confirmed",
                "sequence": 43,
                "transport": "smartthings_web_ui",
                "confirmation": "inventory_snapshot",
            },
            "request_12345678",
            "device",
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.sequence, 43)
        self.assertEqual(result.confirmation, "inventory_snapshot")

    def test_command_result_accepts_advanced_transport_with_explicit_lifecycle(self) -> None:
        result = parse_command_result(
            {
                "schemaVersion": 1,
                "clientRequestId": "request_advanced_123",
                "status": "confirmed",
                "sequence": 44,
                "transport": "advanced",
                "confirmation": "device_event",
                "lifecycle": "CONFIRMED_BY_EVENT",
            },
            "request_advanced_123",
            "device",
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.transport, "advanced")
        self.assertEqual(result.lifecycle, "CONFIRMED_BY_EVENT")

    def test_command_result_accepts_stateless_advanced_receipt_without_state_confirmation(self) -> None:
        result = parse_command_result(
            {
                "schemaVersion": 1,
                "clientRequestId": "request_stateless_123",
                "status": "accepted_unconfirmed",
                "sequence": 45,
                "transport": "advanced",
                "confirmation": "accepted_receipt",
                "lifecycle": "ACCEPTED_UNCONFIRMED",
            },
            "request_stateless_123",
            "device",
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.status, "accepted_unconfirmed")
        self.assertEqual(result.confirmation, "accepted_receipt")
        self.assertEqual(result.lifecycle, "ACCEPTED_UNCONFIRMED")

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

    def test_security_arm_confirmation_is_location_only(self) -> None:
        raw = {
            "schemaVersion": 1,
            "clientRequestId": "request_12345678",
            "status": "confirmed",
            "sequence": 42,
            "transport": "smartthings_web_ui",
            "confirmation": "security_arm_state_event",
        }

        self.assertIsNone(parse_command_result(raw, "request_12345678", "device"))
        result = parse_command_result(raw, "request_12345678", "location")
        self.assertIsNotNone(result)
        self.assertEqual(result.confirmation, "security_arm_state_event")

    def test_device_models_use_korean_names_for_observed_smartthings_types(self) -> None:
        expected = {
            "accessory": "액세서리",
            "ai_speaker_lux_one": "AI 스피커",
            "air_purifier": "공기청정기",
            "air_quality_sensor": "공기질 센서",
            "bleD2D": "블루투스 기기",
            "button_1": "버튼",
            "camera_security": "보안 카메라",
            "charger_hub": "충전 허브",
            "coffee_machine": "커피 머신",
            "contact_sensor": "문열림 센서",
            "custom_door": "도어",
            "custom_floor_ac_rac": "에어컨",
            "custom_light_mood": "무드등",
            "custom_light_pendant": "펜던트 조명",
            "custom_light_strip": "스트립 조명",
            "custom_light_tube": "튜브 조명",
            "custom_window_h": "창문",
            "dishwasher": "식기세척기",
            "dryer": "건조기",
            "elevator": "엘리베이터",
            "energy_monitoring": "에너지 모니터",
            "fan": "선풍기",
            "floor_ac": "에어컨",
            "garage_door": "차고문",
            "general_display": "디스플레이",
            "home_theater": "홈시어터",
            "hub": "허브",
            "humidifier": "가습기",
            "illuminance_sensor": "조도 센서",
            "light_bulb": "전구",
            "light_ceiling": "천장등",
            "moisture_sensor_1": "누수 센서",
            "motion_sensor_1": "모션 센서",
            "multipurpose_sensor_1": "다목적 센서",
            "outlet_1": "콘센트",
            "presence_sensor": "재실 센서",
            "qooker": "쿠커",
            "range_extender": "신호 확장기",
            "refrigerator": "냉장고",
            "remote": "리모컨",
            "shade": "블라인드",
            "smoke_sensor": "연기 감지기",
            "soundbar": "사운드바",
            "speaker": "스피커",
            "switch": "스위치",
            "temp_humidity_sensor": "온습도 센서",
            "thermostat": "온도조절기",
            "unknown": "스마트 기기",
            "washer": "세탁기",
            "wifi_hub_1": "Wi-Fi 허브",
        }

        for device_type, model in expected.items():
            with self.subTest(device_type=device_type):
                device = BridgeDevice(
                    "dev_001", "loc_001", None, "Device", device_type, True
                )
                self.assertEqual(device_model(device), model)

    def test_unknown_device_model_removes_only_trailing_numeric_suffix(self) -> None:
        device = BridgeDevice(
            "dev_001", "loc_001", None, "Device", "future_sensor_1", True
        )

        self.assertEqual(device_model(device), "Future Sensor")

    def test_generic_device_model_prefers_specific_presentation_asset_type(self) -> None:
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "아리",
            "bleD2D",
            True,
            presentation=BridgeDevicePresentation(asset_type="smart_tag_2"),
        )

        self.assertEqual(device_model(device), "스마트태그")

    def test_duplicate_state_names_get_stable_human_readable_qualifiers(self) -> None:
        first = BridgeState(
            "identifier_component",
            "identifier_capability_a",
            "referenceTable",
            {},
            None,
            "2026-08-27T00:00:00Z",
        )
        second = BridgeState(
            "identifier_component",
            "identifier_capability_b",
            "referenceTable",
            {},
            None,
            "2026-08-27T00:00:00Z",
        )
        indoor = BridgeState(
            "indoor",
            "temperatureMeasurement",
            "temperature",
            24,
            "C",
            "2026-08-27T00:00:00Z",
        )
        outdoor = BridgeState(
            "outdoor",
            "temperatureMeasurement",
            "temperature",
            31,
            "C",
            "2026-08-27T00:00:00Z",
        )
        battery = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-27T00:00:00Z",
        )

        names = models_module.disambiguated_state_names(
            [
                (second, "Reference Table"),
                (first, "Reference Table"),
                (outdoor, "Temperature"),
                (indoor, "Temperature"),
                (battery, "Battery"),
            ]
        )

        self.assertEqual(names[first.key], "Reference Table (1)")
        self.assertEqual(names[second.key], "Reference Table (2)")
        self.assertEqual(names[indoor.key], "Temperature (Indoor)")
        self.assertEqual(names[outdoor.key], "Temperature (Outdoor)")
        self.assertNotIn(battery.key, names)

    def test_duplicate_state_names_prefer_safe_component_roles(self) -> None:
        fridge = BridgeState(
            "identifier_component_fridge",
            "temperatureMeasurement",
            "temperature",
            3,
            "C",
            "2026-08-27T00:00:00Z",
            component_role="fridge",
        )
        freezer = BridgeState(
            "identifier_component_freezer",
            "temperatureMeasurement",
            "temperature",
            -18,
            "C",
            "2026-08-27T00:00:00Z",
            component_role="freezer",
        )

        names = models_module.disambiguated_state_names(
            [(freezer, "Temperature"), (fridge, "Temperature")]
        )

        self.assertEqual(names[fridge.key], "Temperature (냉장실)")
        self.assertEqual(names[freezer.key], "Temperature (냉동실)")

    def test_duplicate_presence_names_map_main_role_to_location_name(self) -> None:
        roles = ("부모님댁", "친정집", "main", "회사")
        states = [
            BridgeState(
                f"identifier_component_{index}",
                f"identifier_capability_{index}",
                "presence",
                "present" if role == "main" else "not present",
                None,
                "2026-08-31T00:00:00Z",
                component_role=role,
            )
            for index, role in enumerate(roles, 1)
        ]

        names = models_module.disambiguated_state_names(
            [(state, "Presence") for state in states],
            all_states=states,
            main_presence_name="Home",
        )

        self.assertEqual(
            [names[state.key] for state in states],
            [
                "Presence (부모님댁)",
                "Presence (친정집)",
                "Presence (Home)",
                "Presence (회사)",
            ],
        )

    def test_duplicate_state_names_localize_known_component_roles(self) -> None:
        roles = {
            "refrigerator": "냉장고",
            "cooler": "냉장실",
            "freezer": "냉동실",
            "cvroom": "맞춤보관실",
            "onedoor": "단일 도어",
            "curdmaker": "숙성실",
            "icemaker": "제빙기",
            "icemaker-02": "보조 제빙기",
            "pantry-01": "팬트리 1",
            "pantry-02": "팬트리 2",
            "bixby": "빅스비",
            "smartthings-hub": "스마트싱스 허브",
            "smartthings-findNode": "찾기 노드",
            "setup": "설정",
            "hca.main": "HCA",
            "switch2": "스위치 2",
            "switch3": "스위치 3",
            "switch4": "스위치 4",
            "switch5": "스위치 5",
        }
        states = [
            BridgeState(
                role,
                "custom",
                "value",
                index,
                None,
                "2026-08-27T00:00:00Z",
                component_role=role,
            )
            for index, role in enumerate(roles)
        ]

        names = models_module.disambiguated_state_names(
            [(state, "Value") for state in states]
        )

        self.assertEqual(
            {state.component_role: names[state.key] for state in states},
            {role: f"Value ({label})" for role, label in roles.items()},
        )

    def test_duplicate_contact_names_inherit_unique_sibling_component_roles(self) -> None:
        role_labels = {
            "refrigerator": "냉장고",
            "freezer": "냉동실",
            "cvroom": "맞춤보관실",
            "cooler": "냉장실",
            "onedoor": "단일 도어",
        }
        contacts: list[BridgeState] = []
        all_states: list[BridgeState] = []
        for role, label in role_labels.items():
            component = f"identifier_component_{role}"
            contact = BridgeState(
                component,
                "contactSensor",
                "contact",
                "closed",
                None,
                "2026-08-28T00:00:00Z",
                component_role="main",
            )
            temperature = BridgeState(
                component,
                "temperatureMeasurement",
                "temperature",
                3,
                "C",
                "2026-08-28T00:00:00Z",
                component_role=role,
            )
            contacts.append(contact)
            all_states.extend((contact, temperature))

        names = models_module.disambiguated_state_names(
            [(state, "Contact") for state in contacts],
            all_states=all_states,
        )

        self.assertEqual(
            {state.component: names[state.key] for state in contacts},
            {
                f"identifier_component_{role}": f"Contact ({label})"
                for role, label in role_labels.items()
            },
        )

    def test_duplicate_state_names_keep_numbering_for_conflicting_sibling_roles(self) -> None:
        first = BridgeState(
            "identifier_component_first",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-28T00:00:00Z",
            component_role="main",
        )
        first_fridge = BridgeState(
            first.component,
            "temperatureMeasurement",
            "temperature",
            3,
            "C",
            "2026-08-28T00:00:00Z",
            component_role="refrigerator",
        )
        first_freezer = BridgeState(
            first.component,
            "temperatureMeasurement",
            "temperature",
            -18,
            "C",
            "2026-08-28T00:00:00Z",
            component_role="freezer",
        )
        second = BridgeState(
            "identifier_component_second",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-28T00:00:00Z",
            component_role="main",
        )

        names = models_module.disambiguated_state_names(
            [(second, "Contact"), (first, "Contact")],
            all_states=[first, first_fridge, first_freezer, second],
        )

        self.assertEqual(names[first.key], "Contact (1)")
        self.assertEqual(names[second.key], "Contact (2)")

    def test_primary_state_attributes_prefer_safe_roles_for_duplicate_keys(self) -> None:
        device = BridgeDevice(
            "fridge_001",
            "loc_001",
            None,
            "냉장고",
            "refrigerator",
            True,
        )
        fridge = BridgeState(
            "identifier_component_fridge",
            "temperatureMeasurement",
            "temperature",
            3,
            "C",
            "2026-08-27T00:00:00Z",
            component_role="fridge",
        )
        freezer = BridgeState(
            "identifier_component_freezer",
            "temperatureMeasurement",
            "temperature",
            -18,
            "C",
            "2026-08-27T00:00:00Z",
            component_role="freezer",
        )
        device.states = {fridge.key: fridge, freezer.key: freezer}

        self.assertEqual(
            primary_state_attributes(device, {"temperature"}),
            {"smartthings_냉장실_temperature": 3, "smartthings_냉동실_temperature": -18},
        )


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


class RoomFreeDisplayNameTests(unittest.TestCase):
    """Device display names always preserve the SmartThings inventory name."""

    def _runtime(self, rooms: dict[str, tuple[str, str]]) -> SmartThingsWebRuntime:
        return SmartThingsWebRuntime(
            client=object(),
            location_id="loc_001",
            inventory=BridgeInventory(1, True, "0.1.99", "4:test", {}, rooms, {}),
        )

    @staticmethod
    def _device(name: str, device_type: str | None, room_id: str | None) -> BridgeDevice:
        return BridgeDevice(
            device_id="dev_001",
            location_id="loc_001",
            room_id=room_id,
            name=name,
            device_type=device_type,
            online=True,
        )

    def test_device_named_like_its_own_room_keeps_the_raw_name(self) -> None:
        runtime = self._runtime(
            {"room_001": ("loc_001", "거실"), "room_002": ("loc_001", "Living Room")}
        )
        cases = [
            ("거실", "speaker", "room_001"),
            ("거실", "air_conditioner", "room_001"),
            (" 거실 ", "switch", "room_001"),
            ("living room", "speaker", "room_002"),
        ]
        for name, device_type, room_id in cases:
            with self.subTest(name=name, device_type=device_type):
                self.assertIsNone(
                    models_module.room_free_display_name(
                        runtime,
                        self._device(name, device_type, room_id),
                    )
                )

    def test_other_devices_keep_their_raw_names(self) -> None:
        runtime = self._runtime(
            {
                "room_001": ("loc_001", "거실"),
                "room_002": ("loc_001", "디티오룸"),
            }
        )
        unchanged = [
            self._device("거실 2", "speaker", "room_001"),
            self._device("디티오룸의조명", "light", "room_001"),
            self._device("미니 거실 스피커", "speaker", "room_001"),
            self._device("주방 냉장고", "refrigerator", "room_002"),
        ]
        for device in unchanged:
            with self.subTest(name=device.name):
                self.assertIsNone(models_module.room_free_display_name(runtime, device))

    def test_unknown_rooms_or_types_fall_back_to_the_raw_name(self) -> None:
        runtime = self._runtime({"room_001": ("loc_001", "거실")})
        no_match = [
            self._device("거실", "robot_vacuum", "room_001"),
            self._device("거실", "speaker", None),
            self._device("거실", "speaker", "room_missing"),
            self._device("부산집 거실", None, None),
        ]
        for device in no_match:
            with self.subTest(name=device.name, room_id=device.room_id):
                self.assertIsNone(models_module.room_free_display_name(runtime, device))


if __name__ == "__main__":
    unittest.main()

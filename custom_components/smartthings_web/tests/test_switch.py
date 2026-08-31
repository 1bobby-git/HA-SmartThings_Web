"""Regression tests for pushed SmartThings switch states."""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
sys.modules.setdefault("homeassistant.components", ModuleType("homeassistant.components"))
switch_module = ModuleType("homeassistant.components.switch")


class SwitchEntity:
    """Minimal HA switch entity stub."""


switch_module.SwitchEntity = SwitchEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.switch"] = switch_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

exceptions_module = ModuleType("homeassistant.exceptions")
HomeAssistantError = type("HomeAssistantError", (Exception,), {})
exceptions_module.HomeAssistantError = HomeAssistantError  # type: ignore[attr-defined]
sys.modules["homeassistant.exceptions"] = exceptions_module

sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

entity_module = ModuleType("smartthings_web.entity")


class SmartThingsWebEntity:
    """Minimal integration entity base stub."""

    def __init__(
        self,
        runtime: object,
        device: object,
        state: object,
        _name: str | None = None,
        **_kwargs: object,
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self.state_key = state.key  # type: ignore[attr-defined]
        if _name is not None:
            self._attr_name = _name
        self._attr_unique_id = "_".join((self.device_id, *self.state_key))

    @property
    def bridge_device(self):
        return self.runtime.inventory.devices.get(self.device_id)

    @property
    def bridge_state(self):
        device = self.bridge_device
        return device.states.get(self.state_key) if device is not None else None

    @property
    def available(self) -> bool:
        device = self.bridge_device
        return device is not None and device.online and self.bridge_state is not None


entity_module.SmartThingsWebEntity = SmartThingsWebEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
entity_module.migrate_entity_original_name = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.models import (  # noqa: E402
    BridgeControl,
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)
from smartthings_web.switch import SmartThingsWebSwitch, async_setup_entry  # noqa: E402


def _device(*, with_control: bool) -> tuple[BridgeDevice, BridgeState]:
    switch = BridgeState(
        "identifier_cd4f3cfbf2aa",
        "identifier_74292182f118",
        "switch",
        "off",
        None,
        "2026-08-29T00:00:00Z",
    )
    contact = BridgeState(
        "identifier_cd4f3cfbf2aa",
        "identifier_46f602c5fd8",
        "contact",
        "closed",
        None,
        "2026-08-29T00:00:00Z",
    )
    controls = {}
    if with_control:
        controls["toggle:identifier_cd4f3cfbf2aa:identifier_74292182f118:switch"] = (
            BridgeControl(
                "toggle:identifier_cd4f3cfbf2aa:identifier_74292182f118:switch",
                "toggle",
                "Power",
                component=switch.component,
                capability=switch.capability,
                attribute=switch.attribute,
            )
        )
    return (
        BridgeDevice(
            "dev_560",
            "loc_001",
            "room_001",
            "Home Assistant 연동 스위치",
            "signage",
            True,
            states={switch.key: switch, contact.key: contact},
            controls=controls,
        ),
        switch,
    )


def _one_direction_device() -> tuple[BridgeDevice, BridgeState]:
    device, state = _device(with_control=False)
    control_id = "action:identifier_cd4f3cfbf2aa:identifier_74292182f118:switch"
    device.controls[control_id] = BridgeControl(
        control_id,
        "toggle",
        "Power",
        component=state.component,
        capability=state.capability,
        attribute=state.attribute,
        commands=("on",),
    )
    return device, state


def _duplicate_toggle_device() -> tuple[BridgeDevice, BridgeState, str]:
    """Mirror Cake inventory that exposes action and detail aliases for one toggle."""
    device, state = _device(with_control=True)
    action_control_id = (
        "action:identifier_cd4f3cfbf2aa:identifier_74292182f118:switch"
    )
    device.controls[action_control_id] = BridgeControl(
        action_control_id,
        "toggle",
        "Power",
        component=state.component,
        capability=state.capability,
        attribute=state.attribute,
        commands=("on", "off"),
    )
    return device, state, action_control_id


def _multi_component_switch_device(
    components: tuple[tuple[str, str], ...] = (
        ("main", "main"),
        ("switch2", "switch2"),
        ("switch3", "switch3"),
        ("switch4", "switch4"),
    ),
) -> BridgeDevice:
    states = [
        BridgeState(
            component,
            f"capability_{component}",
            "switch",
            "off",
            None,
            "2026-08-29T00:00:00Z",
            component_role=role,
        )
        for component, role in components
    ]
    return BridgeDevice(
        "dev_multiswitch",
        "loc_001",
        "room_001",
        "거실 간접등",
        "switch",
        True,
        states={state.key: state for state in states},
    )


def _runtime(device: BridgeDevice, client: object) -> SmartThingsWebRuntime:
    inventory = BridgeInventory(
        1,
        True,
        "0.1.128",
        "4:test",
        {"loc_001": "Home"},
        {"room_001": ("loc_001", "거실")},
        {device.device_id: device},
    )
    return SmartThingsWebRuntime(client, "loc_001", inventory)


class SmartThingsWebSwitchTests(unittest.IsolatedAsyncioTestCase):
    """Keep domain classification separate from observed write controls."""

    async def test_setup_adds_primary_switch_from_pushed_state_without_control(self) -> None:
        device, _state = _device(with_control=False)
        runtime = _runtime(device, object())
        entry = SimpleNamespace(
            runtime_data=runtime,
            async_on_unload=lambda _callback: None,
        )
        added: list[SmartThingsWebSwitch] = []

        await async_setup_entry(object(), entry, added.extend)

        self.assertEqual(len(added), 1)
        self.assertEqual(
            added[0]._attr_unique_id,
            "dev_560_identifier_cd4f3cfbf2aa_identifier_74292182f118_switch",
        )
        self.assertTrue(added[0].available)
        self.assertFalse(added[0].is_on)
        self.assertEqual(
            added[0].extra_state_attributes,
            {"smartthings_raw_value": "off"},
        )

    async def test_setup_names_secondary_switch_components_without_dropping_states(self) -> None:
        device = _multi_component_switch_device()
        runtime = _runtime(device, object())
        entry = SimpleNamespace(
            runtime_data=runtime,
            async_on_unload=lambda _callback: None,
        )
        added: list[SmartThingsWebSwitch] = []

        await async_setup_entry(object(), entry, added.extend)

        self.assertEqual(len(added), 4)
        names_by_component = {
            entity.state_key[0]: getattr(entity, "_attr_name", None)
            for entity in added
        }
        self.assertEqual(
            names_by_component,
            {
                "main": None,
                "switch2": "스위치 2",
                "switch3": "스위치 3",
                "switch4": "스위치 4",
            },
        )

    async def test_setup_names_single_secondary_switch_component(self) -> None:
        device = _multi_component_switch_device(
            (("main", "main"), ("switch2", "switch2"))
        )
        runtime = _runtime(device, object())
        entry = SimpleNamespace(
            runtime_data=runtime,
            async_on_unload=lambda _callback: None,
        )
        added: list[SmartThingsWebSwitch] = []

        await async_setup_entry(object(), entry, added.extend)

        self.assertEqual(len(added), 2)
        names_by_component = {
            entity.state_key[0]: getattr(entity, "_attr_name", None)
            for entity in added
        }
        self.assertEqual(
            names_by_component,
            {
                "main": None,
                "switch2": "스위치 2",
            },
        )

    async def test_setup_names_unreadable_secondary_switch_components_by_sorted_order(self) -> None:
        device = _multi_component_switch_device(
            (
                ("main", "main"),
                ("identifier_b", "identifier_role_b"),
                ("identifier_a", "identifier_role_a"),
            )
        )
        runtime = _runtime(device, object())
        entry = SimpleNamespace(
            runtime_data=runtime,
            async_on_unload=lambda _callback: None,
        )
        added: list[SmartThingsWebSwitch] = []

        await async_setup_entry(object(), entry, added.extend)

        self.assertEqual(len(added), 3)
        names_by_component = {
            entity.state_key[0]: getattr(entity, "_attr_name", None)
            for entity in added
        }
        self.assertEqual(
            names_by_component,
            {
                "main": None,
                "identifier_a": "스위치 2",
                "identifier_b": "스위치 3",
            },
        )

    async def test_state_backed_switch_rejects_unobserved_commands(self) -> None:
        device, state = _device(with_control=False)
        client = SimpleNamespace(async_execute_command=AsyncMock())
        entity = SmartThingsWebSwitch(_runtime(device, client), device, state)

        with self.assertRaisesRegex(
            HomeAssistantError,
            "has no observed toggle control",
        ):
            await entity.async_turn_on()

        client.async_execute_command.assert_not_awaited()

    async def test_observed_toggle_sends_exact_control_identity(self) -> None:
        device, state = _device(with_control=True)
        client = SimpleNamespace(async_execute_command=AsyncMock())
        entity = SmartThingsWebSwitch(_runtime(device, client), device, state)

        await entity.async_turn_on()

        client.async_execute_command.assert_awaited_once_with(
            target_type="device",
            target_id="dev_560",
            component="identifier_cd4f3cfbf2aa",
            capability="identifier_74292182f118",
            attribute="switch",
            control_id=(
                "toggle:identifier_cd4f3cfbf2aa:identifier_74292182f118:switch"
            ),
            control_label="Power",
            command="on",
            arguments=[],
        )

    async def test_duplicate_detail_alias_uses_canonical_observed_action(self) -> None:
        device, state, action_control_id = _duplicate_toggle_device()
        state.value = "on"
        client = SimpleNamespace(async_execute_command=AsyncMock())
        entity = SmartThingsWebSwitch(_runtime(device, client), device, state)

        await entity.async_turn_off()

        client.async_execute_command.assert_awaited_once_with(
            target_type="device",
            target_id="dev_560",
            component="identifier_cd4f3cfbf2aa",
            capability="identifier_74292182f118",
            attribute="switch",
            control_id=action_control_id,
            control_label="Power",
            command="off",
            arguments=[],
        )

    async def test_unrelated_duplicate_detail_toggles_remain_fail_closed(self) -> None:
        device, state = _device(with_control=True)
        second_control_id = "identifier_second_detail_toggle"
        device.controls[second_control_id] = BridgeControl(
            second_control_id,
            "toggle",
            "Secondary power",
            component=state.component,
            capability=state.capability,
            attribute=state.attribute,
            commands=("on", "off"),
        )
        client = SimpleNamespace(async_execute_command=AsyncMock())
        entity = SmartThingsWebSwitch(_runtime(device, client), device, state)

        with self.assertRaisesRegex(
            HomeAssistantError,
            "has no observed toggle control",
        ):
            await entity.async_turn_on()

        client.async_execute_command.assert_not_awaited()

    async def test_single_observed_direction_rejects_unseen_opposite_command(self) -> None:
        device, state = _one_direction_device()
        state.value = "on"
        client = SimpleNamespace(async_execute_command=AsyncMock())
        entity = SmartThingsWebSwitch(_runtime(device, client), device, state)

        with self.assertRaisesRegex(
            HomeAssistantError,
            "has not observed the requested toggle command",
        ):
            await entity.async_turn_off()

        client.async_execute_command.assert_not_awaited()

    async def test_single_observed_direction_noops_when_state_already_matches(self) -> None:
        device, state = _one_direction_device()
        client = SimpleNamespace(async_execute_command=AsyncMock())
        entity = SmartThingsWebSwitch(_runtime(device, client), device, state)

        await entity.async_turn_off()

        client.async_execute_command.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()

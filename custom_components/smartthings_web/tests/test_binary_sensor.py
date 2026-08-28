"""Regression tests for pushed SmartThings binary sensors."""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
sys.modules.setdefault("homeassistant.components", ModuleType("homeassistant.components"))
binary_sensor_module = ModuleType("homeassistant.components.binary_sensor")


class BinarySensorDeviceClass:
    """Minimal HA binary sensor device-class values used by the integration."""

    CO = "carbon_monoxide"
    DOOR = "door"
    GAS = "gas"
    MOISTURE = "moisture"
    MOTION = "motion"
    MOVING = "moving"
    OPENING = "opening"
    POWER = "power"
    PRESENCE = "presence"
    PROBLEM = "problem"
    SMOKE = "smoke"
    SOUND = "sound"
    TAMPER = "tamper"
    WINDOW = "window"


class BinarySensorEntity:
    """Minimal HA binary sensor entity."""


binary_sensor_module.BinarySensorDeviceClass = BinarySensorDeviceClass  # type: ignore[attr-defined]
binary_sensor_module.BinarySensorEntity = BinarySensorEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.binary_sensor"] = binary_sensor_module

const_module = ModuleType("homeassistant.const")
const_module.EntityCategory = SimpleNamespace(DIAGNOSTIC="diagnostic")  # type: ignore[attr-defined]
sys.modules["homeassistant.const"] = const_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

entity_module = ModuleType("smartthings_web.entity")


class SmartThingsWebEntity:
    """Minimal pushed entity base."""

    def __init__(
        self, runtime: object, device: object, state: object, name: str | None
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self.state_key = state.key  # type: ignore[attr-defined]
        self._attr_name = name

    @property
    def bridge_state(self) -> object | None:
        device = self.runtime.inventory.devices.get(self.device_id)  # type: ignore[attr-defined]
        return device.states.get(self.state_key) if device else None


entity_module.SmartThingsWebEntity = SmartThingsWebEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
entity_module.migrate_entity_original_name = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.binary_sensor import (  # noqa: E402
    BINARY_STATES,
    SmartThingsWebBinarySensor,
    _binary_sensor_candidates,
    async_setup_entry,
)
from smartthings_web.models import (  # noqa: E402
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)


class SmartThingsWebBinarySensorTests(unittest.TestCase):
    """Keep duplicate binary state rows distinguishable."""

    def test_explicit_duplicate_name_overrides_translation_key(self) -> None:
        state = BridgeState(
            "room_a",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-27T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Presence Hub",
            None,
            True,
            states={state.key: state},
        )
        inventory = BridgeInventory(
            1, True, "0.1.93", "4:test", {}, {}, {device.device_id: device}
        )
        runtime = SmartThingsWebRuntime(object(), "loc_001", inventory)

        sensor = SmartThingsWebBinarySensor(
            runtime,
            device,
            state,
            BINARY_STATES["presence"],
            name_override="Presence (Room A)",
        )

        self.assertEqual(sensor._attr_name, "Presence (Room A)")
        self.assertIsNone(sensor._attr_translation_key)

    def test_appliance_switch_state_is_exposed_as_read_only_power_binary_sensor(self) -> None:
        power = BridgeState(
            "main",
            "switch",
            "switch",
            "on",
            None,
            "2026-08-27T00:00:00Z",
        )
        dryer = BridgeDevice(
            "dryer_001",
            "loc_001",
            None,
            "Dryer",
            "dryer",
            True,
            states={power.key: power},
        )

        candidates = _binary_sensor_candidates(dryer)

        self.assertEqual(candidates, [(power, BINARY_STATES["switch"])])

    def test_plain_switch_keeps_contact_as_its_auxiliary_binary_sensor(self) -> None:
        power = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-08-29T00:00:00Z",
        )
        contact = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-29T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_560",
            "loc_001",
            None,
            "Home Assistant 연동 스위치",
            "signage",
            True,
            states={power.key: power, contact.key: contact},
        )

        candidates = _binary_sensor_candidates(device)

        self.assertEqual(candidates, [(contact, BINARY_STATES["contact"])])


class SmartThingsWebBinarySensorSetupTests(unittest.IsolatedAsyncioTestCase):
    """Keep setup-time duplicate naming aligned with registry migration."""

    async def test_contact_original_name_migration_uses_sibling_compartment_roles(self) -> None:
        role_labels = {
            "refrigerator": "냉장고",
            "freezer": "냉동실",
            "cvroom": "맞춤보관실",
            "cooler": "냉장실",
            "onedoor": "단일 도어",
        }
        states: list[BridgeState] = []
        for role in role_labels:
            component = f"identifier_component_{role}"
            states.extend(
                [
                    BridgeState(
                        component,
                        "contactSensor",
                        "contact",
                        "closed",
                        None,
                        "2026-08-28T00:00:00Z",
                        component_role="main",
                    ),
                    BridgeState(
                        component,
                        "temperatureMeasurement",
                        "temperature",
                        3,
                        "C",
                        "2026-08-28T00:00:00Z",
                        component_role=role,
                    ),
                ]
            )
        device = BridgeDevice(
            "dev_392",
            "loc_001",
            None,
            "Bespoke refrigerator",
            "refrigerator",
            True,
            states={state.key: state for state in states},
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.99", "4:test", {}, {}, {device.device_id: device}),
        )
        migrations: list[tuple[str, str, str, str | None]] = []
        setup_globals = async_setup_entry.__globals__
        original_migrate = setup_globals["migrate_entity_original_name"]
        setup_globals["migrate_entity_original_name"] = lambda *args: migrations.append(args)
        added: list[object] = []
        entry = SimpleNamespace(
            runtime_data=runtime,
            async_on_unload=lambda callback: None,
        )
        try:
            await async_setup_entry(object(), entry, added.extend)
        finally:
            setup_globals["migrate_entity_original_name"] = original_migrate

        self.assertEqual(
            {
                entity.state_key[0]: entity._attr_name
                for entity in added
                if entity.state_key[2] == "contact"
            },
            {
                f"identifier_component_{role}": f"Contact ({label})"
                for role, label in role_labels.items()
            },
        )
        self.assertEqual(
            {unique_id: name for _, _, unique_id, name in migrations},
            {
                f"dev_392_identifier_component_{role}_contactSensor_contact": (
                    f"Contact ({label})"
                )
                for role, label in role_labels.items()
            },
        )


if __name__ == "__main__":
    unittest.main()

"""Integrated platform regression for SmartThings Web window sensors."""

from __future__ import annotations

import importlib
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
components = sys.modules.setdefault(
    "homeassistant.components", ModuleType("homeassistant.components")
)
components.__path__ = []  # type: ignore[attr-defined]

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


binary_sensor_module.BinarySensorDeviceClass = (  # type: ignore[attr-defined]
    BinarySensorDeviceClass
)
binary_sensor_module.BinarySensorEntity = BinarySensorEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.binary_sensor"] = binary_sensor_module

sensor_module = ModuleType("homeassistant.components.sensor")


class SensorDeviceClass:
    """Minimal HA sensor device-class values used by the integration."""

    ATMOSPHERIC_PRESSURE = "atmospheric_pressure"
    BATTERY = "battery"
    CO2 = "carbon_dioxide"
    CURRENT = "current"
    DURATION = "duration"
    ENERGY = "energy"
    HUMIDITY = "humidity"
    ILLUMINANCE = "illuminance"
    PM1 = "pm1"
    PM10 = "pm10"
    PM25 = "pm25"
    POWER = "power"
    SIGNAL_STRENGTH = "signal_strength"
    SOUND_PRESSURE = "sound_pressure"
    TEMPERATURE = "temperature"
    VOLATILE_ORGANIC_COMPOUNDS_PARTS = "volatile_organic_compounds_parts"
    VOLTAGE = "voltage"


class SensorStateClass:
    """Minimal HA sensor state-class values used by the integration."""

    MEASUREMENT = "measurement"
    TOTAL_INCREASING = "total_increasing"


class SensorEntity:
    """Minimal HA sensor entity."""


sensor_module.SensorDeviceClass = SensorDeviceClass  # type: ignore[attr-defined]
sensor_module.SensorEntity = SensorEntity  # type: ignore[attr-defined]
sensor_module.SensorStateClass = SensorStateClass  # type: ignore[attr-defined]
sys.modules["homeassistant.components.sensor"] = sensor_module

button_module = ModuleType("homeassistant.components.button")


class ButtonEntity:
    """Minimal HA button entity."""


button_module.ButtonEntity = ButtonEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.button"] = button_module

image_module = ModuleType("homeassistant.components.image")


class ImageEntity:
    """Minimal HA image entity surface."""

    def __init__(self, hass: object) -> None:
        self.hass = hass

    def async_update_token(self) -> None:
        """Stand in for Home Assistant image-token rotation."""


image_module.ImageEntity = ImageEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.image"] = image_module

update_module = ModuleType("homeassistant.components.update")


class UpdateDeviceClass:
    """Minimal HA update device-class values used by the integration."""

    FIRMWARE = "firmware"


class UpdateEntity:
    """Minimal HA update entity."""


update_module.UpdateDeviceClass = UpdateDeviceClass  # type: ignore[attr-defined]
update_module.UpdateEntity = UpdateEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.update"] = update_module

const_module = ModuleType("homeassistant.const")
const_module.EntityCategory = SimpleNamespace(CONFIG="config", DIAGNOSTIC="diagnostic")
const_module.LIGHT_LUX = "lx"
const_module.PERCENTAGE = "%"
const_module.UnitOfElectricCurrent = SimpleNamespace(AMPERE="A")
const_module.UnitOfElectricPotential = SimpleNamespace(VOLT="V")
const_module.UnitOfEnergy = SimpleNamespace(KILO_WATT_HOUR="kWh")
const_module.UnitOfPower = SimpleNamespace(WATT="W")
const_module.UnitOfTemperature = SimpleNamespace(CELSIUS="°C")
sys.modules["homeassistant.const"] = const_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

exceptions_module = ModuleType("homeassistant.exceptions")
exceptions_module.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
sys.modules["homeassistant.exceptions"] = exceptions_module

helpers = sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
helpers.__path__ = []  # type: ignore[attr-defined]

entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

device_registry = ModuleType("homeassistant.helpers.device_registry")


class DeviceInfo(dict[str, object]):
    """Minimal DeviceInfo constructor."""

    def __init__(self, **kwargs: object) -> None:
        super().__init__(kwargs)


device_registry.DeviceInfo = DeviceInfo  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.device_registry"] = device_registry

entity_helper = ModuleType("homeassistant.helpers.entity")


class Entity:
    """Minimal Home Assistant entity base."""

    def async_on_remove(self, _callback: object) -> None:
        """Stand in for Home Assistant removal callback registration."""

    def async_write_ha_state(self) -> None:
        """Stand in for Home Assistant state writes."""


entity_helper.Entity = Entity  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity"] = entity_helper


class FakeEntityRegistry:
    """Registry surface exercised by migrate_entity_original_name during setup."""

    def __init__(self) -> None:
        self.lookups: list[tuple[str, str, str]] = []

    def async_get_entity_id(
        self, domain: str, platform: str, unique_id: str
    ) -> str | None:
        self.lookups.append((domain, platform, unique_id))
        return None

    def async_get(self, _entity_id: str) -> object | None:
        return None

    def async_update_entity(self, *_args: object, **_kwargs: object) -> None:
        raise AssertionError("No existing entity should be migrated in this regression")


entity_registry = ModuleType("homeassistant.helpers.entity_registry")
_ENTITY_REGISTRY = FakeEntityRegistry()
entity_registry.async_get = lambda _hass: _ENTITY_REGISTRY  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_registry"] = entity_registry

entity_module = ModuleType("smartthings_web.entity")


class SmartThingsWebEntity(Entity):
    """Minimal pushed entity base with production-shaped unique IDs."""

    def __init__(
        self,
        runtime: object,
        device: object,
        state: object,
        name: str | None,
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self.state_key = state.key  # type: ignore[attr-defined]
        if name is not None:
            self._attr_name = name
        self._attr_unique_id = "_".join((self.device_id, *self.state_key))

    @property
    def bridge_device(self) -> object | None:
        return self.runtime.inventory.devices.get(self.device_id)  # type: ignore[attr-defined]

    @property
    def bridge_state(self) -> object | None:
        device = self.bridge_device
        return device.states.get(self.state_key) if device else None  # type: ignore[attr-defined]


class SmartThingsWebDeviceEntity(Entity):
    """Minimal device entity base with production-shaped unique IDs."""

    def __init__(
        self,
        runtime: object,
        device: object,
        suffix: str,
        name: str | None,
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        if name is not None:
            self._attr_name = name
        self._attr_unique_id = f"{self.device_id}_{suffix}"

    @property
    def available(self) -> bool:
        device = self.bridge_device
        return device is not None and device.online  # type: ignore[attr-defined]

    @property
    def bridge_device(self) -> object | None:
        return self.runtime.inventory.devices.get(self.device_id)  # type: ignore[attr-defined]


def migrate_entity_original_name(
    hass: object,
    domain: str,
    unique_id: str,
    original_name: str | None,
) -> None:
    if original_name is None:
        return
    registry = entity_registry.async_get(hass)
    registry.async_get_entity_id(domain, "smartthings_web", unique_id)


entity_module.SmartThingsWebEntity = SmartThingsWebEntity  # type: ignore[attr-defined]
entity_module.SmartThingsWebDeviceEntity = SmartThingsWebDeviceEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
entity_module.migrate_entity_original_name = (  # type: ignore[attr-defined]
    migrate_entity_original_name
)
sys.modules["smartthings_web.entity"] = entity_module

bridge_client_module = ModuleType("smartthings_web.bridge_client")


class BridgeClientError(Exception):
    """Minimal Bridge client failure."""


class BridgeAuthError(BridgeClientError):
    """Minimal Bridge auth failure."""


def bridge_error_message(action: str, _err: Exception) -> str:
    return f"failed: {action}"


bridge_client_module.BridgeAuthError = BridgeAuthError  # type: ignore[attr-defined]
bridge_client_module.BridgeClientError = BridgeClientError  # type: ignore[attr-defined]
bridge_client_module.bridge_error_message = bridge_error_message  # type: ignore[attr-defined]
sys.modules["smartthings_web.bridge_client"] = bridge_client_module

for module_name in (
    "smartthings_web.binary_sensor",
    "smartthings_web.button",
    "smartthings_web.image",
    "smartthings_web.sensor",
    "smartthings_web.update",
):
    sys.modules.pop(module_name, None)
    attribute = module_name.rsplit(".", 1)[1]
    if hasattr(package, attribute):
        delattr(package, attribute)

binary_sensor = importlib.import_module("smartthings_web.binary_sensor")
button = importlib.import_module("smartthings_web.button")
image = importlib.import_module("smartthings_web.image")
sensor = importlib.import_module("smartthings_web.sensor")
update = importlib.import_module("smartthings_web.update")
from smartthings_web.models import (  # noqa: E402
    BridgeControl,
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)


RAW_SIGNAL_METRICS = "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm"


class FakeEntry:
    """Minimal config entry carrying runtime data."""

    def __init__(self, runtime: SmartThingsWebRuntime) -> None:
        self.runtime_data = runtime
        self.unload_callbacks: list[object] = []

    def async_on_unload(self, callback: object) -> None:
        self.unload_callbacks.append(callback)


def _window_sensor(device_id: str, name: str) -> BridgeDevice:
    states = [
        BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-25T02:11:34Z",
        ),
        BridgeState("main", "battery", "battery", 91, "%", "2026-04-01T17:21:43Z"),
        BridgeState(
            "main",
            "legendabsolute60149.signalMetrics",
            "signalMetrics",
            RAW_SIGNAL_METRICS,
            None,
            "2026-04-01T11:28:55Z",
        ),
        BridgeState(
            "main",
            "imageCapture",
            "image",
            "stale",
            None,
            "2026-04-01T11:28:55Z",
        ),
        BridgeState(
            "main",
            "imageCapture",
            "imageTransferProgress",
            100,
            "%",
            "2026-04-01T11:28:55Z",
        ),
        BridgeState("main", "metadata", "quantity", None, None, "2026-04-01T11:28:55Z"),
        BridgeState("main", "metadata", "type", None, None, "2026-04-01T11:28:55Z"),
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
    return BridgeDevice(
        device_id,
        "loc_001",
        None,
        name,
        "custom_window_h",
        True,
        states={state.key: state for state in states},
        controls={
            "identifier_refresh": BridgeControl(
                "identifier_refresh",
                "button",
                "Refresh",
                capability="refresh",
                attribute="refresh",
                commands=("refresh",),
            )
        },
    )


class WindowSensorPlatformEntityTests(unittest.IsolatedAsyncioTestCase):
    """Lock the exact platform surface for one observed living-room window sensor."""

    async def test_living_room_window_sensor_creates_exactly_four_supported_entities(
        self,
    ) -> None:
        device = _window_sensor("dev_427", "거실 창문센서")
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(
                1,
                True,
                "0.1.93",
                "4",
                {"loc_001": "Home"},
                {},
                {device.device_id: device},
            ),
        )
        entry = FakeEntry(runtime)
        hass = object()
        added: dict[str, list[object]] = {
            "binary_sensor": [],
            "sensor": [],
            "button": [],
            "image": [],
            "update": [],
        }

        await binary_sensor.async_setup_entry(hass, entry, added["binary_sensor"].extend)
        await sensor.async_setup_entry(hass, entry, added["sensor"].extend)
        await button.async_setup_entry(hass, entry, added["button"].extend)
        await image.async_setup_entry(hass, entry, added["image"].extend)
        await update.async_setup_entry(hass, entry, added["update"].extend)

        self.assertEqual(sum(len(entities) for entities in added.values()), 4)
        self.assertEqual(len(added["binary_sensor"]), 1)
        self.assertEqual(len(added["sensor"]), 2)
        self.assertEqual(len(added["button"]), 1)
        self.assertEqual(len(added["image"]), 0)
        self.assertEqual(len(added["update"]), 0)

        self.assertEqual(
            {entity._attr_unique_id for entity in added["binary_sensor"]},
            {"dev_427_main_contactSensor_contact"},
        )
        self.assertIs(added["binary_sensor"][0].is_on, False)

        self.assertEqual(
            {entity._attr_unique_id for entity in added["sensor"]},
            {
                "dev_427_main_battery_battery",
                "dev_427_main_legendabsolute60149.signalMetrics_signalMetrics",
            },
        )
        self.assertEqual(
            {
                entity._attr_unique_id: entity.native_value
                for entity in added["sensor"]
                if entity.state_key[2] == "battery"
            },
            {"dev_427_main_battery_battery": 91},
        )
        self.assertEqual(
            {
                entity._attr_unique_id: entity.native_unit_of_measurement
                for entity in added["sensor"]
                if entity.state_key[2] == "battery"
            },
            {"dev_427_main_battery_battery": "%"},
        )
        self.assertEqual(
            {
                entity._attr_unique_id: entity.native_value
                for entity in added["sensor"]
                if entity.state_key[2] == "signalMetrics"
            },
            {"dev_427_main_legendabsolute60149.signalMetrics_signalMetrics": RAW_SIGNAL_METRICS},
        )

        self.assertEqual(
            {entity._attr_unique_id for entity in added["button"]},
            {"dev_427_button_identifier_refresh"},
        )
        self.assertEqual(added["button"][0]._attr_translation_key, "refresh")
        self.assertFalse(
            any(
                blocked_attribute in entity._attr_unique_id
                for entity in added["sensor"]
                for blocked_attribute in (
                    "imageCapture_image",
                    "imageCapture_imageTransferProgress",
                    "metadata_quantity",
                    "metadata_type",
                    "firmwareUpdate_currentVersion",
                    "firmwareUpdate_availableVersion",
                )
            )
        )

if __name__ == "__main__":
    unittest.main()

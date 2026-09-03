"""Tests for strong Cloud/Local duplicate identity canonicalization."""

from __future__ import annotations

from copy import deepcopy
import importlib
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = ModuleType("smartthings_web")
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
sys.modules.setdefault("smartthings_web", package)

from smartthings_web.models import BridgeControl, BridgeDevice, BridgeState  # noqa: E402


def _state(attribute: str, value: object, updated_at: str) -> BridgeState:
    capability = {
        "switch": "identifier_switch",
        "level": "identifier_level",
        "hue": "identifier_color",
        "saturation": "identifier_color",
        "colorTemperature": "identifier_color_temperature",
    }[attribute]
    return BridgeState(
        "identifier_main",
        capability,
        attribute,
        value,
        None,
        updated_at,
        component_role="main",
    )


def _fireplace(
    device_id: str,
    *,
    context: str,
    parent_device_id: str | None,
    owner_id: str = "identifier_owner",
) -> BridgeDevice:
    values = (
        _state("switch", "off", "2026-08-31T13:25:16Z"),
        _state("level", 1, "2026-08-31T13:10:33Z"),
        _state("hue", 10 if context == "CLOUD" else 0, "2026-08-31T13:24:45Z"),
        _state("saturation", 81 if context == "CLOUD" else 0, "2026-08-31T13:24:45Z"),
        _state(
            "colorTemperature",
            2732 if context == "CLOUD" else 4000,
            "2026-07-05T01:27:46Z" if context == "CLOUD" else "2026-08-31T13:39:35Z",
        ),
    )
    refresh = BridgeControl(
        "advanced:refresh:identifier_main:identifier_refresh",
        "button",
        "Refresh",
        component="identifier_main",
        capability="identifier_refresh",
        attribute="refresh",
        commands=("refresh",),
    )
    device = BridgeDevice(
        device_id,
        "loc_009",
        "identifier_living_room",
        "벽난로",
        "light_bulb",
        True,
        states={state.key: state for state in values},
        controls={refresh.control_id: refresh},
    )
    device.advanced = SimpleNamespace(
        owner_id=owner_id,
        parent_device_id=parent_device_id,
        execution_context=context,
        linked_device_ids=(),
    )
    device.health_updated_at = (
        "2026-08-31T14:01:13Z" if context == "LOCAL" else None
    )
    return device


def _canonicalize(devices: dict[str, BridgeDevice]):
    try:
        module = importlib.import_module("smartthings_web.device_identity")
    except ModuleNotFoundError:
        raise AssertionError("device_identity module is not implemented") from None
    canonicalize = getattr(module, "canonicalize_duplicate_devices", None)
    if canonicalize is None:
        raise AssertionError("canonicalize_duplicate_devices is not implemented")
    return canonicalize(devices)


class DeviceIdentityTests(unittest.TestCase):
    """Merge only a strong one-to-one Cloud/Local mirror."""

    def test_merges_one_strong_cloud_local_pair_and_keeps_cloud_id(self) -> None:
        result = _canonicalize(
            {
                "dev_185": _fireplace(
                    "dev_185", context="CLOUD", parent_device_id=None
                ),
                "dev_602": _fireplace(
                    "dev_602", context="LOCAL", parent_device_id="dev_407"
                ),
            }
        )

        self.assertEqual(set(result.devices), {"dev_185"})
        self.assertEqual(result.aliases, {"dev_602": "dev_185"})
        merged = result.devices["dev_185"]
        color_key = ("identifier_main", "identifier_color_temperature", "colorTemperature")
        self.assertEqual(merged.states[color_key].value, 4000)
        self.assertEqual(merged.health_updated_at, "2026-08-31T14:01:13Z")
        self.assertEqual(merged.advanced.linked_device_ids, ("dev_602",))

    def test_does_not_merge_without_every_strong_pair_guard(self) -> None:
        cases: dict[str, dict[str, BridgeDevice]] = {}

        different_owner_local = _fireplace(
            "dev_602",
            context="LOCAL",
            parent_device_id="dev_407",
            owner_id="identifier_other",
        )
        cases["different owner"] = {
            "dev_185": _fireplace("dev_185", context="CLOUD", parent_device_id=None),
            "dev_602": different_owner_local,
        }

        missing_parent = _fireplace(
            "dev_602", context="LOCAL", parent_device_id=None
        )
        cases["missing local parent"] = {
            "dev_185": _fireplace("dev_185", context="CLOUD", parent_device_id=None),
            "dev_602": missing_parent,
        }

        second_cloud = _fireplace(
            "dev_602", context="CLOUD", parent_device_id="dev_407"
        )
        cases["same execution context"] = {
            "dev_185": _fireplace("dev_185", context="CLOUD", parent_device_id=None),
            "dev_602": second_cloud,
        }

        weak_local = _fireplace(
            "dev_602", context="LOCAL", parent_device_id="dev_407"
        )
        weak_local.states = {
            key: value for key, value in weak_local.states.items() if value.attribute == "switch"
        }
        cases["weak state overlap"] = {
            "dev_185": _fireplace("dev_185", context="CLOUD", parent_device_id=None),
            "dev_602": weak_local,
        }

        unique_control_local = _fireplace(
            "dev_602", context="LOCAL", parent_device_id="dev_407"
        )
        unique_control_local.controls["local-only-toggle"] = BridgeControl(
            "local-only-toggle",
            "toggle",
            "Power",
            component="identifier_main",
            capability="identifier_switch",
            attribute="switch",
            commands=("on", "off"),
        )
        cases["unique local control"] = {
            "dev_185": _fireplace("dev_185", context="CLOUD", parent_device_id=None),
            "dev_602": unique_control_local,
        }

        third = _fireplace(
            "dev_603", context="LOCAL", parent_device_id="dev_407"
        )
        cases["third candidate"] = {
            "dev_185": _fireplace("dev_185", context="CLOUD", parent_device_id=None),
            "dev_602": _fireplace(
                "dev_602", context="LOCAL", parent_device_id="dev_407"
            ),
            "dev_603": third,
        }

        for label, devices in cases.items():
            with self.subTest(label=label):
                original = deepcopy(devices)
                result = _canonicalize(devices)
                self.assertEqual(set(result.devices), set(original))
                self.assertEqual(result.aliases, {})


if __name__ == "__main__":
    unittest.main()

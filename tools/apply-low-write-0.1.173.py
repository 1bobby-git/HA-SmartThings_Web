from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD_VERSION = "0.1.172"
NEW_VERSION = "0.1.173"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:80]!r}")
    write(path, content.replace(old, new, 1))


# Keep every published surface on one release version.
manifest_path = ROOT / "custom_components/smartthings_web/manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if manifest.get("version") != OLD_VERSION:
    raise RuntimeError(f"unexpected manifest version: {manifest.get('version')!r}")
manifest["version"] = NEW_VERSION
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    f"version: {OLD_VERSION}",
    f"version: {NEW_VERSION}",
)
replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    "  log_level: info",
    "  log_level: warning",
)
replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    "  inventory_reconciliation_interval: 21600",
    "  inventory_reconciliation_interval: 86400",
)

# Update release-version constants and current-version assertions without rewriting
# historical changelog headings.
for base in (
    ROOT / "bridge" / "src",
    ROOT / "bridge" / "tests",
    ROOT / "custom_components" / "smartthings_web",
    ROOT / "tests",
):
    if not base.exists():
        continue
    for path in base.rglob("*"):
        if not path.is_file() or path == manifest_path:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if OLD_VERSION in content:
            path.write_text(content.replace(OLD_VERSION, NEW_VERSION), encoding="utf-8")

# Avoid recursively touching the full persistent Chromium profile on every app
# start. Only the first migration repairs mismatched ownership; subsequent starts
# check the three required top-level paths. Ephemeral browser caches are pruned
# only when they exceed a conservative cap and at most once per week.
write(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
    """#!/command/with-contenv sh
set -eu

DATA_DIR="${STW_DATA_DIR:-/data}"
RUN_USER="${STW_RUN_USER:-pwuser}"
RUN_GROUP="${STW_RUN_GROUP:-pwuser}"
PROFILE_DIR="${DATA_DIR}/chromium-profile"
DOWNLOAD_DIR="${DATA_DIR}/downloads"
PERMISSION_MARKER="${DATA_DIR}/.smartthings-web-permissions-v2"
CACHE_MARKER="${DATA_DIR}/.smartthings-web-cache-prune-v1"
CACHE_LIMIT_KB="${STW_BROWSER_CACHE_LIMIT_KB:-131072}"
CACHE_PRUNE_DAYS="${STW_BROWSER_CACHE_PRUNE_DAYS:-7}"

test -d "${DATA_DIR}"
mkdir -p "${PROFILE_DIR}" "${DOWNLOAD_DIR}"

if [ ! -e "${PERMISSION_MARKER}" ]; then
  # Older builds ran chown -R on every start. Scan once and write only paths
  # whose owner is actually wrong, then retain a migration marker.
  find "${DATA_DIR}" -xdev \
    \( ! -user "${RUN_USER}" -o ! -group "${RUN_GROUP}" \) \
    -exec chown -h "${RUN_USER}:${RUN_GROUP}" {} +
  : > "${PERMISSION_MARKER}"
  chown "${RUN_USER}:${RUN_GROUP}" "${PERMISSION_MARKER}"
else
  for required_path in "${DATA_DIR}" "${PROFILE_DIR}" "${DOWNLOAD_DIR}"; do
    owner="$(stat -c '%U:%G' "${required_path}")"
    if [ "${owner}" != "${RUN_USER}:${RUN_GROUP}" ]; then
      chown "${RUN_USER}:${RUN_GROUP}" "${required_path}"
    fi
  done
fi

should_check_cache=false
if [ ! -e "${CACHE_MARKER}" ]; then
  should_check_cache=true
elif [ -n "$(find "${CACHE_MARKER}" -mtime "+${CACHE_PRUNE_DAYS}" -print -quit 2>/dev/null)" ]; then
  should_check_cache=true
fi

if [ "${should_check_cache}" = true ]; then
  cache_kb=0
  for cache_path in \
    "${PROFILE_DIR}/Default/Cache" \
    "${PROFILE_DIR}/Default/Code Cache" \
    "${PROFILE_DIR}/Default/GPUCache" \
    "${PROFILE_DIR}/ShaderCache" \
    "${PROFILE_DIR}/GrShaderCache" \
    "${PROFILE_DIR}/GraphiteDawnCache" \
    "${PROFILE_DIR}/Crashpad/completed" \
    "${PROFILE_DIR}/Crashpad/pending"; do
    if [ -e "${cache_path}" ]; then
      path_kb="$(du -sk "${cache_path}" 2>/dev/null | awk '{print $1}')"
      case "${path_kb}" in
        ''|*[!0-9]*) path_kb=0 ;;
      esac
      cache_kb=$((cache_kb + path_kb))
    fi
  done

  case "${CACHE_LIMIT_KB}" in
    ''|*[!0-9]*) CACHE_LIMIT_KB=131072 ;;
  esac
  if [ "${cache_kb}" -gt "${CACHE_LIMIT_KB}" ]; then
    rm -rf \
      "${PROFILE_DIR}/Default/Cache" \
      "${PROFILE_DIR}/Default/Code Cache" \
      "${PROFILE_DIR}/Default/GPUCache" \
      "${PROFILE_DIR}/ShaderCache" \
      "${PROFILE_DIR}/GrShaderCache" \
      "${PROFILE_DIR}/GraphiteDawnCache" \
      "${PROFILE_DIR}/Crashpad/completed" \
      "${PROFILE_DIR}/Crashpad/pending"
  fi

  # The Bridge never needs old downloaded files after discovery/command work.
  find "${DOWNLOAD_DIR}" -xdev -type f -mtime +7 -delete 2>/dev/null || true
  : > "${CACHE_MARKER}"
  chown "${RUN_USER}:${RUN_GROUP}" "${CACHE_MARKER}"
fi
""",
)

# Bound persistent Chromium cache and disable disk-backed crash/shader artifacts.
replace_once(
    "bridge/src/browser/persistent-context.ts",
    '        "--password-store=basic",\n',
    '        "--password-store=basic",\n'
    '        "--disk-cache-size=67108864",\n'
    '        "--media-cache-size=33554432",\n'
    '        "--disable-gpu-shader-disk-cache",\n'
    '        "--disable-breakpad",\n'
    '        "--disable-crash-reporter",\n',
)

# Do not fan out identical state payloads merely because SmartThings refreshed
# updatedAt. Event entities and timestamp-rendered signal metrics remain exempt.
replace_once(
    "custom_components/smartthings_web/models.py",
    'EVENT_ATTRIBUTES = frozenset({"button"})\n\nFIRMWARE_ATTRIBUTES',
    'EVENT_ATTRIBUTES = frozenset({"button"})\n'
    'TIMESTAMP_SENSITIVE_ATTRIBUTES = frozenset({"signalMetrics"})\n\n'
    'FIRMWARE_ATTRIBUTES',
)
replace_once(
    "custom_components/smartthings_web/models.py",
    """            for key, candidate in latest_device.states.items():
                present = existing.states.get(key)
                if present is None or _state_is_newer(candidate, present):
                    states[key] = deepcopy(candidate)
                elif authoritative:
                    states[key] = deepcopy(present)
""",
    """            for key, candidate in latest_device.states.items():
                present = existing.states.get(key)
                if present is None:
                    states[key] = deepcopy(candidate)
                elif _state_is_newer(candidate, present):
                    states[key] = deepcopy(
                        candidate
                        if _state_update_changes_entity(candidate, present)
                        else present
                    )
                elif authoritative:
                    states[key] = deepcopy(present)
""",
)
replace_once(
    "custom_components/smartthings_web/models.py",
    """        if current is not None and not _state_is_newer(state, current) and not repeated_event:
            return False
        self.inventory.sequence = sequence
        device.states[state.key] = state
        self._notify_listeners(
""",
    """        if current is not None and not _state_is_newer(state, current) and not repeated_event:
            return False
        self.inventory.sequence = sequence
        device.states[state.key] = state
        entity_changed = (
            current is None
            or repeated_event
            or _state_update_changes_entity(state, current)
        )
        if not entity_changed:
            return False
        self._notify_listeners(
""",
)
replace_once(
    "custom_components/smartthings_web/models.py",
    """        changed_device_ids = {
            device_id
            for device_id in current.devices.keys() | merged.devices.keys()
            if current.devices.get(device_id) != merged.devices.get(device_id)
        }
        self.inventory = merged
        self._notify_listeners(device_ids=changed_device_ids)
        return True
""",
    """        changed_device_ids = {
            device_id
            for device_id in current.devices.keys() | merged.devices.keys()
            if current.devices.get(device_id) != merged.devices.get(device_id)
        }
        changed_state_keys = {
            (device_id, state_key)
            for device_id in changed_device_ids
            for state_key in (
                set(current.devices[device_id].states)
                | set(merged.devices[device_id].states)
                if device_id in current.devices and device_id in merged.devices
                else set()
            )
            if current.devices[device_id].states.get(state_key)
            != merged.devices[device_id].states.get(state_key)
        }
        full_state_refresh_ids = {
            device_id
            for device_id in changed_device_ids
            if device_id not in current.devices
            or device_id not in merged.devices
            or current.devices[device_id].online != merged.devices[device_id].online
        }
        scoped_device_ids = changed_device_ids - full_state_refresh_ids
        self.inventory = merged
        notify_global = bool(changed_device_ids)
        if full_state_refresh_ids:
            self._notify_listeners(
                device_ids=full_state_refresh_ids,
                notify_global=notify_global,
            )
            notify_global = False
        if scoped_device_ids:
            self._notify_listeners(
                device_ids=scoped_device_ids,
                state_keys={
                    key for key in changed_state_keys if key[0] in scoped_device_ids
                },
                notify_global=notify_global,
            )
            notify_global = False
        if notify_global:
            self._notify_listeners(
                device_ids=set(),
                state_keys=set(),
                notify_global=True,
            )
        return True
""",
)
replace_once(
    "custom_components/smartthings_web/models.py",
    """def _state_is_newer(candidate: BridgeState, current: BridgeState) -> bool:
    candidate_time = _timestamp(candidate.updated_at)
    current_time = _timestamp(current.updated_at)
    if current_time is None:
        return True
    if candidate_time is None:
        return False
    return candidate_time > current_time


def _merge_device_aliases(
""",
    """def _state_is_newer(candidate: BridgeState, current: BridgeState) -> bool:
    candidate_time = _timestamp(candidate.updated_at)
    current_time = _timestamp(current.updated_at)
    if current_time is None:
        return True
    if candidate_time is None:
        return False
    return candidate_time > current_time


def _state_update_changes_entity(
    candidate: BridgeState,
    current: BridgeState,
) -> bool:
    \"\"\"Return whether a newer pushed state changes HA-visible content.\"\"\"
    if candidate.attribute in EVENT_ATTRIBUTES | TIMESTAMP_SENSITIVE_ATTRIBUTES:
        return True
    return (
        candidate.value != current.value
        or candidate.unit != current.unit
        or candidate.component_role != current.component_role
        or candidate.capability_role != current.capability_role
    )


def _merge_device_aliases(
""",
)

# Keep useful measurements enabled, but make raw/high-frequency diagnostics opt-in
# for newly discovered entities. Existing registry choices are never overridden.
replace_once(
    "custom_components/smartthings_web/sensor.py",
    "from dataclasses import dataclass\n",
    "from dataclasses import dataclass, replace\n",
)
replace_once(
    "custom_components/smartthings_web/sensor.py",
    """async def async_setup_entry(
    hass: HomeAssistant,
""",
    """LOW_WRITE_DIAGNOSTIC_ATTRIBUTES = frozenset(
    {
        "DeviceWatch-DeviceStatus",
        "healthStatus",
        "lqi",
        "rssi",
        "signalMetrics",
        "status",
        "value",
    }
)


def _sensor_description(attribute: str) -> SensorDescription:
    \"\"\"Return one description with noisy/raw diagnostics opt-in by default.\"\"\"
    description = SENSOR_STATES.get(attribute)
    if description is None:
        return SensorDescription(
            _attribute_name(attribute),
            state_class=None,
            entity_category=EntityCategory.DIAGNOSTIC,
            enabled_default=False,
        )
    if attribute in LOW_WRITE_DIAGNOSTIC_ATTRIBUTES and description.enabled_default:
        return replace(description, enabled_default=False)
    return description


async def async_setup_entry(
    hass: HomeAssistant,
""",
)
replace_once(
    "custom_components/smartthings_web/sensor.py",
    """                description = SENSOR_STATES.get(state.attribute) or SensorDescription(
                    _attribute_name(state.attribute),
                    state_class=None,
                    entity_category=EntityCategory.DIAGNOSTIC,
                )
""",
    """                description = _sensor_description(state.attribute)
""",
)

# Release notes are consumed by the automated release workflow.
changelog_path = "addon/smartthings_web_bridge/CHANGELOG.md"
changelog = read(changelog_path)
if not changelog.startswith(f"## {OLD_VERSION}\n"):
    raise RuntimeError("unexpected changelog head")
write(
    changelog_path,
    f"""## {NEW_VERSION}

- 동일한 SmartThings 상태값이 `updatedAt`만 바뀌어 반복 수신되면 sequence와 내부 시각만 갱신하고 Home Assistant 상태 쓰기는 생략해 Recorder·WebSocket·디스크 부하를 줄입니다.
- 전체 인벤토리 갱신에서도 실제로 변경된 상태 엔티티만 알리고, 온라인 상태가 변한 기기만 전체 엔티티를 새로 쓰도록 알림 범위를 축소했습니다.
- 알 수 없는 원시 속성과 RSSI·LQI·신호 메트릭·장치 상태 계열 진단 센서는 신규 등록 시 기본 비활성화하며 기존 사용자의 활성화 선택은 보존합니다.
- Bridge 시작마다 실행되던 `/data` 전체 `chown -R`을 1회 권한 마이그레이션과 상위 디렉터리 점검으로 바꾸고, Chromium 캐시·미디어 캐시·크래시 파일의 상한 및 주기적 정리를 추가했습니다.
- 신규 설치의 기본 로그 수준을 `warning`, 전체 인벤토리 재조정 주기를 24시간으로 조정했습니다. 기존 사용자가 직접 지정한 설정은 변경하지 않습니다.

"""
    + changelog,
)

write(
    "docs/storage-write-optimization.md",
    """# 저장공간 및 쓰기 부하 최적화

SmartThings Web 0.1.173부터 동일 상태값의 반복 보고, 원시 진단 엔티티, Chromium 캐시와 시작 시 권한 변경으로 발생하던 불필요한 쓰기를 줄입니다.

## 기존 설치에서 권장하는 앱 설정

```yaml
log_level: warning
debug_protocol_logging: false
inventory_reconciliation_interval: 86400
```

기존 앱 옵션은 업데이트 시 자동으로 덮어쓰지 않습니다. 앱 설정 화면에서 위 값으로 직접 변경하면 됩니다.

## 진단 엔티티

RSSI, LQI, Received Signal Metrics, Device status 및 알 수 없는 원시 속성은 새로 발견될 때 기본 비활성화됩니다. 이미 활성화한 엔티티는 사용자 선택을 존중해 그대로 유지됩니다. 필요하지 않은 기존 진단 엔티티는 장치의 **엔티티 → 비활성화된 엔티티 표시 → 사용 중지**에서 끌 수 있습니다.

## Chromium 데이터 보존

로그인 유지에 필요한 Cookie, Local Storage, IndexedDB와 세션 데이터는 삭제하지 않습니다. 다음과 같은 재생성 가능한 데이터만 제한합니다.

- 일반 HTTP 캐시
- Code Cache 및 GPU/Shader Cache
- 완료·대기 중인 Crashpad 파일
- 7일이 지난 임시 다운로드

캐시 정리는 매 시작마다 실행하지 않고 최대 주 1회 확인하며, 대상 캐시 합계가 128 MiB를 넘을 때만 삭제합니다.

## 한계

Proxmox LVM-thin 풀 사용률은 컨테이너 내부에서 확인할 수 없습니다. 호스트의 `local-lvm`이 100%가 되면 통합이 쓰기를 줄이더라도 모든 VM에 I/O 오류가 발생할 수 있으므로 Proxmox에서 공간을 먼저 확보해야 합니다.
""",
)

write(
    "custom_components/smartthings_web/tests/test_low_write_runtime.py",
    """from __future__ import annotations

from copy import deepcopy

from custom_components.smartthings_web.models import (
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)
from custom_components.smartthings_web.sensor import _sensor_description


def _state(attribute: str, value: object, updated_at: str) -> BridgeState:
    return BridgeState(
        component="main",
        capability=f"test.{attribute}",
        attribute=attribute,
        value=value,
        unit=None,
        updated_at=updated_at,
    )


def _runtime(*states: BridgeState) -> SmartThingsWebRuntime:
    device = BridgeDevice(
        device_id="device-1",
        location_id="location-1",
        room_id=None,
        name="Test device",
        device_type="sensor",
        online=True,
        states={state.key: state for state in states},
    )
    inventory = BridgeInventory(
        sequence=1,
        ready=True,
        bridge_version="0.1.173",
        protocol_version="1",
        locations={"location-1": "Home"},
        rooms={},
        devices={device.device_id: device},
    )
    return SmartThingsWebRuntime(
        client=object(),
        location_id="location-1",
        inventory=inventory,
    )


def _event(state: BridgeState, sequence: int) -> dict[str, object]:
    return {
        "type": "state",
        "sequence": sequence,
        "deviceId": "device-1",
        "state": {
            "component": state.component,
            "capability": state.capability,
            "attribute": state.attribute,
            "value": state.value,
            "unit": state.unit,
            "updatedAt": state.updated_at,
        },
    }


def test_same_payload_new_timestamp_advances_without_entity_write() -> None:
    current = _state("temperature", 23.5, "2026-09-04T00:00:00+00:00")
    runtime = _runtime(current)
    writes: list[str] = []
    runtime.subscribe_state("device-1", current.key, lambda: writes.append("temperature"))

    refreshed = _state("temperature", 23.5, "2026-09-04T00:01:00+00:00")

    assert runtime.apply_state(_event(refreshed, 2)) is False
    assert runtime.inventory.sequence == 2
    assert runtime.inventory.devices["device-1"].states[current.key].updated_at == refreshed.updated_at
    assert writes == []


def test_changed_payload_notifies_only_changed_state() -> None:
    temperature = _state("temperature", 23.5, "2026-09-04T00:00:00+00:00")
    humidity = _state("humidity", 55, "2026-09-04T00:00:00+00:00")
    runtime = _runtime(temperature, humidity)
    writes: list[str] = []
    runtime.subscribe_state("device-1", temperature.key, lambda: writes.append("temperature"))
    runtime.subscribe_state("device-1", humidity.key, lambda: writes.append("humidity"))

    latest = deepcopy(runtime.inventory)
    latest.sequence = 2
    latest.devices["device-1"].states[temperature.key] = _state(
        "temperature", 24.0, "2026-09-04T00:01:00+00:00"
    )
    latest.devices["device-1"].states[humidity.key] = _state(
        "humidity", 55, "2026-09-04T00:01:00+00:00"
    )

    assert runtime.apply_inventory(latest) is True
    assert writes == ["temperature"]


def test_signal_metrics_timestamp_remains_visible() -> None:
    current = _state(
        "signalMetrics",
        {"lqi": 90, "rssi": -55},
        "2026-09-04T00:00:00+00:00",
    )
    runtime = _runtime(current)
    writes: list[str] = []
    runtime.subscribe_state("device-1", current.key, lambda: writes.append("signal"))

    refreshed = _state(
        "signalMetrics",
        {"lqi": 90, "rssi": -55},
        "2026-09-04T00:01:00+00:00",
    )

    assert runtime.apply_state(_event(refreshed, 2)) is True
    assert writes == ["signal"]


def test_noisy_and_unknown_diagnostics_are_opt_in() -> None:
    assert _sensor_description("temperature").enabled_default is True
    assert _sensor_description("signalMetrics").enabled_default is False
    assert _sensor_description("mnmo").enabled_default is False
""",
)

write(
    "custom_components/smartthings_web/tests/test_low_write_assets.py",
    """from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_data_prep_does_not_recursively_chown_every_start() -> None:
    script = (
        ROOT
        / "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data"
    ).read_text(encoding="utf-8")
    assert "exec chown -R" not in script
    assert ".smartthings-web-permissions-v2" in script
    assert ".smartthings-web-cache-prune-v1" in script
    assert "CACHE_LIMIT_KB" in script


def test_low_write_defaults_are_packaged() -> None:
    config = (ROOT / "addon/smartthings_web_bridge/config.yaml").read_text(
        encoding="utf-8"
    )
    assert "version: 0.1.173" in config
    assert "  log_level: warning" in config
    assert "  inventory_reconciliation_interval: 86400" in config
""",
)

write(
    "bridge/tests/persistent-context-low-write.test.ts",
    """import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createPersistentContextLaunch } from "../src/browser/persistent-context.js";

describe("persistent Chromium low-write settings", () => {
  test("bounds caches and disables persistent crash and shader artifacts", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stw-low-write-"));
    const launch = createPersistentContextLaunch({
      dataDir,
      profileDir: join(dataDir, "chromium-profile"),
      downloadDir: join(dataDir, "downloads")
    });

    expect(launch.options.args).toEqual(expect.arrayContaining([
      "--disk-cache-size=67108864",
      "--media-cache-size=33554432",
      "--disable-gpu-shader-disk-cache",
      "--disable-breakpad",
      "--disable-crash-reporter"
    ]));
  });
});
""",
)

print(f"Applied low-write release {NEW_VERSION}")

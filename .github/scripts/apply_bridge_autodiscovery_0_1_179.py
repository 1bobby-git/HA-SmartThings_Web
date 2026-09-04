from __future__ import annotations

import json
from pathlib import Path

VERSION = "0.1.179"
PREVIOUS = "0.1.178"
CURRENT_REPOSITORY_HOST = "8a97f131-smartthings-web-bridge"
LEGACY_REPOSITORY_HOST = "d55cafb9-smartthings-web-bridge"


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected exactly one match for {old!r}, found {count}"
        )
    write(path, content.replace(old, new, 1))


def create_text(path: str, content: str) -> None:
    target = Path(path)
    if target.exists():
        raise SystemExit(f"{path}: expected a new file")
    write(path, content)


def update_json(path: str, mutate) -> None:
    value = json.loads(read(path))
    mutate(value)
    write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


# Keep the current Supervisor-generated repository hostname first, while retaining
# the local app and former repository hostname as migration-safe fallbacks.
replace_once(
    "custom_components/smartthings_web/const.py",
    '''REPOSITORY_BRIDGE_URL = "http://d55cafb9-smartthings-web-bridge:8100"
LOCAL_BRIDGE_URL = "http://local-smartthings-web-bridge:8100"
KNOWN_BRIDGE_URLS = (REPOSITORY_BRIDGE_URL, LOCAL_BRIDGE_URL)
DEFAULT_BRIDGE_URL = REPOSITORY_BRIDGE_URL
''',
    '''BRIDGE_ADDON_SLUG = "smartthings_web_bridge"
BRIDGE_INTERNAL_PORT = 8100
REPOSITORY_BRIDGE_URL = "http://8a97f131-smartthings-web-bridge:8100"
LOCAL_BRIDGE_URL = "http://local-smartthings-web-bridge:8100"
LEGACY_REPOSITORY_BRIDGE_URL = "http://d55cafb9-smartthings-web-bridge:8100"
KNOWN_BRIDGE_URLS = (
    REPOSITORY_BRIDGE_URL,
    LOCAL_BRIDGE_URL,
    LEGACY_REPOSITORY_BRIDGE_URL,
)
DEFAULT_BRIDGE_URL = REPOSITORY_BRIDGE_URL
''',
)
replace_once(
    "custom_components/smartthings_web/const.py",
    '''def bridge_url_candidates(value: str) -> tuple[str, ...]:
    """Return safe candidates for repository and manually installed local apps."""
''',
    '''def bridge_url_candidates(value: str) -> tuple[str, ...]:
    """Return current, local, and legacy Supervisor app URL candidates."""
''',
)

# Accept the standard Home Assistant app discovery payload and use the exact
# runtime hostname reported by Supervisor. Manual setup remains available.
replace_once(
    "custom_components/smartthings_web/config_flow.py",
    '''from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession
''',
    '''from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
''',
)
replace_once(
    "custom_components/smartthings_web/config_flow.py",
    '''from .const import (
    CONF_BRIDGE_TOKEN,
''',
    '''from .const import (
    BRIDGE_ADDON_SLUG,
    BRIDGE_INTERNAL_PORT,
    CONF_BRIDGE_TOKEN,
''',
)
replace_once(
    "custom_components/smartthings_web/config_flow.py",
    '''    VERSION = 1
    _pending_pairing: tuple[str, str, BridgeInventory] | None = None
    _reauth_data: dict[str, Any] | None = None

    @staticmethod
''',
    '''    VERSION = 1
    _pending_pairing: tuple[str, str, BridgeInventory] | None = None
    _reauth_data: dict[str, Any] | None = None
    _discovered_bridge_url: str | None = None

    @staticmethod
''',
)
replace_once(
    "custom_components/smartthings_web/config_flow.py",
    '''    async def async_step_user(self, user_input: dict[str, Any] | None = None):
''',
    '''    async def async_step_hassio(self, discovery_info: HassioServiceInfo):
        """Use the exact internal Bridge address published by its Supervisor app."""
        slug = discovery_info.slug
        if not isinstance(slug, str) or (
            slug != BRIDGE_ADDON_SLUG
            and not slug.endswith(f"_{BRIDGE_ADDON_SLUG}")
        ):
            return self.async_abort(reason="not_smartthings_web_bridge")

        host = discovery_info.config.get("host")
        port = discovery_info.config.get("port")
        expected_host = slug.replace("_", "-")
        if (
            not isinstance(host, str)
            or host != expected_host
            or isinstance(port, bool)
            or not isinstance(port, int)
            or port != BRIDGE_INTERNAL_PORT
        ):
            return self.async_abort(reason="invalid_discovery")

        self._discovered_bridge_url = f"http://{host}:{port}"
        return await self.async_step_user()

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
''',
)
replace_once(
    "custom_components/smartthings_web/config_flow.py",
    '''        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_BRIDGE_URL, default=DEFAULT_BRIDGE_URL): str,
                    vol.Required("pairing_code"): str,
                }
            ),
            errors=errors,
        )
''',
    '''        bridge_url_default = self._discovered_bridge_url or DEFAULT_BRIDGE_URL
        if user_input is not None and isinstance(
            user_input.get(CONF_BRIDGE_URL), str
        ):
            bridge_url_default = user_input[CONF_BRIDGE_URL]

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_BRIDGE_URL, default=bridge_url_default): str,
                    vol.Required("pairing_code"): str,
                }
            ),
            errors=errors,
        )
''',
)

# Enable Supervisor discovery and publish only the private Core-facing 8100 port.
replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    f"version: {PREVIOUS}",
    f"version: {VERSION}",
)
replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    '''panel_admin: true
homeassistant_api: true
watchdog: http://[HOST]:[PORT:8099]/health/live
''',
    '''panel_admin: true
homeassistant_api: true
hassio_api: true
discovery:
  - smartthings_web
watchdog: http://[HOST]:[PORT:8099]/health/live
''',
)

publish_discovery = '''#!/command/with-contenv sh
set -u
umask 077

log() {
  printf '%s\\n' "$1" >&2
}

if [ -z "${SUPERVISOR_TOKEN:-}" ]; then
  log "bridge_discovery:skipped:no_supervisor_token"
  exit 0
fi

bridge_ready=0
attempt=0
while [ "$attempt" -lt 120 ]; do
  if curl -fsS --max-time 2 http://127.0.0.1:8098/health/live >/dev/null 2>&1; then
    bridge_ready=1
    break
  fi
  attempt=$((attempt + 1))
  s6-sleep -m 500
done

if [ "$bridge_ready" -ne 1 ]; then
  log "bridge_discovery:skipped:bridge_not_ready"
  exit 0
fi

bridge_host="$(hostname)"
case "$bridge_host" in
  ""|*[!a-z0-9-]*|-*|*-)
    log "bridge_discovery:skipped:invalid_hostname"
    exit 0
    ;;
esac
case "$bridge_host" in
  smartthings-web-bridge|*-smartthings-web-bridge)
    ;;
  *)
    log "bridge_discovery:skipped:unexpected_hostname"
    exit 0
    ;;
esac

payload="$(printf '{\"service\":\"smartthings_web\",\"config\":{\"host\":\"%s\",\"port\":8100}}' "$bridge_host")"
curl_config="$(mktemp /tmp/smartthings-web-discovery.XXXXXX)" || {
  log "bridge_discovery:failed:temporary_config"
  exit 0
}
trap 'rm -f -- "$curl_config"' EXIT HUP INT TERM
printf 'header = "Authorization: Bearer %s"\\nheader = "Content-Type: application/json"\\n' \
  "$SUPERVISOR_TOKEN" > "$curl_config"

if curl -fsS --max-time 10 \
  --config "$curl_config" \
  --request POST \
  --data "$payload" \
  http://supervisor/discovery >/dev/null; then
  log "bridge_discovery:published:${bridge_host}:8100"
else
  log "bridge_discovery:failed:supervisor_request"
fi

exit 0
'''
create_text(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/publish-discovery",
    publish_discovery,
)
create_text(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/bridge-discovery/type",
    "oneshot\n",
)
create_text(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/bridge-discovery/up",
    "/etc/s6-overlay/scripts/publish-discovery\n",
)
create_text(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/bridge-discovery/dependencies.d/bridge",
    "",
)
create_text(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/bridge-discovery/dependencies.d/nginx",
    "",
)
create_text(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/user-bundles.d/user/contents.d/bridge-discovery",
    "",
)

# Config-flow unit tests run without Home Assistant installed, so provide the
# service-info module used only for type import and then exercise real defaults.
replace_once(
    "custom_components/smartthings_web/tests/test_config_flow.py",
    '''    aiohttp_client.async_get_clientsession = lambda _hass: object()  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.aiohttp_client"] = aiohttp_client
''',
    '''    aiohttp_client.async_get_clientsession = lambda _hass: object()  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.aiohttp_client"] = aiohttp_client

    service_info = ModuleType("homeassistant.helpers.service_info")
    service_info.__path__ = []  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.service_info"] = service_info
    hassio_service_info = ModuleType("homeassistant.helpers.service_info.hassio")
    hassio_service_info.HassioServiceInfo = SimpleNamespace  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.service_info.hassio"] = hassio_service_info
''',
)
replace_once(
    "custom_components/smartthings_web/tests/test_config_flow.py",
    '''    CONTROL_MODE_READ_ONLY,
    CONTROL_MODE_SAFE_CONTROL,
)
''',
    '''    CONTROL_MODE_READ_ONLY,
    CONTROL_MODE_SAFE_CONTROL,
    DEFAULT_BRIDGE_URL,
)
''',
)
replace_once(
    "custom_components/smartthings_web/tests/test_config_flow.py",
    '''    async def test_new_pairing_stores_the_reachable_repository_hostname(self) -> None:
''',
    '''    async def test_manual_flow_defaults_to_current_repository_hostname(self) -> None:
        flow = SmartThingsWebConfigFlow()

        result = await flow.async_step_user()
        values = result["data_schema"]({"pairing_code": "12345678"})

        self.assertEqual(result["type"], "form")
        self.assertEqual(values[CONF_BRIDGE_URL], DEFAULT_BRIDGE_URL)

    async def test_hassio_discovery_prefills_exact_runtime_hostname(self) -> None:
        flow = SmartThingsWebConfigFlow()

        result = await flow.async_step_hassio(
            SimpleNamespace(
                slug="8a97f131_smartthings_web_bridge",
                config={
                    "host": "8a97f131-smartthings-web-bridge",
                    "port": 8100,
                },
            )
        )
        values = result["data_schema"]({"pairing_code": "12345678"})

        self.assertEqual(result["type"], "form")
        self.assertEqual(
            values[CONF_BRIDGE_URL],
            "http://8a97f131-smartthings-web-bridge:8100",
        )

    async def test_hassio_discovery_rejects_mismatched_hostname(self) -> None:
        flow = SmartThingsWebConfigFlow()

        result = await flow.async_step_hassio(
            SimpleNamespace(
                slug="8a97f131_smartthings_web_bridge",
                config={
                    "host": "d55cafb9-smartthings-web-bridge",
                    "port": 8100,
                },
            )
        )

        self.assertEqual(result, {"type": "abort", "reason": "invalid_discovery"})

    async def test_new_pairing_stores_the_reachable_repository_hostname(self) -> None:
''',
)
config_flow_test = read("custom_components/smartthings_web/tests/test_config_flow.py")
config_flow_test = config_flow_test.replace(
    "http://d55cafb9-smartthings-web-bridge:8100",
    "http://8a97f131-smartthings-web-bridge:8100",
)
write("custom_components/smartthings_web/tests/test_config_flow.py", config_flow_test)

bridge_client_test_path = "custom_components/smartthings_web/tests/test_bridge_client.py"
bridge_client_test = read(bridge_client_test_path).replace(
    "http://d55cafb9-smartthings-web-bridge:8100",
    "http://8a97f131-smartthings-web-bridge:8100",
)
write(bridge_client_test_path, bridge_client_test)
replace_once(
    bridge_client_test_path,
    '''        accepted = (
            "http://local-smartthings-web-bridge:8100",
''',
    '''        accepted = (
            "http://8a97f131-smartthings-web-bridge:8100",
            "http://local-smartthings-web-bridge:8100",
''',
)
replace_once(
    bridge_client_test_path,
    '''            (
                "http://8a97f131-smartthings-web-bridge:8100",
                "http://local-smartthings-web-bridge:8100",
            ),
        )

    async def test_inventory_falls_back_to_repository_addon_hostname(self) -> None:
''',
    '''            (
                "http://8a97f131-smartthings-web-bridge:8100",
                "http://local-smartthings-web-bridge:8100",
                "http://d55cafb9-smartthings-web-bridge:8100",
            ),
        )

    def test_keeps_legacy_repository_hostname_as_migration_fallback(self) -> None:
        client = SmartThingsWebBridgeClient(
            object(),
            "http://d55cafb9-smartthings-web-bridge:8100/",
        )  # type: ignore[arg-type]

        self.assertEqual(
            client._base_urls,
            (
                "http://d55cafb9-smartthings-web-bridge:8100",
                "http://8a97f131-smartthings-web-bridge:8100",
                "http://local-smartthings-web-bridge:8100",
            ),
        )

    async def test_inventory_falls_back_to_repository_addon_hostname(self) -> None:
''',
)

# Add a repository-level contract test for discovery, least privilege and docs.
contract_test = '''import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

const readText = (path: string) => readFileSync(path, "utf8");

describe("Supervisor Bridge URL autodiscovery", () => {
  test("publishes the private runtime hostname and port through app discovery", () => {
    const config = YAML.parse(
      readText("addon/smartthings_web_bridge/config.yaml")
    ) as Record<string, unknown>;
    const script = readText(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/publish-discovery"
    );

    expect(config.hassio_api).toBe(true);
    expect(config.discovery).toEqual(["smartthings_web"]);
    expect(config).not.toHaveProperty("ports");
    expect(config).not.toHaveProperty("host_network");
    expect(script).toContain('bridge_host="$(hostname)"');
    expect(script).toContain('"service":"smartthings_web"');
    expect(script).toContain('"port":8100');
    expect(script).toContain("http://127.0.0.1:8098/health/live");
    expect(script).toContain("http://supervisor/discovery");
    expect(script).toContain('Authorization: Bearer %s');
    expect(script).not.toContain('log "$SUPERVISOR_TOKEN"');
  });

  test("starts discovery after the Bridge and Core-only nginx proxy", () => {
    const root = "addon/smartthings_web_bridge/rootfs/etc/s6-overlay";

    expect(readText(`${root}/s6-rc.d/bridge-discovery/type`).trim()).toBe("oneshot");
    expect(readText(`${root}/s6-rc.d/bridge-discovery/up`).trim()).toBe(
      "/etc/s6-overlay/scripts/publish-discovery"
    );
    expect(readText(`${root}/s6-rc.d/bridge-discovery/dependencies.d/bridge`)).toBe("");
    expect(readText(`${root}/s6-rc.d/bridge-discovery/dependencies.d/nginx`)).toBe("");
    expect(readText(`${root}/user-bundles.d/user/contents.d/bridge-discovery`)).toBe("");
  });

  test("prefers the currently observed Supervisor hostname and retains migrations", () => {
    const constants = readText("custom_components/smartthings_web/const.py");
    const flow = readText("custom_components/smartthings_web/config_flow.py");
    const readme = readText("README.md");

    expect(constants).toContain(
      'REPOSITORY_BRIDGE_URL = "http://8a97f131-smartthings-web-bridge:8100"'
    );
    expect(constants).toContain(
      'LEGACY_REPOSITORY_BRIDGE_URL = "http://d55cafb9-smartthings-web-bridge:8100"'
    );
    expect(constants).toContain(
      'LOCAL_BRIDGE_URL = "http://local-smartthings-web-bridge:8100"'
    );
    expect(flow).toContain("async def async_step_hassio");
    expect(flow).toContain('expected_host = slug.replace("_", "-")');
    expect(flow).toContain("bridge_url_default = self._discovered_bridge_url or DEFAULT_BRIDGE_URL");
    expect(readme).toContain("Bridge 주소가 자동 입력");
  });
});
'''
create_text("tests/bridge-autodiscovery-contract.test.ts", contract_test)

# Extend existing add-on packaging tests with the new service and permission.
addon_test = "tests/addon-config.test.ts"
replace_once(
    addon_test,
    f'test("packages HAOS chmod ownership recovery as version {PREVIOUS}"',
    f'test("packages Bridge URL autodiscovery as version {VERSION}"',
)
for old, new in (
    (f'expect(config.version).toBe("{PREVIOUS}");', f'expect(config.version).toBe("{VERSION}");'),
    (f'expect(packageMetadata.version).toBe("{PREVIOUS}");', f'expect(packageMetadata.version).toBe("{VERSION}");'),
    (f'expect(protocolMetadata.bridge_version).toBe("{PREVIOUS}");', f'expect(protocolMetadata.bridge_version).toBe("{VERSION}");'),
    (f'expect(runtime).toContain(\'const bridgeVersion = "{PREVIOUS}";\');', f'expect(runtime).toContain(\'const bridgeVersion = "{VERSION}";\');'),
    (f'expect(changelog).toContain("## {PREVIOUS}");', f'expect(changelog).toContain("## {VERSION}");\n    expect(changelog).toContain("## {PREVIOUS}");'),
):
    replace_once(addon_test, old, new)
replace_once(
    addon_test,
    '''    expect(config.homeassistant_api).toBe(true);
''',
    '''    expect(config.homeassistant_api).toBe(true);
    expect(config.hassio_api).toBe(true);
    expect(config.discovery).toEqual(["smartthings_web"]);
''',
)
replace_once(
    addon_test,
    '''    expect(readText(`${serviceRoot}/bridge/dependencies.d/data-prep`).trim()).toBe("");
    expect(readText(`${serviceRoot}/data-prep/type`).trim()).toBe("oneshot");
''',
    '''    expect(readText(`${serviceRoot}/bridge/dependencies.d/data-prep`).trim()).toBe("");
    expect(readText(`${serviceRoot}/bridge-discovery/type`).trim()).toBe("oneshot");
    expect(readText(`${serviceRoot}/bridge-discovery/dependencies.d/bridge`).trim()).toBe("");
    expect(readText(`${serviceRoot}/bridge-discovery/dependencies.d/nginx`).trim()).toBe("");
    expect(readText(`${serviceRoot}/bridge-discovery/up`).trim()).toBe(
      "/etc/s6-overlay/scripts/publish-discovery"
    );
    expect(readText(`${serviceRoot}/data-prep/type`).trim()).toBe("oneshot");
''',
)
replace_once(
    addon_test,
    '''    for (const service of ["bridge", "data-prep", "nginx", "novnc", "openbox", "profile-maintenance", "x11vnc", "xvfb", "xvfb-ready"]) {
''',
    '''    for (const service of ["bridge", "bridge-discovery", "data-prep", "nginx", "novnc", "openbox", "profile-maintenance", "x11vnc", "xvfb", "xvfb-ready"]) {
''',
)

# Update every release surface.
update_json("package.json", lambda value: value.__setitem__("version", VERSION))
update_json(
    "package-lock.json",
    lambda value: (
        value.__setitem__("version", VERSION),
        value["packages"][""].__setitem__("version", VERSION),
    ),
)
update_json(
    "protocol/version.json", lambda value: value.__setitem__("bridge_version", VERSION)
)
update_json(
    "custom_components/smartthings_web/manifest.json",
    lambda value: value.__setitem__("version", VERSION),
)
replace_once(
    "bridge/src/runtime.ts",
    f'const bridgeVersion = "{PREVIOUS}";',
    f'const bridgeVersion = "{VERSION}";',
)
replace_once(
    "tests/protocol-version-contract.test.ts",
    f"packaged {PREVIOUS} candidate",
    f"packaged {VERSION} candidate",
)
replace_once(
    "tests/protocol-version-contract.test.ts",
    f'const expectedBridgeVersion = "{PREVIOUS}";',
    f'const expectedBridgeVersion = "{VERSION}";',
)

# Update user-facing descriptions without removing manual override capability.
for path in ("README.md", "addon/smartthings_web_bridge/README.md"):
    content = read(path)
    content = content.replace(
        "addon=d55cafb9_smartthings_web_bridge",
        "addon=8a97f131_smartthings_web_bridge",
    )
    write(path, content)
replace_once(
    "addon/smartthings_web_bridge/README.md",
    '''앱 저장소 설치의 내부 주소는 `http://d55cafb9-smartthings-web-bridge:8100`, `/addons` 수동 로컬 설치의 내부 주소는 `http://local-smartthings-web-bridge:8100`입니다. 통합 0.1.169부터 두 주소를 안전하게 확인하고 실제 응답한 주소를 구성 항목에 저장합니다.
''',
    '''앱은 시작할 때 Supervisor에 실제 런타임 hostname과 Core 전용 포트 `8100`을 게시합니다. 통합 추가 화면은 이 값을 받아 Bridge 주소를 자동 입력합니다. 현재 저장소 설치의 내부 주소는 `http://8a97f131-smartthings-web-bridge:8100`, `/addons` 수동 로컬 설치 주소는 `http://local-smartthings-web-bridge:8100`이며, 이전 `d55cafb9` 주소도 기존 구성 복구용 후보로만 유지합니다.
''',
)
replace_once(
    "README.md",
    '''3. 앱 저장소로 설치했다면 기본값인 `http://d55cafb9-smartthings-web-bridge:8100`을 사용하고, `/addons`에 수동 로컬 설치했다면 `http://local-smartthings-web-bridge:8100`을 사용합니다.
4. 8자리 페어링 코드를 입력하고 연결할 SmartThings 위치를 선택합니다.

0.1.169부터 두 내부 호스트를 안전하게 순차 확인하여 실제 응답한 주소를 구성 항목에 저장합니다. 따라서 기존 구성에 잘못된 `local` 또는 `d55cafb9` 주소가 남아 있어도 설치된 앱 주소로 자동 복구됩니다.
''',
    '''3. 앱이 Supervisor에 게시한 실제 내부 주소가 **Bridge 주소** 칸에 자동 입력되는지 확인합니다. 현재 저장소 설치 주소는 `http://8a97f131-smartthings-web-bridge:8100`, `/addons` 수동 로컬 설치 주소는 `http://local-smartthings-web-bridge:8100`입니다.
4. 8자리 페어링 코드를 입력하고 연결할 SmartThings 위치를 선택합니다.

0.1.179부터 앱 discovery가 실제 `{REPO}_{SLUG}` 런타임 hostname과 Core 전용 `8100` 포트를 통합에 전달합니다. 수동 설정에서도 현재 저장소 주소가 기본값이며, 이전 `d55cafb9` 주소와 `local` 주소는 기존 구성 복구용으로 안전하게 순차 확인한 뒤 실제 응답한 주소를 저장합니다.
''',
)
replace_once(
    "addon/smartthings_web_bridge/DOCS.md",
    '''After the Bridge reaches `CONNECTED`, generate a ten-minute pairing code on its status page and add the `SmartThings Web` integration. Select the SmartThings location to add. As of 0.1.79, the limited alpha exposes all normalized pushed attributes plus binary sensors, switches, lights, buttons, numeric controls, fans, media players, updates, events, covers, climate entities, scenes, SmartThings Home Monitor, and refreshed camera stills. SmartThings Web-only state that the official integration does not model is kept as diagnostic sensors instead of being deleted. Clear domain values are grouped under their primary Home Assistant entities, while raw SmartThings Web content remains available as attributes. It never polls SmartThings state and never changes Home Assistant state optimistically; a command completes only after a newer SmartThings Web push confirms it. Synthetic refresh controls are not created unless a real observed SmartThings Web button control exists.
''',
    '''On Supervisor installations, the app publishes its exact runtime hostname and Core-only port `8100` through app discovery after the Bridge health endpoint is ready. The integration uses that value to prefill the Bridge URL. Manual setup remains available, and current repository, local-install, and legacy repository hostnames are tried only as private migration fallbacks.

After the Bridge reaches `CONNECTED`, generate a ten-minute pairing code on its status page and add the `SmartThings Web` integration. Select the SmartThings location to add. As of 0.1.79, the limited alpha exposes all normalized pushed attributes plus binary sensors, switches, lights, buttons, numeric controls, fans, media players, updates, events, covers, climate entities, scenes, SmartThings Home Monitor, and refreshed camera stills. SmartThings Web-only state that the official integration does not model is kept as diagnostic sensors instead of being deleted. Clear domain values are grouped under their primary Home Assistant entities, while raw SmartThings Web content remains available as attributes. It never polls SmartThings state and never changes Home Assistant state optimistically; a command completes only after a newer SmartThings Web push confirms it. Synthetic refresh controls are not created unless a real observed SmartThings Web button control exists.
''',
)

replace_once(
    "custom_components/smartthings_web/strings.json",
    '"description": "Open the Bridge add-on and generate a pairing code.",',
    '"description": "The Bridge address discovered from the app is filled automatically. Generate a pairing code in the Bridge app.",',
)
replace_once(
    "custom_components/smartthings_web/strings.json",
    '"invalid_flow": "Restart setup and pair with the Bridge again"',
    '"invalid_flow": "Restart setup and pair with the Bridge again",\n      "not_smartthings_web_bridge": "The discovery did not come from the SmartThings Web Bridge app",\n      "invalid_discovery": "The Bridge app published an invalid internal address"',
)
replace_once(
    "custom_components/smartthings_web/translations/ko.json",
    '"description": "Bridge 애드온에서 페어링 코드를 생성한 뒤 입력하세요.",',
    '"description": "앱에서 자동 감지한 Bridge 주소가 입력됩니다. Bridge 앱에서 페어링 코드를 생성한 뒤 입력하세요.",',
)
replace_once(
    "custom_components/smartthings_web/translations/ko.json",
    '"invalid_flow": "설정을 다시 시작하고 Bridge와 다시 페어링하세요"',
    '"invalid_flow": "설정을 다시 시작하고 Bridge와 다시 페어링하세요",\n      "not_smartthings_web_bridge": "SmartThings Web Bridge 앱에서 전달된 검색 정보가 아닙니다",\n      "invalid_discovery": "Bridge 앱이 잘못된 내부 주소를 전달했습니다"',
)

# Prepend release notes last so all behavior described above is represented.
changelog_path = "addon/smartthings_web_bridge/CHANGELOG.md"
changelog = read(changelog_path)
if f"## {VERSION}" in changelog:
    raise SystemExit(f"{changelog_path}: version already exists")
notes = f'''## {VERSION}

- 실제 Home Assistant OS가 보고한 설치 slug `8a97f131_smartthings_web_bridge`와 런타임 hostname `8a97f131-smartthings-web-bridge`를 기준으로, 통합 화면에 남아 있던 이전 `d55cafb9` 고정 주소를 수정했습니다.
- Bridge가 준비되면 Supervisor app discovery로 실제 런타임 hostname과 Core 전용 `8100` 포트를 게시하고, `smartthings_web` 구성 흐름이 그 주소를 자동 입력합니다. 수동 입력은 계속 허용합니다.
- 현재 저장소 주소, `/addons` 로컬 주소, 이전 저장소 주소를 사설 Bridge 후보로 유지해 기존 구성과 재인증도 실제 응답한 주소로 복구·저장합니다.
- `8100`은 계속 Home Assistant Core에서만 접근할 수 있고 외부 포트나 host network를 추가하지 않습니다. Supervisor 토큰은 discovery 요청에만 사용하고 로그에 기록하지 않습니다.

'''
write(changelog_path, notes + changelog)

# Sanity checks before CI starts.
for path in (
    "package.json",
    "package-lock.json",
    "protocol/version.json",
    "custom_components/smartthings_web/manifest.json",
):
    if VERSION not in read(path):
        raise SystemExit(f"{path}: missing release version {VERSION}")
if LEGACY_REPOSITORY_HOST not in read("custom_components/smartthings_web/const.py"):
    raise SystemExit("legacy Bridge hostname fallback was not preserved")
if CURRENT_REPOSITORY_HOST not in read("README.md"):
    raise SystemExit("README does not document the current Supervisor hostname")

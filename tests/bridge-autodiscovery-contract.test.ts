import { readFileSync } from "node:fs";
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
    const localUpdateDocs = readText("docs/local-addon-update.md");
    const localUpdateHelper = readText("tools/update-local-addon.sh");

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
    expect(readme).toContain("칸에 자동 입력");
    expect(readme).toContain(
      "현재 저장소 설치 앱 ID: `8a97f131_smartthings_web_bridge`"
    );
    expect(readme).toContain(
      "현재 저장소 설치 내부 DNS: `8a97f131-smartthings-web-bridge`"
    );
    expect(localUpdateDocs).toContain(
      "현재 저장소 설치 앱 ID는 `8a97f131_smartthings_web_bridge`"
    );
    expect(localUpdateHelper).toContain(
      "저장소 앱 ID가 8a97f131_smartthings_web_bridge라면"
    );
  });
});

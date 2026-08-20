import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

describe("Home Assistant add-on metadata", () => {
  test("uses ingress watchdog and avoids broad privileges or public VNC ports", () => {
    const config = YAML.parse(readFileSync("addon/smartthings_web_bridge/config.yaml", "utf8")) as Record<string, unknown>;
    const dockerfile = readFileSync("addon/smartthings_web_bridge/Dockerfile", "utf8");

    expect(config.name).toBe("SmartThings Web Bridge");
    expect(config.slug).toBe("smartthings_web_bridge");
    expect(config.startup).toBe("services");
    expect(config.boot).toBe("auto");
    expect(config.ingress).toBe(true);
    expect(config.ingress_port).toBe(8099);
    expect(config.ingress_stream).toBe(true);
    expect(config.panel_admin).toBe(true);
    expect(config.watchdog).toBe("http://[HOST]:[PORT:8099]/health/live");
    expect(config.arch).toEqual(["amd64", "aarch64"]);
    expect(config).not.toHaveProperty("host_network");
    expect(config).not.toHaveProperty("full_access");
    expect(config).not.toHaveProperty("docker_api");
    expect(config).not.toHaveProperty("privileged");
    expect(config).not.toHaveProperty("ports");
    expect(dockerfile).toContain("sha256:af843e6c2a9ad4df5daa8a68268fb59d28ab5ef55203f67c1573e4d0e154e176");
    expect(dockerfile).toContain("sha256:13d069848a305570be16443bb904132fef75fcd897703022a1a1c7841e0abac9");
    expect(dockerfile).toContain("s6-overlay");
    expect(dockerfile).toContain("PLAYWRIGHT_VERSION=1.62.1");
  });
});

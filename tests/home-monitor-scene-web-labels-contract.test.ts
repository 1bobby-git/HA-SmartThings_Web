import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Home Monitor, scene and Web-label parity", () => {
  test("does not block commands on a hidden picker and keeps exact Web names", () => {
    const commandPage = readText("bridge/src/browser/command-page.ts");
    const sceneDom = readText("bridge/src/browser/scene-dom.ts");
    const models = readText("custom_components/smartthings_web/models.py");
    const sensor = readText("custom_components/smartthings_web/sensor.py");
    const binarySensor = readText("custom_components/smartthings_web/binary_sensor.py");

    expect(commandPage).toContain("knownLocationIds.length === 1");
    expect(commandPage).toContain("directUrl.pathname = `/location/${encodeURIComponent(rawTargetLocationId)}`");
    expect(commandPage).toContain("clickExactSceneCard(page, input.sceneName, 15_000)");
    expect(sceneDom).toContain("containsCompetingScene");
    expect(models).toContain("def web_state_label");
    expect(models).not.toContain('names[state.key] = f"{label} {index}"');
    expect(sensor).toContain("web_state_label(device, state)");
    expect(binarySensor).toContain("web_state_label(device, state)");
  });
});

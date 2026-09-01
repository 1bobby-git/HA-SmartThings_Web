import { describe, expect, test } from "vitest";

import {
  AdvancedCommandCatalog,
  type CapabilityBinding
} from "../../src/advanced/command-catalog.js";
import type { AdvancedCapabilityDefinition } from "../../src/advanced/types.js";

function definition(
  id: string,
  commands: AdvancedCapabilityDefinition["commands"],
  version = 1
): AdvancedCapabilityDefinition {
  return {
    id,
    version,
    attributes: {},
    commands
  };
}

const speakDefinition = definition("smartthings.speechSynthesis", {
  speak: {
    name: "speak",
    arguments: [
      {
        name: "phrase",
        required: true,
        sensitive: false,
        schema: { type: "string" }
      }
    ]
  }
});

describe("AdvancedCommandCatalog", () => {
  test("deduplicates definition loads and emits speech synthesis speak for alias devices", async () => {
    const loaded: string[] = [];
    const catalog = new AdvancedCommandCatalog(async (capability, version) => {
      loaded.push(`${capability}@${version}`);
      return speakDefinition;
    });

    const result = await catalog.build([
      binding("dev_b", "speaker", "speechSynthesis", "smartthings.speechSynthesis"),
      binding("dev_a", "main", "speechSynthesis", "smartthings.speechSynthesis")
    ]);

    expect(loaded).toEqual(["smartthings.speechSynthesis@1"]);
    expect([...result.commandsByDevice.keys()]).toEqual(["dev_a", "dev_b"]);
    for (const descriptors of result.commandsByDevice.values()) {
      expect(descriptors).toEqual([
        expect.objectContaining({
          capability: "speechSynthesis",
          capabilityVersion: 1,
          command: "speak",
          transport: "advanced",
          confirmation: "accepted_receipt",
          label: "speak",
          labelSource: "capability",
          arguments: [
            {
              name: "phrase",
              required: true,
              sensitive: false,
              schema: { type: "string" }
            }
          ]
        })
      ]);
    }
  });

  test("omits dangerous and sensitive commands without exposing raw identifiers", async () => {
    const catalog = new AdvancedCommandCatalog(async (capability, version) =>
      definition(
        capability,
        {
          unlock: { name: "unlock", arguments: [] },
          open: {
            name: "open",
            arguments: [
              {
                name: "pin",
                required: true,
                sensitive: true,
                schema: { type: "string" }
              }
            ]
          }
        },
        version
      )
    );

    const result = await catalog.build([
      binding("dev_lock", "main", "lock", "smartthings.lock", "lock")
    ]);

    expect(result.commandsByDevice.get("dev_lock")).toBeUndefined();
    expect(result.omissions).toEqual([
      { component: "main", capability: "lock", command: "open", reason: "sensitive_argument" },
      { component: "main", capability: "lock", command: "unlock", reason: "dangerous_command" }
    ]);
  });

  test("records loader failures as bounded definition omissions", async () => {
    const catalog = new AdvancedCommandCatalog(async () => {
      throw new Error("raw-device-id: dev_secret");
    });

    const result = await catalog.build([
      binding("dev_safe", "main", "refresh", "smartthings.refresh")
    ]);

    expect(result.commandsByDevice.size).toBe(0);
    expect(result.omissions).toEqual([
      { component: "main", capability: "refresh", reason: "definition_unavailable" }
    ]);
  });

  test("records invalid definition schemas without deleting other descriptors", async () => {
    const catalog = new AdvancedCommandCatalog(async (capability, version) => {
      if (capability === "bad.capability") {
        return definition(capability, {
          broken: {
            name: "broken",
            arguments: [
              {
                name: "bad",
                required: true,
                sensitive: false,
                schema: { type: "not-a-schema-type" } as never
              }
            ]
          }
        });
      }
      return definition(capability, { refresh: { name: "refresh", arguments: [] } }, version);
    });

    const result = await catalog.build([
      binding("dev_a", "main", "refresh", "good.capability"),
      binding("dev_a", "main", "bad", "bad.capability")
    ]);

    expect(result.commandsByDevice.get("dev_a")?.map((descriptor) => descriptor.command)).toEqual([
      "refresh"
    ]);
    expect(result.omissions).toEqual([
      { component: "main", capability: "bad", command: "broken", reason: "schema_invalid" }
    ]);
  });

  test("retains aggregate omissions while grouping omissions per device", async () => {
    const catalog = new AdvancedCommandCatalog(async (capability, version) =>
      definition(capability, { unlock: { name: "unlock", arguments: [] } }, version)
    );

    const result = await catalog.build([
      binding("dev_b", "main", "lock", "smartthings.lock"),
      binding("dev_a", "main", "lock", "smartthings.lock")
    ]);

    expect(result.omissions).toEqual([
      { component: "main", capability: "lock", command: "unlock", reason: "dangerous_command" },
      { component: "main", capability: "lock", command: "unlock", reason: "dangerous_command" }
    ]);
    expect([...result.omissionsByDevice.keys()]).toEqual(["dev_a", "dev_b"]);
    expect(result.omissionsByDevice.get("dev_a")).toEqual([
      { component: "main", capability: "lock", command: "unlock", reason: "dangerous_command" }
    ]);
    expect(result.omissionsByDevice.get("dev_b")).toEqual([
      { component: "main", capability: "lock", command: "unlock", reason: "dangerous_command" }
    ]);
  });

  test("honors bounded concurrent definition loading", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const catalog = new AdvancedCommandCatalog(
      async (capability, version) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return definition(capability, { refresh: { name: "refresh", arguments: [] } }, version);
      },
      { concurrency: 2 }
    );

    const build = catalog.build([
      binding("dev_1", "main", "refresh1", "cap.one"),
      binding("dev_2", "main", "refresh2", "cap.two"),
      binding("dev_3", "main", "refresh3", "cap.three"),
      binding("dev_4", "main", "refresh4", "cap.four")
    ]);

    await waitFor(() => releases.length === 2);
    expect(peak).toBe(2);
    releases.splice(0).forEach((release) => release());
    await waitFor(() => releases.length === 2);
    expect(peak).toBe(2);
    releases.splice(0).forEach((release) => release());
    await build;
    expect(peak).toBe(2);
  });
});

function binding(
  deviceId: string,
  component: string,
  capability: string,
  rawCapability: string,
  componentRole?: string
): CapabilityBinding {
  return {
    deviceId,
    component,
    ...(componentRole ? { componentRole } : {}),
    capability,
    rawCapability,
    version: 1
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition_not_met");
}

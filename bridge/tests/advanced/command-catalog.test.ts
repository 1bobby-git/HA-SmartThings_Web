import { describe, expect, test } from "vitest";

import {
  AdvancedCommandCatalog,
  type CapabilityBinding
} from "../../src/advanced/command-catalog.js";
import type {
  AdvancedCommandCapabilityRole
} from "../../src/advanced/command-catalog-types.js";
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

  test("carries the allowlisted capability role for aliased speech synthesis descriptors", async () => {
    const catalog = new AdvancedCommandCatalog(async () => speakDefinition);

    const result = await catalog.build([
      binding(
        "dev_speaker",
        "identifier_component_main",
        "identifier_74292182f118",
        "smartthings.speechSynthesis",
        "main",
        "speechsynthesis"
      )
    ]);

    expect(result.commandsByDevice.get("dev_speaker")).toEqual([
      expect.objectContaining({
        component: "identifier_component_main",
        capability: "identifier_74292182f118",
        capabilityRole: "speechsynthesis",
        command: "speak"
      })
    ]);
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

  test("rejects command definition schemas outside the public catalog contract", async () => {
    const catalog = new AdvancedCommandCatalog(async () =>
      definition("smartthings.custom", {
        setItems: {
          name: "setItems",
          arguments: [
            {
              name: "value",
              required: true,
              sensitive: false,
              schema: { type: "array", items: { type: "string" } } as never
            }
          ]
        },
        setProperties: {
          name: "setProperties",
          arguments: [
            {
              name: "value",
              required: true,
              sensitive: false,
              schema: { type: "object", properties: { mode: { type: "string" } } } as never
            }
          ]
        },
        setMode: {
          name: "setMode",
          arguments: [
            {
              name: "mode",
              required: true,
              sensitive: false,
              schema: { type: "string", enum: ["auto", "cool"], minimum: 0, maximum: 10 }
            }
          ]
        },
        refreshBare: {
          name: "refreshBare",
          arguments: [
            {
              name: "mode",
              required: true,
              sensitive: false,
              schema: { type: "string" }
            }
          ]
        },
        setEnumObject: {
          name: "setEnumObject",
          arguments: [
            {
              name: "mode",
              required: true,
              sensitive: false,
              schema: { type: "string", enum: { auto: true } } as never
            }
          ]
        },
        setEnumRawObject: {
          name: "setEnumRawObject",
          arguments: [
            {
              name: "mode",
              required: true,
              sensitive: false,
              schema: {
                type: "string",
                enum: [{ rawDeviceId: "550e8400-e29b-41d4-a716-446655440000" }]
              } as never
            }
          ]
        },
        setEnumNestedObject: {
          name: "setEnumNestedObject",
          arguments: [
            {
              name: "mode",
              required: true,
              sensitive: false,
              schema: { type: "string", enum: [{ items: { type: "string" } }] } as never
            }
          ]
        },
        setEnumControlString: {
          name: "setEnumControlString",
          arguments: [
            {
              name: "mode",
              required: true,
              sensitive: false,
              schema: { type: "string", enum: ["safe", "bad\u0001value"] }
            }
          ]
        },
        setEnumLongString: {
          name: "setEnumLongString",
          arguments: [
            {
              name: "mode",
              required: true,
              sensitive: false,
              schema: { type: "string", enum: ["x".repeat(1025)] }
            }
          ]
        },
        setMinimumText: {
          name: "setMinimumText",
          arguments: [
            {
              name: "level",
              required: true,
              sensitive: false,
              schema: { type: "number", minimum: "0" } as never
            }
          ]
        },
        setMaximumNaN: {
          name: "setMaximumNaN",
          arguments: [
            {
              name: "level",
              required: true,
              sensitive: false,
              schema: { type: "number", maximum: Number.NaN }
            }
          ]
        },
        setInvertedRange: {
          name: "setInvertedRange",
          arguments: [
            {
              name: "level",
              required: true,
              sensitive: false,
              schema: { type: "number", minimum: 10, maximum: 1 }
            }
          ]
        }
      })
    );

    const result = await catalog.build([
      binding("dev_safe", "main", "custom", "smartthings.custom")
    ]);

    expect(result.commandsByDevice.get("dev_safe")?.map((descriptor) => descriptor.command)).toEqual([
      "refreshBare",
      "setMode"
    ]);
    expect(result.commandsByDevice.get("dev_safe")?.[1]?.arguments[0]?.schema).toEqual({
      type: "string",
      enum: ["auto", "cool"],
      minimum: 0,
      maximum: 10
    });
    expect(result.omissions).toEqual([
      { component: "main", capability: "custom", command: "setEnumControlString", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setEnumLongString", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setEnumNestedObject", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setEnumObject", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setEnumRawObject", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setInvertedRange", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setItems", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setMaximumNaN", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setMinimumText", reason: "schema_invalid" },
      { component: "main", capability: "custom", command: "setProperties", reason: "schema_invalid" }
    ]);
    expect(JSON.stringify(result)).not.toContain("550e8400-e29b-41d4-a716-446655440000");
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
  componentRole?: string,
  capabilityRole?: AdvancedCommandCapabilityRole
): CapabilityBinding {
  return {
    deviceId,
    component,
    ...(componentRole ? { componentRole } : {}),
    ...(capabilityRole ? { capabilityRole } : {}),
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

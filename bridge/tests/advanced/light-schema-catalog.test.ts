import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { AdvancedCommandCatalog, type CapabilityBinding } from "../../src/advanced/command-catalog.js";
import { parseCapabilityDefinition, validateCommandArguments } from "../../src/advanced/capability-cache.js";
import type { AdvancedCapabilityDefinition } from "../../src/advanced/types.js";

// Shared with Python's real light-entity regression: raw definitions -> public catalog -> HA.
// Synthetic schemas, not an account capture. The old scalar-only tests omitted schema titles.
const fixture = JSON.parse(readFileSync(
  "custom_components/smartthings_web/tests/fixtures/light-schema-annotations.json", "utf8"
)) as {
  definitions: unknown[];
  bindings: CapabilityBinding[];
  expectedCatalog: { deviceId: string; commands: unknown[]; omissions: Record<string, number> };
  expectedOmissions: unknown[];
};

function scalar(schema: Record<string, unknown>, sensitive = false): AdvancedCapabilityDefinition {
  return parseCapabilityDefinition({
    id: "switchLevel", version: 1, attributes: {}, commands: {
      setLevel: { arguments: [{ name: "level", schema, optional: false, sensitive }] }
    }
  });
}
const binding: CapabilityBinding = {
  deviceId: "dev_001", component: "identifier_main", componentRole: "main",
  capability: "identifier_level", rawCapability: "switchLevel", version: 1
};

async function build(definition: AdvancedCapabilityDefinition) {
  return new AdvancedCommandCatalog(async () => definition).build([binding]);
}

describe("Light schema annotations through the capability catalog", () => {
  test("restores scalar controls from raw title-bearing schemas and preserves optional rate", async () => {
    const definitions = fixture.definitions.map(parseCapabilityDefinition);
    const originals = JSON.stringify(definitions);
    const catalog = new AdvancedCommandCatalog(async (id, version) => {
      const found = definitions.find((d) => d.id === id && d.version === version);
      if (!found) throw new Error("missing_fixture_definition");
      return found;
    });
    const result = await catalog.build(fixture.bindings);
    expect(result.commandsByDevice.get(fixture.expectedCatalog.deviceId)).toEqual(fixture.expectedCatalog.commands);
    expect(result.omissions).toEqual(fixture.expectedOmissions);
    const counts: Record<string, number> = {};
    for (const item of result.omissions) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    expect(counts).toEqual(fixture.expectedCatalog.omissions);
    expect(JSON.stringify(definitions)).toBe(originals);
    expect(JSON.stringify(result.commandsByDevice.get("dev_001"))).not.toMatch(/PositiveInteger|PositiveNumber|"title"/u);

    const level = definitions.find((d) => d.id === "switchLevel")!;
    expect(validateCommandArguments(level, "setLevel", [60])).toEqual([60]);
    expect(validateCommandArguments(level, "setLevel", [60, 2])).toEqual([60, 2]);
    expect(() => validateCommandArguments(level, "setLevel", [])).toThrow("missing_argument");
    expect(() => validateCommandArguments(level, "setLevel", [101])).toThrow("argument_out_of_range");
    expect(() => validateCommandArguments(level, "setLevel", [60, -1])).toThrow("argument_out_of_range");
    expect(() => validateCommandArguments(level, "setLevel", [60, "2"])).toThrow("argument_type_invalid");
    expect(() => validateCommandArguments(level, "setLevel", [60, 2, 1])).toThrow("unexpected_argument");
  });

  test("ignores only text annotations while retaining the actual public numeric constraints", async () => {
    const definition = scalar({ type: "integer", minimum: 1, maximum: 80,
      title: "Private display heading", description: "Private annotation, never publish this" });
    const result = await build(definition);
    expect(result.omissions).toEqual([]);
    const command = result.commandsByDevice.get("dev_001")![0]!;
    expect(command.arguments[0]!.schema).toEqual({ type: "integer", minimum: 1, maximum: 80 });
    expect(JSON.stringify(command)).not.toContain("Private");
    expect(() => validateCommandArguments(definition, "setLevel", [0])).toThrow("argument_out_of_range");
    expect(() => validateCommandArguments(definition, "setLevel", [81])).toThrow("argument_out_of_range");
    expect(() => validateCommandArguments(definition, "setLevel", [1.5])).toThrow("argument_type_invalid");
  });

  test.each(["title", "description"])("rejects malformed %s annotations", async (key) => {
    for (const value of [null, false, 1, [], { text: "unexpected" }]) {
      const result = await build(scalar({ type: "integer", [key]: value }));
      expect(result.commandsByDevice.size).toBe(0);
      expect(result.omissions).toEqual([expect.objectContaining({ command: "setLevel", reason: "schema_invalid" })]);
    }
  });

  test.each([
    ["pattern", "^[0-9]+$"], ["multipleOf", 2], ["exclusiveMinimum", true],
    ["$ref", "#/definitions/value"], ["allOf", [{ minimum: 10 }]],
    ["oneOf", [{ type: "integer" }]], ["items", { type: "integer" }],
    ["properties", { value: { type: "integer" } }], ["additionalProperties", false],
    ["required", ["value"]], ["readOnly", true], ["writeOnly", true]
  ])("does not drop unimplemented constraint %s just because a title is present", async (key, value) => {
    const result = await build(scalar({ type: "integer", title: "Integer", [String(key)]: value }));
    expect(result.commandsByDevice.size).toBe(0);
    expect(result.omissions).toEqual([expect.objectContaining({ reason: "schema_invalid" })]);
  });

  test("text annotations cannot bypass sensitive-argument or dangerous-command policies", async () => {
    const result = await build(scalar({ type: "integer", title: "Integer" }, true));
    expect(result.commandsByDevice.size).toBe(0);
    expect(result.omissions[0]?.reason).toBe("sensitive_argument");
    const dangerous = parseCapabilityDefinition({ id: "switchLevel", version: 1, attributes: {},
      commands: { unlock: { arguments: [{ name: "value", schema: { type: "integer", title: "Integer" } }] } } });
    expect((await build(dangerous)).omissions[0]?.reason).toBe("dangerous_command");
  });

  test("a direct raw loader also honors optional rate in the public catalog", async () => {
    const raw = fixture.definitions[1] as AdvancedCapabilityDefinition;
    const result = await build(raw);
    expect(result.omissions).toEqual([]);
    expect(result.commandsByDevice.get("dev_001")![0]!.arguments.map((arg) => arg.required)).toEqual([true, false]);
  });
});

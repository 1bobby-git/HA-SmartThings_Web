import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { parseColorArgumentSchema, validColorArgument } from "../../src/advanced/color-argument.js";
import { parseCapabilityDefinition, validateCommandArguments } from "../../src/advanced/capability-cache.js";
import { AdvancedCommandCatalog } from "../../src/advanced/command-catalog.js";
const shared = JSON.parse(readFileSync("custom_components/smartthings_web/tests/fixtures/light-plan.json", "utf8"));
const definition = shared.definitions.find((item: any) => item.id === "colorControl");
const schema = definition.commands.setColor.arguments[0].schema;

describe("Flat setColor schema contract", () => {
  test("drops text annotations and preserves bounds without widening accepted inputs", () => {
    const parsed = parseColorArgumentSchema({ ...schema, title: "Private annotation", additionalProperties: true, required: ["hue"] });
    expect(parsed).toEqual(shared.expectedCatalog.commands.find((item: any) => item.command === "setColor").arguments[0].schema);
    expect(JSON.stringify(parsed)).not.toContain("Private annotation");
  });
  test.each(["$ref", "oneOf", "pattern", "multipleOf", "minProperties", "default", "nested", "unknown_field", "missing_bound", "wrong_type", "invalid_required"])("rejects %s, rather than dropping its constraint", (key) => {
    const altered = structuredClone(schema);
    if (key === "nested") altered.properties.hue = { type: "object", properties: {} };
    else if (key === "unknown_field") altered.properties.value = { type: "number" };
    else if (key === "missing_bound") delete altered.properties.hue.maximum;
    else if (key === "wrong_type") altered.properties.hue.type = "string";
    else if (key === "invalid_required") altered.required = ["hue", "other"];
    else altered[key] = key === "$ref" ? "#/definitions/anything" : 1;
    expect(parseColorArgumentSchema(altered)).toBeUndefined();
  });
  test.each([{}, { hue: 3 }, { hue: 3, saturation: 5, extra: 1 }, { hue: true, saturation: 5 },
    { hue: -1, saturation: 5 }, { hue: 4, saturation: 101 }, { hue: NaN, saturation: 5 },
    { hue: "4", saturation: 5 }, [4, 5]])("rejects invalid color %j at raw-cache validation", (value) => {
    expect(validColorArgument(schema, value)).toBe(false);
    expect(() => validateCommandArguments(parseCapabilityDefinition(definition), "setColor", [value])).toThrow();
  });
  test("integer constraints remain meaningful", () => {
    const altered = structuredClone(schema); altered.properties.hue.type = "integer";
    expect(validColorArgument(altered, { hue: 3.5, saturation: 50 })).toBe(false);
    expect(validColorArgument(altered, { hue: 3, saturation: 50 })).toBe(true);
  });
  test("a generic command cannot inherit setColor object support", async () => {
    const raw = structuredClone(definition);
    raw.commands.setSomething = raw.commands.setColor; delete raw.commands.setColor;
    const parsed = parseCapabilityDefinition(raw);
    const result = await new AdvancedCommandCatalog(async () => parsed).build([shared.bindings[2]]);
    expect(result.omissions).toContainEqual(expect.objectContaining({ command: "setSomething", reason: "schema_invalid" }));
    expect(result.commandsByDevice.get("dev_001")?.some((item) => item.command === "setSomething")).toBe(false);
  });
});

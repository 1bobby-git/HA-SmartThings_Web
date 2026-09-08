import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { parseColorArgumentSchema, validColorArgument } from "../../src/advanced/color-argument.js";
import { parseCapabilityDefinition, validateCommandArguments } from "../../src/advanced/capability-cache.js";
import { AdvancedCommandCatalog } from "../../src/advanced/command-catalog.js";
const shared = JSON.parse(readFileSync("custom_components/smartthings_web/tests/fixtures/light-plan.json", "utf8"));
const definition = shared.definitions.find((item: any) => item.id === "colorControl");
const schema = definition.commands.setColor.arguments[0].schema;
const publicSchema = shared.expectedCatalog.commands.find((item: any) => item.command === "setColor").arguments[0].schema;

describe("Flat setColor schema contract", () => {
  test("drops text annotations and preserves bounds without widening accepted inputs", () => {
    const parsed = parseColorArgumentSchema({ ...schema, title: "Private annotation", additionalProperties: true, required: ["hue"] });
    expect(parsed).toEqual(shared.expectedCatalog.commands.find((item: any) => item.command === "setColor").arguments[0].schema);
    expect(JSON.stringify(parsed)).not.toContain("Private annotation");
  });
  test.each(["$ref", "oneOf", "pattern", "multipleOf", "minProperties", "default", "nested", "unknown_field", "wrong_type", "invalid_required"])("rejects %s, rather than dropping its constraint", (key) => {
    const altered = structuredClone(schema);
    if (key === "nested") altered.properties.hue = { type: "object", properties: {} };
    else if (key === "unknown_field") altered.properties.value = { type: "number" };
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

// API ColorMap shape captured at hongtat/smartthings-capabilities,
// json/colorControl.json, commit 824124d2ca0e4ba322fa4cd86a96fdd7709d0845.
// This reproduces a public definition, not the user's uncollected raw schema.
const optionalColorMap = {
  title: "ColorMap", type: "object" as const, additionalProperties: false,
  properties: {
    hue: { type: "number" }, saturation: { type: "number" },
    hex: { type: "string", maxLength: 7 }, level: { type: "integer" },
    switch: { type: "string", maxLength: 3 }
  }
};

describe("Optional ColorMap properties and absent numeric bounds", () => {
  test("publishes only the bounded hue/saturation subset of an optional ColorMap", async () => {
    const raw = structuredClone(definition);
    raw.commands.setColor.arguments[0].schema = optionalColorMap;
    const parsed = parseCapabilityDefinition(raw);
    const result = await new AdvancedCommandCatalog(async () => parsed).build([shared.bindings[2]]);
    expect(result.omissions).toEqual([]);
    const color = result.commandsByDevice.get("dev_001")!.find((item) => item.command === "setColor")!;
    expect(color.arguments[0]!.schema).toEqual(publicSchema);
    expect(validateCommandArguments(parsed, "setColor", [{ hue: 34, saturation: 96 }]))
      .toEqual([{ hue: 34, saturation: 96 }]);
  });

  test.each([{}, { minimum: 0 }, { maximum: 100 }, { minimum: -10, maximum: 360 }])(
    "narrows optional bounds %j to the light's 0..100 domain", (bounds) => {
      const raw = { ...optionalColorMap, properties: {
        ...optionalColorMap.properties, hue: { type: "number", ...bounds }
      } };
      const parsed = parseColorArgumentSchema(raw);
      expect(parsed).toEqual(publicSchema);
      expect(validColorArgument(raw, { hue: 99, saturation: 92 })).toBe(true);
      expect(validColorArgument(raw, { hue: 101, saturation: 92 })).toBe(false);
    });

  test("does not widen explicit bounds or drop integer constraints", () => {
    const raw = { ...optionalColorMap, properties: {
      ...optionalColorMap.properties, hue: { type: "integer", minimum: 10, maximum: 80 }
    } };
    expect(parseColorArgumentSchema(raw)?.properties).toMatchObject({
      hue: { type: "integer", minimum: 10, maximum: 80 }
    });
    for (const hue of [0, 9, 10.5, 81, 100])
      expect(validColorArgument(raw, { hue, saturation: 96 })).toBe(false);
    expect(validColorArgument(raw, { hue: 34, saturation: 96 })).toBe(true);
  });

  test.each([null, "100", true, NaN, Infinity])("rejects malformed present bounds %s", (maximum) => {
    expect(parseColorArgumentSchema({ ...optionalColorMap, properties: {
      ...optionalColorMap.properties, hue: { type: "number", maximum }
    } })).toBeUndefined();
  });

  test.each(["hex", "level", "switch", "unknown"]) (
    "never silently drops required extra property %s", (name) => {
      expect(parseColorArgumentSchema({ ...optionalColorMap, required: ["hue", "saturation", name] })).toBeUndefined();
    });

  test.each(["hex", "level", "switch"]) (
    "never sends optional extra property %s through the two-number contract", (name) => {
      expect(validColorArgument(optionalColorMap, { hue: 34, saturation: 96, [name]: 1 })).toBe(false);
    });

  test.each(["oneOf", "dependencies", "$ref"]) (
    "does not ignore cross-field constraint %s", (name) => {
      expect(parseColorArgumentSchema({ ...optionalColorMap, [name]: {} })).toBeUndefined();
    });
});

// These constraints must remain restrictive after narrowing to the public subset.
test.each([{ minimum: 101 }, { maximum: -1 }, { minimum: 90, maximum: 10 },
  { minimum: 10.1, maximum: 10.5, type: "integer" }])("rejects unusable color interval %j", (bounds) => {
  expect(parseColorArgumentSchema({ ...optionalColorMap, properties: {
    ...optionalColorMap.properties, hue: { type: "number", ...bounds }
  } })).toBeUndefined();
});

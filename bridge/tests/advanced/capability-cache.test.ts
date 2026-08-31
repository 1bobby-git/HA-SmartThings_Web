import { describe, expect, test, vi } from "vitest";

import {
  CapabilityDefinitionCache,
  CapabilityValidationError,
  parseCapabilityDefinition,
  validateCommandArguments
} from "../../src/advanced/capability-cache.js";

const levelDefinition = parseCapabilityDefinition({
  id: "switchLevel",
  version: 1,
  status: "live",
  attributes: {
    level: {
      schema: { type: "object", properties: { value: { type: "integer", minimum: 0, maximum: 100 } } },
      setter: "setLevel"
    }
  },
  commands: {
    setLevel: {
      arguments: [
        {
          name: "level",
          required: true,
          schema: { type: "integer", minimum: 0, maximum: 100 },
          unit: "%"
        }
      ]
    }
  }
});

describe("CapabilityDefinitionCache", () => {
  test("loads a capability version once and shares the in-flight promise", async () => {
    const load = vi.fn(async () => levelDefinition);
    const cache = new CapabilityDefinitionCache(load);

    const [first, second] = await Promise.all([
      cache.get("switchLevel", 1),
      cache.get("switchLevel", 1)
    ]);

    expect(first).toBe(second);
    expect(load).toHaveBeenCalledOnce();
  });

  test("keeps custom capabilities and versions in separate cache entries", async () => {
    const load = vi.fn(async (id: string, version: number) =>
      parseCapabilityDefinition({ id, version, commands: {}, attributes: {} })
    );
    const cache = new CapabilityDefinitionCache(load);

    await cache.get("custom.vendorMode", 1);
    await cache.get("custom.vendorMode", 2);

    expect(load.mock.calls).toEqual([
      ["custom.vendorMode", 1],
      ["custom.vendorMode", 2]
    ]);
  });

  test("removes a failed load so a later reconciliation can retry", async () => {
    const load = vi
      .fn<(id: string, version: number) => Promise<typeof levelDefinition>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(levelDefinition);
    const cache = new CapabilityDefinitionCache(load);

    await expect(cache.get("switchLevel", 1)).rejects.toThrowError("temporary");
    await expect(cache.get("switchLevel", 1)).resolves.toBe(levelDefinition);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("capability command argument validation", () => {
  test("accepts a valid bounded numeric argument", () => {
    expect(validateCommandArguments(levelDefinition, "setLevel", [70])).toEqual([70]);
  });

  test("rejects unsupported commands, missing arguments, and values outside the schema", () => {
    expect(() => validateCommandArguments(levelDefinition, "setUnknown", [])).toThrowError(
      new CapabilityValidationError("unsupported_command")
    );
    expect(() => validateCommandArguments(levelDefinition, "setLevel", [])).toThrowError(
      new CapabilityValidationError("missing_argument")
    );
    expect(() => validateCommandArguments(levelDefinition, "setLevel", [101])).toThrowError(
      new CapabilityValidationError("argument_out_of_range")
    );
    expect(() => validateCommandArguments(levelDefinition, "setLevel", ["70"])).toThrowError(
      new CapabilityValidationError("argument_type_invalid")
    );
  });

  test("validates enum strings and optional arguments", () => {
    const definition = parseCapabilityDefinition({
      id: "thermostatMode",
      version: 1,
      attributes: {},
      commands: {
        setThermostatMode: {
          arguments: [
            { name: "mode", schema: { type: "string", enum: ["off", "cool", "heat"] } },
            { name: "source", required: false, schema: { type: "string" }, sensitive: true }
          ]
        }
      }
    });

    expect(validateCommandArguments(definition, "setThermostatMode", ["cool"])).toEqual([
      "cool"
    ]);
    expect(() => validateCommandArguments(definition, "setThermostatMode", ["fan"])).toThrowError(
      "argument_enum_invalid"
    );
  });

  test("rejects malformed capability definitions without exposing raw content", () => {
    expect(() => parseCapabilityDefinition({ id: "switch", version: 1, commands: [] })).toThrowError(
      "capability_definition_invalid"
    );
  });
});

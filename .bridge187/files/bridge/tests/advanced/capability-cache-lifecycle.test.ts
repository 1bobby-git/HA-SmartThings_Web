import { describe, expect, test, vi } from "vitest";
import { CapabilityDefinitionCache, parseCapabilityDefinition } from "../../src/advanced/capability-cache.js";

const definition = (id = "switch") => parseCapabilityDefinition({
  id, version: 1, attributes: {}, commands: {}
});

describe("capability cache generations", () => {
  test.each(["clear", "evict"])("a stale failure after %s cannot erase a newer successful entry", async (mode) => {
    const old = Promise.withResolvers<ReturnType<typeof definition>>();
    const load = vi.fn(async (id: string) => definition(id));
    load.mockReturnValueOnce(old.promise);
    const cache = new CapabilityDefinitionCache(load, 1);
    const oldResult = cache.get("switch", 1);
    const rejected = expect(oldResult).rejects.toThrow("old_request_failed");
    if (mode === "clear") cache.clear();
    else await cache.get("switchLevel", 1);
    const current = await cache.get("switch", 1);
    const calls = load.mock.calls.length;
    old.reject(new Error("old_request_failed"));
    await rejected;
    expect(cache.size).toBe(1);
    await expect(cache.get("switch", 1)).resolves.toBe(current);
    expect(load).toHaveBeenCalledTimes(calls);
  });

  test("a stale invalid definition cannot erase a replacement still in flight", async () => {
    const old = Promise.withResolvers<ReturnType<typeof definition>>();
    const replacement = Promise.withResolvers<ReturnType<typeof definition>>();
    const load = vi.fn(async () => definition()).mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const cache = new CapabilityDefinitionCache(load);
    const rejected = expect(cache.get("switch", 1)).rejects.toThrow("capability_definition_invalid");
    cache.clear();
    const current = cache.get("switch", 1);
    old.resolve(definition("different"));
    await rejected;
    expect(cache.get("switch", 1)).toBe(current);
    replacement.resolve(definition());
    await current;
    expect(load).toHaveBeenCalledTimes(2);
  });
});

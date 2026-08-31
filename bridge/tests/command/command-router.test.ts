import { describe, expect, test, vi } from "vitest";

import {
  CommandTransportError,
  OrderedCommandRouter,
  type CommandTransport,
  type RoutedCommandRequest
} from "../../src/command/command-router.js";

const request: RoutedCommandRequest = {
  deviceId: "dev_001",
  component: "identifier_main",
  capability: "identifier_switch",
  command: "on",
  arguments: []
};

function transport(
  name: CommandTransport["name"],
  execute: CommandTransport["execute"]
): CommandTransport {
  return { name, execute: vi.fn(execute) };
}

describe("OrderedCommandRouter", () => {
  test("stops after Advanced accepts the command", async () => {
    const order: string[] = [];
    const advanced = transport("advanced", async () => {
      order.push("advanced");
      return { state: "ACCEPTED", transport: "advanced", acceptedAtMs: 1 };
    });
    const native = transport("location_native", async () => {
      order.push("location-native");
      return { state: "ACCEPTED", transport: "location_native", acceptedAtMs: 2 };
    });

    await expect(new OrderedCommandRouter({ advanced, locationNative: native }).execute(request))
      .resolves.toMatchObject({ transport: "advanced" });
    expect(order).toEqual(["advanced"]);
  });

  test("moves to Location native only for explicit unsupported", async () => {
    const order: string[] = [];
    const advanced = transport("advanced", async () => {
      order.push("advanced");
      throw new CommandTransportError("unsupported", "advanced");
    });
    const native = transport("location_native", async () => {
      order.push("location-native");
      return { state: "ACCEPTED", transport: "location_native", acceptedAtMs: 2 };
    });

    await new OrderedCommandRouter({ advanced, locationNative: native }).execute(request);
    expect(order).toEqual(["advanced", "location-native"]);
  });

  test("does not fall through after transient, authentication, or permission failures", async () => {
    const native = transport("location_native", async () => ({
      state: "ACCEPTED",
      transport: "location_native",
      acceptedAtMs: 2
    }));
    for (const code of ["transient", "authentication", "permission"] as const) {
      const advanced = transport("advanced", async () => {
        throw new CommandTransportError(code, "advanced");
      });
      await expect(
        new OrderedCommandRouter({ advanced, locationNative: native }).execute(request)
      ).rejects.toThrowError(code);
    }
    expect(native.execute).not.toHaveBeenCalled();
  });

  test("calls verified DOM only after all internal transports report unsupported", async () => {
    const order: string[] = [];
    const unsupported = (name: CommandTransport["name"], label: string) =>
      transport(name, async () => {
        order.push(label);
        throw new CommandTransportError("unsupported", name);
      });
    const dom = transport("dom", async () => {
      order.push("dom");
      return { state: "ACCEPTED", transport: "dom", acceptedAtMs: 4 };
    });
    const router = new OrderedCommandRouter({
      advanced: unsupported("advanced", "advanced"),
      locationNative: unsupported("location_native", "location-native"),
      otherInternal: unsupported("internal", "other-internal"),
      dom,
      domFallbackEnabled: true
    });

    await router.execute(request);
    expect(order).toEqual(["advanced", "location-native", "other-internal", "dom"]);
  });

  test("keeps DOM disabled unless explicitly enabled", async () => {
    const advanced = transport("advanced", async () => {
      throw new CommandTransportError("unsupported", "advanced");
    });
    const dom = transport("dom", async () => ({
      state: "ACCEPTED",
      transport: "dom",
      acceptedAtMs: 4
    }));

    await expect(new OrderedCommandRouter({ advanced, dom }).execute(request)).rejects.toThrowError(
      "unsupported"
    );
    expect(dom.execute).not.toHaveBeenCalled();
  });
});

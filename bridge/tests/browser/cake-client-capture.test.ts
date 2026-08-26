import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CAKE_CLIENT_SYMBOL_KEY,
  installCakeClientCapture
} from "../../src/browser/cake-client-capture.js";

describe("Cake client capture", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = previousWindow;
  });

  test("captures only the client produced by natural SmartThings module initialization", async () => {
    let initScript: (() => void) | undefined;
    const context = {
      addInitScript: vi.fn(async (script: () => void) => {
        initScript = script;
      })
    };
    await installCakeClientCapture(context);
    expect(initScript).toBeTypeOf("function");

    const pageWindow: Record<PropertyKey, unknown> = {};
    (globalThis as { window?: unknown }).window = pageWindow;
    initScript?.();

    const client = { service: vi.fn() };
    const clientFactory = function cakeClientFactory(
      module: { exports: unknown }
    ): void {
      void "cake_session";
      void "api/device";
      void "api/subscription";
      module.exports = { A: client };
    };
    const moduleFactories: Record<string, typeof clientFactory> = {
      "90537": clientFactory
    };
    const requireModule = vi.fn((_moduleId: string) => {
      throw new Error("capture_must_not_require_modules");
    });
    const runtimeRequire = Object.assign(requireModule, { m: moduleFactories });
    const chunks = pageWindow.webpackChunk_smartthings_cake as unknown[] & {
      push: (entry: unknown[]) => number;
    };
    chunks.push([[1], moduleFactories]);
    expect(moduleFactories["90537"]).not.toBe(clientFactory);
    chunks.push = ((entry: unknown[]) => {
      const runtime = entry[2] as ((value: typeof runtimeRequire) => void) | undefined;
      runtime?.(runtimeRequire);
      return 1;
    }) as typeof chunks.push;

    const module = { exports: {} as unknown };
    moduleFactories["90537"]?.(module);

    expect(requireModule).not.toHaveBeenCalled();
    expect(pageWindow[Symbol.for(CAKE_CLIENT_SYMBOL_KEY)]).toBe(client);
  });
});

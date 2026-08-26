export const CAKE_CLIENT_SYMBOL_KEY = "smartthings_web_bridge.cake_client";

interface CakeClientCaptureContext {
  addInitScript?: (script: () => void) => Promise<unknown>;
}

export async function installCakeClientCapture(
  context: CakeClientCaptureContext
): Promise<boolean> {
  if (!context.addInitScript) return false;
  await context.addInitScript(captureCakeClientAtInitialization);
  return true;
}

function captureCakeClientAtInitialization(): void {
  type NativeClient = {
    service?: (name: string) => unknown;
  };
  type WebpackModule = { exports: unknown };
  type WebpackFactory = (
    this: unknown,
    module: WebpackModule,
    exports: unknown,
    runtimeRequire: WebpackRequire
  ) => void;
  type WebpackRequire = {
    m?: Record<string, WebpackFactory>;
  };
  type WebpackChunk = [unknown[], Record<string, WebpackFactory>, ((value: WebpackRequire) => void)?];

  const pageWindow = window as typeof window & Record<PropertyKey, unknown>;
  const clientSymbol = Symbol.for("smartthings_web_bridge.cake_client");
  const hookSymbol = Symbol.for("smartthings_web_bridge.cake_client_hook");
  const factorySymbol = Symbol.for("smartthings_web_bridge.cake_client_factory");
  const chunkKey = "webpackChunk_smartthings_cake";
  const existingChunks = pageWindow[chunkKey];
  const chunks: unknown[] = Array.isArray(existingChunks) ? existingChunks : [];
  pageWindow[chunkKey] = chunks;
  if (pageWindow[hookSymbol] === true) return;
  pageWindow[hookSymbol] = true;

  const initialPush = chunks.push.bind(chunks) as (entry: WebpackChunk) => number;
  let pushValue = (entry: WebpackChunk): number => {
    wrapFactoryMap(entry[1]);
    return initialPush(entry);
  };
  Object.defineProperty(chunks, "push", {
    configurable: true,
    get: () => pushValue,
    set: (nextPush: unknown) => {
      if (typeof nextPush !== "function") return;
      const webpackPush = nextPush as (entry: WebpackChunk) => number;
      pushValue = (entry: WebpackChunk): number => {
        wrapFactoryMap(entry[1]);
        return webpackPush(entry);
      };
      Object.defineProperty(chunks, "push", {
        configurable: true,
        writable: true,
        value: pushValue
      });
      try {
        pushValue([
          [`smartthings_web_bridge_capture_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`],
          {},
          (runtimeRequire) => wrapNaturallyLoadedClientFactory(runtimeRequire)
        ]);
      } catch {
        // Keep the SmartThings application boot path untouched if webpack changes.
      }
    }
  });

  function wrapNaturallyLoadedClientFactory(runtimeRequire: WebpackRequire): void {
    wrapFactoryMap(runtimeRequire.m ?? {});
  }

  function wrapFactoryMap(factories: Record<string, WebpackFactory>): void {
    for (const [moduleId, factory] of Object.entries(factories)) {
      if (typeof factory !== "function") continue;
      if (
        (factory as unknown as Record<PropertyKey, unknown>)[factorySymbol] === true
      ) {
        continue;
      }
      let source: string;
      try {
        source = Function.prototype.toString.call(factory);
      } catch {
        continue;
      }
      if (
        !source.includes("cake_session") ||
        !source.includes("api/device") ||
        !source.includes("api/subscription")
      ) {
        continue;
      }
      const captureClient: WebpackFactory = function captureClient(
        module,
        exports,
        requireFunction
      ): void {
        factory.call(this, module, exports, requireFunction);
        const client = findClient(module.exports);
        if (!client) return;
        Object.defineProperty(pageWindow, clientSymbol, {
          configurable: true,
          value: client
        });
      };
      Object.defineProperty(captureClient, factorySymbol, { value: true });
      factories[moduleId] = captureClient;
    }
  }

  function findClient(exports: unknown): NativeClient | undefined {
    let candidates: unknown[];
    try {
      candidates = isRecord(exports) ? [exports, ...Object.values(exports)] : [exports];
    } catch {
      return undefined;
    }
    return candidates.find(
      (candidate): candidate is NativeClient =>
        isRecord(candidate) && typeof candidate.service === "function"
    );
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

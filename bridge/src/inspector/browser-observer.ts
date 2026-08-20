import { sanitizeCaptureRecord, type CaptureStore, type CaptureSource } from "../state/capture-store.js";

export interface EventTargetLike {
  on(event: string, handler: (payload: unknown) => void): void;
}

export interface CaptureSink {
  write(record: Parameters<CaptureStore["write"]>[0]): void;
}

export type Redact = (value: unknown) => unknown;

export function installBrowserObserver(
  context: EventTargetLike,
  sink: CaptureSink,
  redact: Redact
): void {
  context.on("request", (request) => {
    write(sink, redact, "playwright-request", {
      url: callString(request, "url"),
      method: callString(request, "method"),
      resourceType: callString(request, "resourceType"),
      headers: callObject(request, "headers")
    });
  });

  context.on("response", (response) => {
    write(sink, redact, "playwright-response", {
      url: callString(response, "url"),
      status: callNumber(response, "status"),
      headers: callObject(response, "headers")
    });
  });

  context.on("websocket", (socket) => {
    write(sink, redact, "playwright-websocket", { url: callString(socket, "url") });
    if (hasOn(socket)) {
      socket.on("framesent", (frame) =>
        write(sink, redact, "playwright-websocket-frame", { direction: "sent", frame })
      );
      socket.on("framereceived", (frame) =>
        write(sink, redact, "playwright-websocket-frame", { direction: "received", frame })
      );
      socket.on("close", () =>
        write(sink, redact, "playwright-websocket", { url: callString(socket, "url"), event: "close" })
      );
    }
  });

  context.on("serviceworker", (worker) => {
    write(sink, redact, "playwright-service-worker", { url: callString(worker, "url") });
  });

  context.on("page", (page) => {
    if (!hasOn(page)) {
      return;
    }
    page.on("console", (message) =>
      write(sink, redact, "page-console", { type: callString(message, "type"), text: callString(message, "text") })
    );
    page.on("crash", () => write(sink, redact, "page-lifecycle", { event: "crash" }));
  });
}

function write(sink: CaptureSink, redact: Redact, source: CaptureSource, payload: unknown): void {
  sink.write(sanitizeCaptureRecord(source, payload, redact));
}

function hasOn(value: unknown): value is EventTargetLike {
  return typeof value === "object" && value !== null && typeof (value as EventTargetLike).on === "function";
}

function callString(value: unknown, method: string): string | undefined {
  const result = call(value, method);
  return typeof result === "string" ? result : undefined;
}

function callNumber(value: unknown, method: string): number | undefined {
  const result = call(value, method);
  return typeof result === "number" ? result : undefined;
}

function callObject(value: unknown, method: string): unknown {
  return call(value, method);
}

function call(value: unknown, method: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fn = (value as Record<string, unknown>)[method];
  return typeof fn === "function" ? fn.call(value) : undefined;
}

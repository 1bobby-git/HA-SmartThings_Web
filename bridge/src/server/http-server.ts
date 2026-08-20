import { createServer, type Server, type ServerResponse } from "node:http";

import { createHealthReport } from "./health.js";
import { renderStatusPage } from "./status-page.js";
import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface BridgeHttpServerOptions {
  store: RuntimeStatusStore;
  host: string;
  port: number;
}

export interface BridgeHttpServer {
  port: number;
  close: () => Promise<void>;
}

export async function createBridgeHttpServer(options: BridgeHttpServerOptions): Promise<BridgeHttpServer> {
  const server = createServer((request, response) => {
    const report = createHealthReport(options.store.getSnapshot());
    const path = request.url?.split("?")[0] ?? "/";

    if (path === "/health/live") {
      writeJson(response, report.live ? 200 : 503, { live: report.live, details: report.details });
      return;
    }
    if (path === "/health/ready") {
      writeJson(response, report.ready ? 200 : 503, { ready: report.ready, details: report.details });
      return;
    }
    if (path === "/health/details") {
      writeJson(response, 200, report);
      return;
    }
    if (path === "/" || path === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderStatusPage(report));
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  await listen(server, options.port, options.host);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    port,
    close: () => close(server)
  };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

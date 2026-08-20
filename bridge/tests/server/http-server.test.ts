import { afterEach, describe, expect, test } from "vitest";

import { createBridgeHttpServer } from "../../src/server/http-server.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe("createBridgeHttpServer", () => {
  test("serves safe health and status routes with live/ready HTTP semantics", async () => {
    const now = Date.now();
    const store = new RuntimeStatusStore({
      now: () => now,
      initial: {
        dbAvailable: true,
        heartbeatAtMs: now,
        state: "LOGIN_REQUIRED",
        urlCategory: "signin"
      }
    });
    const server = await createBridgeHttpServer({ store, host: "127.0.0.1", port: 0 });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    const details = await fetch(`${baseUrl}/health/details`).then((response) => response.json());
    const page = await fetch(baseUrl).then((response) => response.text());

    expect(live.status).toBe(200);
    expect((await live.json()).live).toBe(true);
    expect(ready.status).toBe(503);
    expect((await ready.json()).ready).toBe(false);
    expect(details.details.state).toBe("LOGIN_REQUIRED");
    expect(page).toContain("SmartThings Web Bridge");
    expect(JSON.stringify([details, page])).not.toMatch(/https?:\/\/my\.smartthings\.com|deviceId|locationId|token|secret/i);
  });
});

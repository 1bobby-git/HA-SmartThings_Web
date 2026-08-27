import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertOutputDirectoryOutsideRepo,
  createSoakSample,
  evaluateSoak,
  parseHealthGuestExec,
  parseLocalBridgeInventory,
  parseLocalBridgeSseEvent,
  parseSoakObservation,
  readCgroupMemoryUsage,
  parseStatsGuestExec,
  writeSanitizedObservation,
  type SoakObservation
} from "../tools/haos-soak-core.js";
import { parseCliOptions } from "../tools/haos-soak.js";
import { collectLocalBridgeObservation } from "../tools/haos-soak.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("HAOS soak sampling", () => {
  it("parses an explicit local Bridge mode for in-add-on collection", () => {
    const options = parseCliOptions(["--local-bridge"]);

    expect(options.mode).toBe("local_bridge");
    if (options.mode !== "local_bridge") throw new Error("expected local Bridge mode");
    expect(options.bridgeUrl).toBe("http://127.0.0.1:8098");
    expect(options.bridgeTokenFile).toMatch(/(?:^|[/\\])data[/\\]bridge-secret$/u);
    expect(options.outputDirectory).toMatch(/(?:^|[/\\])data[/\\]soak[/\\]/u);
    expect(options.durationMs).toBe(72 * 60 * 60 * 1000);
    expect(options.intervalMs).toBe(300 * 1000);
  });

  it("keeps the default QGA mode and allows only loopback-safe local Bridge overrides", () => {
    const qga = parseCliOptions([]);

    expect(qga.mode).toBe("qga");
    if (qga.mode !== "qga") throw new Error("expected QGA mode");
    expect(qga.sshTarget).toBe("pve-new-ts");
    expect(qga.vmId).toBe(100);
    expect(qga.addonSlug).toBe("local_smartthings_web_bridge");
    expect(() => parseCliOptions(["--local-bridge", "--ssh-target", "pve"])).toThrowError(
      "soak_local_bridge_arguments_invalid"
    );
    expect(() => parseCliOptions(["--local-bridge", "--vm-id", "100"])).toThrowError(
      "soak_local_bridge_arguments_invalid"
    );
    const local = parseCliOptions([
      "--local-bridge",
      "--bridge-url",
      "http://localhost:18098",
      "--bridge-token-file",
      "/tmp/stw-bridge-token"
    ]);
    expect(local.mode).toBe("local_bridge");
    if (local.mode !== "local_bridge") throw new Error("expected local Bridge mode");
    expect(local.bridgeUrl).toBe("http://localhost:18098");
    expect(local.bridgeTokenFile).toMatch(/tmp[/\\]stw-bridge-token$/u);

    expect(() => parseCliOptions(["--local-bridge", "--bridge-url", "https://example.com"]))
      .toThrowError("soak_local_bridge_arguments_invalid");
    expect(() => parseCliOptions(["--local-bridge", "--bridge-url", "http://example.com"]))
      .toThrowError("soak_local_bridge_arguments_invalid");
  });

  it("parses the nested guest-exec health response and keeps only allowlisted fields", () => {
    const health = parseHealthGuestExec(
      guestExec({
        live: true,
        ready: true,
        details: {
          state: "CONNECTED",
          urlCategory: "smartthings_location",
          activeConnections: 0,
          observedDeviceCount: 213,
          decodedDeviceEventCount: 100,
          uniqueLogicalEventCount: 50,
          duplicateEventCount: 50,
          dedupeJournalSize: 50,
          protocolInvalidFrameCount: 1,
          protocolChangeCount: 0,
          restartCount: 0,
          bridgeVersion: "0.1.25",
          browserVersion: "151.0.7922.34",
          protocolVersion: "1:93ad956a7d0c0139",
          heartbeatAgeMs: 1000,
          snapshotAgeMs: 1000,
          pushAgeMs: 500,
          rawUrl: "https://example.invalid/?token=must-not-persist",
          authorization: "Bearer must-not-persist",
          deviceId: "raw-device-id"
        }
      })
    );

    expect(health).toEqual({
      live: true,
      ready: true,
      state: "CONNECTED",
      urlCategory: "smartthings_location",
      activeConnections: 0,
      observedDeviceCount: 213,
      decodedDeviceEventCount: 100,
      uniqueLogicalEventCount: 50,
      duplicateEventCount: 50,
      dedupeJournalSize: 50,
      protocolInvalidFrameCount: 1,
      protocolChangeCount: 0,
      restartCount: 0,
      bridgeVersion: "0.1.25",
      browserVersion: "151.0.7922.34",
      protocolVersion: "1:93ad956a7d0c0139",
      heartbeatAgeMs: 1000,
      snapshotAgeMs: 1000,
      pushAgeMs: 500
    });
    expect(JSON.stringify(health)).not.toMatch(/must-not-persist|raw-device-id/i);
  });

  it("sanitizes local Bridge inventory and SSE sequence evidence", () => {
    const inventory = parseLocalBridgeInventory({
      schemaVersion: 1,
      sequence: 41,
      devices: [{ id: "raw-device-id" }, { id: "another-raw-id" }],
      token: "must-not-persist"
    });
    const event = parseLocalBridgeSseEvent('data: {"schemaVersion":1,"sequence":42,"type":"inventory","deviceId":"raw"}\n\n');
    const sample = createSoakSample({
      sampledAt: "2026-08-24T00:00:00.000Z",
      health: {
        ...baseHealth(),
        inventoryDeviceCount: inventory.deviceCount,
        inventorySequence: inventory.sequence,
        eventSequence: event.sequence
      },
      resources: baseResources()
    });

    expect(sample.health).toMatchObject({
      observedDeviceCount: 213,
      inventoryDeviceCount: 2,
      inventorySequence: 41,
      eventSequence: 42
    });
    expect(JSON.stringify(sample)).not.toMatch(/raw-device-id|another-raw-id|must-not-persist/i);
  });

  it("preserves local Bridge inventory, SSE, and auth failures as specific sanitized error codes", () => {
    expect(() => parseLocalBridgeInventory({ schemaVersion: 1, sequence: 1 }))
      .toThrowError("inventory_response_invalid");
    expect(() => parseLocalBridgeSseEvent("event: keepalive\n\n"))
      .toThrowError("events_response_invalid");
    expect(parseSoakObservation({
      schemaVersion: 1,
      kind: "error",
      sampledAt: "2026-08-24T00:00:00.000Z",
      code: "inventory_request_failed"
    })).toMatchObject({ code: "inventory_request_failed" });
    expect(parseSoakObservation({
      schemaVersion: 1,
      kind: "error",
      sampledAt: "2026-08-24T00:00:00.000Z",
      code: "events_response_invalid"
    })).toMatchObject({ code: "events_response_invalid" });
    expect(parseSoakObservation({
      schemaVersion: 1,
      kind: "error",
      sampledAt: "2026-08-24T00:00:00.000Z",
      code: "bridge_auth_failed"
    })).toMatchObject({ code: "bridge_auth_failed" });
  });

  it("classifies local Bridge malformed JSON bodies as endpoint response failures", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "bridge-token");
    await writeFile(tokenFile, "abcdefghijklmnopqrstuvwxyz0123456789\n");

    const healthJsonFailure = await withLocalBridgeServer(
      (request, response) => {
        if (request.url === "/health/details") return text(response, 200, "{");
        if (request.url === "/api/v1/inventory") return json(response, inventoryBody());
        if (request.url === "/api/v1/events") return sse(response);
        response.writeHead(404).end();
      },
      async (bridgeUrl) => collectLocalBridgeObservation(localBridgeOptions(bridgeUrl, tokenFile))
    );
    expect(healthJsonFailure).toMatchObject({ kind: "error", code: "health_response_invalid" });

    const inventoryJsonFailure = await withLocalBridgeServer(
      (request, response) => {
        if (request.url === "/health/details") return json(response, healthBody());
        if (request.url === "/api/v1/inventory") return text(response, 200, "{");
        if (request.url === "/api/v1/events") return sse(response);
        response.writeHead(404).end();
      },
      async (bridgeUrl) => collectLocalBridgeObservation(localBridgeOptions(bridgeUrl, tokenFile))
    );
    expect(inventoryJsonFailure).toMatchObject({ kind: "error", code: "inventory_response_invalid" });
  });

  it("fails evaluation when local Bridge inventory count changes or sequence regresses", () => {
    const verdict = evaluateSoak(
      [
        createSample("2026-08-24T00:00:00.000Z", {
          inventoryDeviceCount: 213,
          inventorySequence: 41,
          eventSequence: 41
        }),
        createSample("2026-08-24T00:05:00.000Z", {
          decoded: 102,
          unique: 51,
          inventoryDeviceCount: 212,
          inventorySequence: 40,
          eventSequence: 40
        })
      ],
      {
        runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
        expectedDurationMs: 5 * 60_000,
        expectedIntervalMs: 5 * 60_000
      }
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.failures).toEqual(
      expect.arrayContaining(["inventory_changed", "sequence_regression"])
    );
  });

  it("rejects unsuccessful or malformed guest-exec health responses without exposing command output", () => {
    expect(() =>
      parseHealthGuestExec(
        JSON.stringify({ exitcode: 1, exited: 1, "out-data": "secret command failure" })
      )
    ).toThrowError("health_command_failed");
    expect(() => parseHealthGuestExec(guestExec({ live: true }))).toThrowError(
      "health_response_invalid"
    );
  });

  it("parses Supervisor resource stats and drops unknown fields", () => {
    const stats = parseStatsGuestExec(
      guestExec({
        result: "ok",
        data: {
          cpu_percent: 0.35,
          memory_usage: 417_853_440,
          memory_limit: 8_327_139_328,
          memory_percent: 5.02,
          network_rx: 5_179_229,
          network_tx: 161_248,
          blk_read: 0,
          blk_write: 0,
          ingress_token: "must-not-persist"
        }
      })
    );

    expect(stats).toEqual({
      cpuPercent: 0.35,
      memoryUsageBytes: 417_853_440,
      memoryLimitBytes: 8_327_139_328,
      memoryPercent: 5.02,
      networkRxBytes: 5_179_229,
      networkTxBytes: 161_248,
      blockReadBytes: 0,
      blockWriteBytes: 0
    });
    expect(JSON.stringify(stats)).not.toContain("must-not-persist");
  });

  it("does not disguise unknown cgroup memory as zero while keeping real zero valid", async () => {
    const root = await temporaryRoot();
    const zeroMemoryFile = join(root, "memory.current");
    await writeFile(zeroMemoryFile, "0\n");

    await expect(readCgroupMemoryUsage([join(root, "missing")]))
      .rejects.toThrowError("stats_response_invalid");
    await expect(readCgroupMemoryUsage([zeroMemoryFile])).resolves.toBe(0);
  });

  it("writes only the constructed sanitized observation outside the repository", async () => {
    const root = await temporaryRoot();
    const repositoryRoot = join(root, "repo");
    const outputDirectory = join(root, "outside", "run-1");
    await mkdir(repositoryRoot, { recursive: true });

    await assertOutputDirectoryOutsideRepo(outputDirectory, repositoryRoot);
    const rejectedOutput = join(repositoryRoot, "soak");
    await expect(
      assertOutputDirectoryOutsideRepo(rejectedOutput, repositoryRoot)
    ).rejects.toThrowError("soak_output_must_be_outside_repository");
    await expect(access(rejectedOutput)).rejects.toThrow();

    const sample = createSample("2026-08-24T00:00:00.000Z");
    const outputFile = join(outputDirectory, "samples.jsonl");
    await writeSanitizedObservation(outputFile, sample);

    const persisted = await readFile(outputFile, "utf8");
    expect(JSON.parse(persisted)).toEqual(sample);
    expect(persisted).not.toMatch(/authorization|cookie|token|deviceId|https?:\/\//i);
  });
});

describe("HAOS soak evaluation", () => {
  it("passes a complete healthy monotonic run", () => {
    const samples = [
      createSample("2026-08-24T00:00:00.000Z", { decoded: 100, unique: 50, memory: 400 }),
      createSample("2026-08-24T00:05:00.000Z", { decoded: 102, unique: 51, memory: 420 }),
      createSample("2026-08-24T00:10:00.000Z", { decoded: 104, unique: 52, memory: 430 })
    ];

    const verdict = evaluateSoak(samples, {
      runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
      expectedDurationMs: 10 * 60_000,
      expectedIntervalMs: 5 * 60_000,
      maxSustainedMemoryGrowthBytes: 100
    });

    expect(verdict.status).toBe("pass");
    expect(verdict.failures).toEqual([]);
    expect(verdict.sampleCount).toBe(3);
    expect(verdict.memoryGrowthBytes).toBe(30);
  });

  it("accepts unchanged protocol and restart counters inherited before the run", () => {
    const samples = [
      createSample("2026-08-24T00:00:00.000Z", {
        decoded: 100,
        unique: 50,
        protocolChanges: 7,
        restarts: 3
      }),
      createSample("2026-08-24T00:05:00.000Z", {
        decoded: 102,
        unique: 51,
        protocolChanges: 7,
        restarts: 3
      })
    ];

    const verdict = evaluateSoak(samples, {
      runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
      expectedDurationMs: 5 * 60_000,
      expectedIntervalMs: 5 * 60_000
    });

    expect(verdict.status).toBe("pass");
    expect(verdict.failures).toEqual([]);
  });

  it.each([
    ["not_ready", { ready: false }],
    ["not_live", { live: false }],
    ["state_not_connected", { state: "STALE" }],
    ["protocol_changed", { protocolChanges: 1 }],
    ["runtime_restarted", { restarts: 1 }],
    ["invalid_frame_increase", { invalidFrames: 2 }]
  ] as const)("fails on %s", (expectedFailure, override) => {
    const samples = [
      createSample("2026-08-24T00:00:00.000Z"),
      createSample("2026-08-24T00:05:00.000Z", override)
    ];

    const verdict = evaluateSoak(samples, {
      runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
      expectedDurationMs: 5 * 60_000,
      expectedIntervalMs: 5 * 60_000
    });

    expect(verdict.status).toBe("fail");
    expect(verdict.failures).toContain(expectedFailure);
  });

  it("detects counter regression, excessive sample gaps, and sustained memory growth", () => {
    const samples = [
      createSample("2026-08-24T00:00:00.000Z", { decoded: 100, unique: 50, memory: 400 }),
      createSample("2026-08-24T00:15:00.000Z", { decoded: 99, unique: 49, memory: 700 })
    ];

    const verdict = evaluateSoak(samples, {
      runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
      expectedDurationMs: 15 * 60_000,
      expectedIntervalMs: 5 * 60_000,
      maxSustainedMemoryGrowthBytes: 100
    });

    expect(verdict.status).toBe("fail");
    expect(verdict.failures).toEqual(
      expect.arrayContaining(["counter_regression", "sample_gap", "memory_growth"])
    );
  });

  it("detects a successful browser restart from an uptime rollback", () => {
    const samples = [
      createSample("2026-08-24T00:00:00.000Z", {
        decoded: 100,
        unique: 50,
        browserUptimeMs: 3_600_000
      }),
      createSample("2026-08-24T00:05:00.000Z", {
        decoded: 102,
        unique: 51,
        browserUptimeMs: 60_000
      })
    ];

    const verdict = evaluateSoak(samples, {
      runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
      expectedDurationMs: 5 * 60_000,
      expectedIntervalMs: 5 * 60_000
    });

    expect(verdict.status).toBe("fail");
    expect(verdict.failures).toContain("runtime_restarted");
  });

  it("stays pending before the configured duration and warns when event counters are flat", () => {
    const samples = [
      createSample("2026-08-24T00:00:00.000Z"),
      createSample("2026-08-24T00:05:00.000Z")
    ];

    const verdict = evaluateSoak(samples, {
      runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
      expectedDurationMs: 10 * 60_000,
      expectedIntervalMs: 5 * 60_000
    });

    expect(verdict.status).toBe("pending");
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings).toContain("event_counters_flat");
  });

  it("records sanitized command failures as failed evidence", () => {
    const observations: SoakObservation[] = [
      createSample("2026-08-24T00:00:00.000Z"),
      {
        schemaVersion: 1,
        kind: "error",
        sampledAt: "2026-08-24T00:05:00.000Z",
        code: "stats_command_failed"
      }
    ];

    const verdict = evaluateSoak(observations, {
      runStartedAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
      expectedDurationMs: 5 * 60_000,
      expectedIntervalMs: 5 * 60_000
    });

    expect(verdict.status).toBe("fail");
    expect(verdict.failures).toContain("sample_error");
    expect(JSON.stringify(verdict)).not.toMatch(/command output|stderr|secret/i);
  });
});

function guestExec(inner: unknown): string {
  return JSON.stringify({
    exitcode: 0,
    exited: 1,
    "out-data": JSON.stringify(inner),
    "out-truncated": 0
  });
}

function createSample(
  sampledAt: string,
  override: {
    live?: boolean;
    ready?: boolean;
    state?: string;
    decoded?: number;
    unique?: number;
    invalidFrames?: number;
    protocolChanges?: number;
    restarts?: number;
    memory?: number;
    browserUptimeMs?: number;
    inventoryDeviceCount?: number;
    inventorySequence?: number;
    eventSequence?: number;
  } = {}
): SoakObservation {
  return createSoakSample({
    sampledAt,
    health: baseHealth(override),
    resources: baseResources(override)
  });
}

function baseHealth(
  override: {
    live?: boolean;
    ready?: boolean;
    state?: string;
    decoded?: number;
    unique?: number;
    invalidFrames?: number;
    protocolChanges?: number;
    restarts?: number;
    browserUptimeMs?: number;
    inventoryDeviceCount?: number;
    inventorySequence?: number;
    eventSequence?: number;
  } = {}
) {
  return {
    live: override.live ?? true,
    ready: override.ready ?? true,
    state: override.state ?? "CONNECTED",
    urlCategory: "smartthings_location",
    activeConnections: 0,
    observedDeviceCount: 213,
    decodedDeviceEventCount: override.decoded ?? 100,
    uniqueLogicalEventCount: override.unique ?? 50,
    duplicateEventCount: 50,
    dedupeJournalSize: 50,
    protocolInvalidFrameCount: override.invalidFrames ?? 1,
    protocolChangeCount: override.protocolChanges ?? 0,
    restartCount: override.restarts ?? 0,
    bridgeVersion: "0.1.25",
    browserVersion: "151.0.7922.34",
    protocolVersion: "1:93ad956a7d0c0139",
    heartbeatAgeMs: 1000,
    snapshotAgeMs: 1000,
    pushAgeMs: 500,
    browserUptimeMs: override.browserUptimeMs ?? 3_600_000,
    ...(override.inventoryDeviceCount === undefined
      ? {}
      : { inventoryDeviceCount: override.inventoryDeviceCount }),
    ...(override.inventorySequence === undefined ? {} : { inventorySequence: override.inventorySequence }),
    ...(override.eventSequence === undefined ? {} : { eventSequence: override.eventSequence })
  };
}

function baseResources(override: { memory?: number } = {}) {
  return {
    cpuPercent: 0.35,
    memoryUsageBytes: override.memory ?? 400,
    memoryLimitBytes: 10_000,
    memoryPercent: 4,
    networkRxBytes: 1000,
    networkTxBytes: 100,
    blockReadBytes: 0,
    blockWriteBytes: 0
  };
}

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stw-soak-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function localBridgeOptions(bridgeUrl: string, bridgeTokenFile: string) {
  return {
    mode: "local_bridge" as const,
    resume: false,
    durationMs: 300_000,
    intervalMs: 300_000,
    maxMemoryGrowthBytes: 256 * 1024 * 1024,
    outputDirectory: "/data/soak/test",
    repositoryRoot: process.cwd(),
    bridgeUrl,
    bridgeTokenFile
  };
}

async function withLocalBridgeServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (bridgeUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("local test server did not bind");
  }
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
}

function json(response: ServerResponse, body: unknown): void {
  text(response, 200, JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json" }).end(body);
}

function sse(response: ServerResponse): void {
  response
    .writeHead(200, { "content-type": "text/event-stream" })
    .end('data: {"schemaVersion":1,"sequence":1,"type":"state"}\n\n');
}

function inventoryBody() {
  return { schemaVersion: 1, sequence: 1, devices: [] };
}

function healthBody() {
  return {
    live: true,
    ready: true,
    details: baseHealth()
  };
}

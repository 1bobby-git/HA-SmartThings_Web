import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createSoakSample, evaluateSoak, type SoakEvaluation } from "../tools/haos-soak-core.js";
import {
  evaluateSoakDeploymentGate,
  inspectSoakDeploymentGate,
  MINIMUM_SOAK_DURATION_MS,
  MINIMUM_SOAK_SAMPLE_COUNT,
  parseSoakEvaluation,
  parseSoakRunMetadata,
  type SoakRunMetadata
} from "../tools/haos-soak-deployment-gate-core.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
});

describe("HAOS soak deployment gate", () => {
  test("keeps a healthy in-progress run ineligible", () => {
    const metadata = validMetadata("running");
    const summary = validSummary({
      status: "pending",
      completed: false,
      lastSampledAt: "2026-08-24T03:00:00.000Z",
      sampleCount: 37,
      successfulSampleCount: 37
    });

    const result = evaluateSoakDeploymentGate(metadata, summary);

    expect(result).toMatchObject({
      deploymentEligible: false,
      evidenceState: "pending",
      runStatus: "running",
      soakStatus: "pending",
      sampleCount: 37,
      errorSampleCount: 0
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "run_not_completed",
        "soak_not_passed",
        "summary_not_completed",
        "completion_time_invalid",
        "insufficient_samples"
      ])
    );
  });

  test("allows only a complete 72-hour passing summary with verified integrity", () => {
    const result = evaluateSoakDeploymentGate(validMetadata(), validSummary(), {
      summarySha256: "a".repeat(64),
      summaryHashMatches: true
    });

    expect(result).toMatchObject({
      deploymentEligible: true,
      evidenceState: "eligible",
      reasons: [],
      sampleCount: MINIMUM_SOAK_SAMPLE_COUNT,
      successfulSampleCount: MINIMUM_SOAK_SAMPLE_COUNT,
      errorSampleCount: 0,
      summarySha256: "a".repeat(64)
    });
  });

  test("accepts a stable compatible historical protocol change count", () => {
    const summary = validSummary();
    summary.baseline!.protocolChangeCount = 7;
    summary.final!.protocolChangeCount = 7;

    const result = evaluateSoakDeploymentGate(validMetadata(), summary, {
      summarySha256: "a".repeat(64),
      summaryHashMatches: true
    });

    expect(result.deploymentEligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("accepts the real local Bridge summary shape produced by evaluateSoak", () => {
    const startedAtMs = Date.parse("2026-08-24T00:00:00.000Z");
    const summary = evaluateSoak(
      Array.from({ length: MINIMUM_SOAK_SAMPLE_COUNT }, (_, index) =>
        localBridgeSample(startedAtMs + index * 300_000, index)
      ),
      {
        runStartedAtMs: startedAtMs,
        expectedDurationMs: MINIMUM_SOAK_DURATION_MS,
        expectedIntervalMs: 300_000
      }
    );

    const result = evaluateSoakDeploymentGate(validMetadata(), summary, {
      summarySha256: "a".repeat(64),
      summaryHashMatches: true
    });

    expect(result.deploymentEligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("fails closed when optional local counter evidence exists on only one side", () => {
    const summary = validSummary();
    delete summary.baseline!.inventoryDeviceCount;

    const result = evaluateSoakDeploymentGate(validMetadata(), summary, {
      summarySha256: "a".repeat(64),
      summaryHashMatches: true
    });

    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toContain("counter_evidence_invalid");
  });

  test("fails closed when local Bridge inventory and SSE evidence is absent", () => {
    const summary = validSummary();
    delete summary.baseline!.inventoryDeviceCount;
    delete summary.baseline!.inventorySequence;
    delete summary.baseline!.eventSequence;
    delete summary.final!.inventoryDeviceCount;
    delete summary.final!.inventorySequence;
    delete summary.final!.eventSequence;

    const result = evaluateSoakDeploymentGate(validMetadata(), summary, {
      summarySha256: "a".repeat(64),
      summaryHashMatches: true
    });

    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toContain("counter_evidence_invalid");
  });

  test("parses new local evaluator failure codes and blocks failed summaries without artifact rejection", () => {
    const summary = validSummary({
      status: "fail",
      failures: ["inventory_changed", "sequence_regression"]
    });

    const parsed = parseSoakEvaluation(JSON.stringify(summary));
    const result = evaluateSoakDeploymentGate(validMetadata(), parsed, {
      summarySha256: "a".repeat(64),
      summaryHashMatches: true
    });

    expect(parsed.failures).toEqual(["inventory_changed", "sequence_regression"]);
    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toContain("soak_not_passed");
    expect(result.reasons).toContain("failures_present");
  });

  test("fails closed on hash, duration, interval, sample, error, and failure defects", () => {
    const metadata = {
      ...validMetadata(),
      durationMs: MINIMUM_SOAK_DURATION_MS - 1,
      intervalMs: 300_001
    };
    const summary = validSummary({
      expectedDurationMs: metadata.durationMs,
      expectedIntervalMs: metadata.intervalMs,
      expectedEndAt: "2026-08-26T23:59:59.999Z",
      lastSampledAt: "2026-08-26T23:59:59.999Z",
      sampleCount: 10,
      successfulSampleCount: 9,
      errorSampleCount: 1,
      failures: ["sample_error"],
      maxGapMs: 700_000,
      memoryGrowthBytes: 300 * 1_024 * 1_024
    });
    metadata.expectedEndAt = summary.expectedEndAt;

    const result = evaluateSoakDeploymentGate(metadata, summary, {
      summarySha256: "b".repeat(64),
      summaryHashMatches: false
    });

    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "duration_below_minimum",
        "interval_above_maximum",
        "insufficient_samples",
        "sample_errors_present",
        "successful_sample_mismatch",
        "failures_present",
        "sample_gap_exceeded",
        "memory_growth_exceeded",
        "summary_hash_mismatch"
      ])
    );
  });

  test("strictly reconstructs allowlisted metadata and summary fields", () => {
    expect(() =>
      parseSoakRunMetadata(JSON.stringify({ ...validMetadata(), token: "raw-secret" }))
    ).toThrowError("soak_artifact_invalid");
    expect(() =>
      parseSoakEvaluation(JSON.stringify({ ...validSummary(), rawUrl: "https://example.invalid" }))
    ).toThrowError("soak_artifact_invalid");
    expect(
      parseSoakEvaluation(
        JSON.stringify({
          ...validSummary(),
          memoryStartMedianBytes: 100.5,
          memoryEndMedianBytes: 99,
          memoryGrowthBytes: -1.5
        })
      )
    ).toMatchObject({ memoryStartMedianBytes: 100.5, memoryGrowthBytes: -1.5 });

    const unsafeIntegrity = evaluateSoakDeploymentGate(validMetadata(), validSummary(), {
      summarySha256: "raw-secret-token",
      summaryHashMatches: true
    });
    expect(unsafeIntegrity.deploymentEligible).toBe(false);
    expect(unsafeIntegrity.reasons).toContain("summary_hash_invalid");
    expect(JSON.stringify(unsafeIntegrity)).not.toContain("raw-secret-token");
  });

  test("reads only sealed allowlisted artifacts and ignores raw samples", async () => {
    const root = await makeTemporaryDirectory();
    const repositoryRoot = join(root, "repository");
    const runDirectory = join(root, "run");
    await mkdir(repositoryRoot);
    await mkdir(runDirectory);
    const metadata = validMetadata();
    const summary = validSummary();
    const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
    const digest = createHash("sha256").update(summaryText).digest("hex");
    await Promise.all([
      writeFile(join(runDirectory, "run.json"), `${JSON.stringify(metadata)}\n`),
      writeFile(join(runDirectory, "final-summary.json"), summaryText),
      writeFile(
        join(runDirectory, "final-summary.json.sha256"),
        `${digest}  final-summary.json\n`
      ),
      writeFile(
        join(runDirectory, "samples.jsonl"),
        '{"authorization":"Bearer raw-secret-token","rawDeviceId":"raw-id"}\n'
      )
    ]);

    const result = await inspectSoakDeploymentGate({ runDirectory, repositoryRoot });

    expect(result).toMatchObject({
      deploymentEligible: true,
      evidenceState: "eligible",
      summarySha256: digest
    });
    expect(JSON.stringify(result)).not.toMatch(/raw-secret-token|rawDeviceId|raw-id/i);
  });

  test("reports a mismatched final-summary hash without exposing artifact content", async () => {
    const root = await makeTemporaryDirectory();
    const repositoryRoot = join(root, "repository");
    const runDirectory = join(root, "run");
    await mkdir(repositoryRoot);
    await mkdir(runDirectory);
    const summaryText = `${JSON.stringify(validSummary(), null, 2)}\n`;
    await Promise.all([
      writeFile(join(runDirectory, "run.json"), JSON.stringify(validMetadata())),
      writeFile(join(runDirectory, "final-summary.json"), summaryText),
      writeFile(
        join(runDirectory, "final-summary.json.sha256"),
        `${"0".repeat(64)}  final-summary.json\n`
      )
    ]);

    const result = await inspectSoakDeploymentGate({ runDirectory, repositoryRoot });

    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toContain("summary_hash_mismatch");
  });

  test("rejects run directories inside the repository and symbolic-link directories", async () => {
    const root = await makeTemporaryDirectory();
    const repositoryRoot = join(root, "repository");
    const insideRepository = join(repositoryRoot, "soak");
    const externalRun = join(root, "external-run");
    const linkedRun = join(root, "linked-run");
    await mkdir(insideRepository, { recursive: true });
    await mkdir(externalRun);
    await symlink(externalRun, linkedRun, process.platform === "win32" ? "junction" : "dir");

    await expect(
      inspectSoakDeploymentGate({ runDirectory: insideRepository, repositoryRoot })
    ).rejects.toThrowError("soak_deployment_gate_path_invalid");
    await expect(
      inspectSoakDeploymentGate({ runDirectory: linkedRun, repositoryRoot })
    ).rejects.toThrowError("soak_deployment_gate_path_invalid");
  });
});

function validMetadata(status: SoakRunMetadata["status"] = "completed"): SoakRunMetadata {
  return {
    schemaVersion: 1,
    status,
    startedAt: "2026-08-24T00:00:00.000Z",
    expectedEndAt: "2026-08-27T00:00:00.000Z",
    durationMs: MINIMUM_SOAK_DURATION_MS,
    intervalMs: 300_000,
    outputPolicy: "allowlisted_aggregates_only"
  };
}

function validSummary(overrides: Partial<SoakEvaluation> = {}): SoakEvaluation {
  return {
    schemaVersion: 1,
    status: "pass",
    startedAt: "2026-08-24T00:00:00.000Z",
    expectedEndAt: "2026-08-27T00:00:00.000Z",
    lastSampledAt: "2026-08-27T00:00:00.000Z",
    expectedDurationMs: MINIMUM_SOAK_DURATION_MS,
    expectedIntervalMs: 300_000,
    completed: true,
    sampleCount: MINIMUM_SOAK_SAMPLE_COUNT,
    successfulSampleCount: MINIMUM_SOAK_SAMPLE_COUNT,
    errorSampleCount: 0,
    failures: [],
    warnings: [],
    maxGapMs: 300_000,
    memoryStartMedianBytes: 440_000_000,
    memoryEndMedianBytes: 450_000_000,
    memoryPeakBytes: 470_000_000,
    memoryGrowthBytes: 10_000_000,
    baseline: counters(1_000, 500, 500),
    final: counters(10_000, 5_000, 5_000),
    ...overrides
  };
}

function counters(
  decodedDeviceEventCount: number,
  uniqueLogicalEventCount: number,
  duplicateEventCount: number
) {
  return {
    observedDeviceCount: 213,
    inventoryDeviceCount: 213,
    inventorySequence: 100,
    eventSequence: 100,
    decodedDeviceEventCount,
    uniqueLogicalEventCount,
    duplicateEventCount,
    protocolInvalidFrameCount: 2,
    protocolChangeCount: 0,
    restartCount: 0
  };
}

function resources(memoryUsageBytes: number) {
  return {
    cpuPercent: 0,
    memoryUsageBytes,
    memoryLimitBytes: 0,
    memoryPercent: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0
  };
}

function localBridgeSample(sampledAtMs: number, index: number) {
  return createSoakSample({
    sampledAt: new Date(sampledAtMs).toISOString(),
    health: {
      ...counters(1_000 + index * 2, 500 + index, 500 + index),
      inventoryDeviceCount: 213,
      inventorySequence: 100 + index,
      eventSequence: 100 + index,
      live: true,
      ready: true,
      state: "CONNECTED",
      urlCategory: "smartthings_location",
      activeConnections: 0,
      dedupeJournalSize: 500 + index,
      bridgeVersion: "0.1.98",
      browserVersion: "151.0.7922.34",
      protocolVersion: "1:93ad956a7d0c0139",
      heartbeatAgeMs: 1000,
      snapshotAgeMs: 1000,
      restartCount: 4
    },
    resources: resources(440_000_000 + index)
  });
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stw-soak-gate-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const requiredDocs = [
  "MANUAL_TEST.md",
  "docs/architecture.md",
  "docs/feasibility-report.md",
  "docs/protocol-report.md",
  "docs/session-behavior.md",
  "docs/api-free-audit.md",
  "docs/official-parity-matrix.md",
  "docs/customize-compatibility.md",
  "docs/security.md",
  "protocol/fixtures/README.md"
];

describe("Phase 1 documentation gate", () => {
  test("keeps evidence-only decisions and real-account gaps explicit", () => {
    for (const path of requiredDocs) {
      expect(existsSync(path), path).toBe(true);
    }

    const feasibility = readFileSync("docs/feasibility-report.md", "utf8");
    const protocol = readFileSync("docs/protocol-report.md", "utf8");
    const manual = readFileSync("MANUAL_TEST.md", "utf8");
    const fixtures = readFileSync("protocol/fixtures/README.md", "utf8");

    expect(feasibility.trimEnd()).toMatch(/DECISION: (GO|LIMITED|STOP|PENDING)$/);
    expect(feasibility).toContain("Phase 2 remains closed");
    expect(protocol).toContain("No synthetic SmartThings protocol payloads");
    expect(manual).toContain("Do not enter Samsung credentials into this repository");
    expect(manual).toContain("real device event");
    expect(fixtures).toContain("sanitized real captures only");
    expect(`${feasibility}\n${protocol}`).not.toMatch(/DECISION: GO/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readText = (path: string) => readFileSync(path, "utf8");

describe("release pipeline resilience", () => {
  test("bounds registry-backed npm audit attempts without hiding reported high-risk findings", () => {
    const security = readText(".github/workflows/security.yml");

    expect(security).toContain("timeout --foreground --kill-after=10s 90s");
    expect(security).toContain("npm audit --omit=dev --audit-level=high --json");
    expect(security).toContain('for attempt in 1 2 3; do');
    expect(security).toContain('if high or critical:');
    expect(security).toContain('raise SystemExit(2)');
    expect(security).toContain('Registry-backed npm audit remained unavailable after bounded retries');
  });

  test("gives the bounded security job enough time before publishing", () => {
    const release = readText(".github/workflows/release.yml");

    expect(release).toContain("for attempt in $(seq 1 90); do");
    expect(release).toContain('[[ "${attempt}" != "90" ]]');
    expect(release).toContain("within 15 minutes");
  });

  test("removes the temporary release-gate branch after the release is published", () => {
    const cleanup = readText(".github/workflows/cleanup-0.1.177.yml");

    expect(cleanup).toContain("'fix/release-gate-0.1.177'");
    expect(cleanup).toContain("git rm .github/workflows/cleanup-0.1.177.yml");
  });
});

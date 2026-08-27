import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("package build contract", () => {
  test("build script cleans dist and emits bridge runtime JavaScript", () => {
    const packageJson = readJson("package.json") as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.build).toContain("rmSync('dist'");
    expect(packageJson.scripts?.build).toContain("tsc -p tsconfig.build.json");
    expect(packageJson.scripts?.build).not.toContain("--noEmit");
  });

  test("build tsconfig emits bridge runtime and live event benchmark into dist", () => {
    expect(existsSync("tsconfig.build.json")).toBe(true);

    const tsconfig = readJson("tsconfig.build.json") as {
      compilerOptions?: Record<string, unknown>;
      include?: string[];
      exclude?: string[];
    };

    expect(tsconfig.compilerOptions?.rootDir).toBe(".");
    expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    expect(tsconfig.compilerOptions?.noEmit).not.toBe(true);
    expect(tsconfig.include).toEqual([
      "bridge/src/**/*.ts",
      "tools/haos-live-control-event-benchmark.ts",
      "tools/haos-live-control-event-benchmark-core.ts",
    ]);
    expect(tsconfig.exclude).toContain("bridge/tests/**/*.ts");
    expect(tsconfig.exclude).toContain("tests/**/*.ts");
  });
});

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { packageAddon } from "../tools/package-addon.js";

const execFileAsync = promisify(execFile);

const makeTempRoot = async () => {
  const root = join(tmpdir(), `addon-package-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
};

const writeFixture = async (repoRoot: string, relativePath: string, content = relativePath) => {
  const path = join(repoRoot, ...relativePath.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
};

const rewriteTreeWithCrlf = async (root: string) => {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await rewriteTreeWithCrlf(path);
      continue;
    }
    if (entry.isFile()) {
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replace(/\r?\n/gu, "\r\n"));
    }
  }
};

const createMinimalRepo = async () => {
  const repoRoot = await makeTempRoot();

  await writeFixture(repoRoot, "package.json", "{\"name\":\"fixture\"}\n");
  await writeFixture(repoRoot, "package-lock.json", "{\"lockfileVersion\":3}\n");
  await writeFixture(repoRoot, "tsconfig.json", "{}\n");
  await writeFixture(repoRoot, "tsconfig.build.json", "{}\n");
  await writeFixture(repoRoot, "bridge/src/main.ts", "export const main = 1;\n");
  await writeFixture(repoRoot, "bridge/src/nested/runtime.ts", "export const runtime = 1;\n");
  await writeFixture(repoRoot, "bridge/tests/main.test.ts", "must not copy");
  await writeFixture(repoRoot, "bridge/src/fixtures/secret.json", "must not copy");
  await writeFixture(repoRoot, "bridge/src/dist/generated.js", "must not copy");
  await writeFixture(repoRoot, "bridge/src/runtime/state.json", "must not copy");
  await writeFixture(repoRoot, "bridge/src/.git/config", "must not copy");
  await writeFixture(repoRoot, "bridge/src/node_modules/pkg/index.js", "must not copy");
  await writeFixture(repoRoot, "bridge/src/secrets/token.txt", "must not copy");
  await writeFixture(repoRoot, "bridge/src/profiles/state.json", "must not copy");
  await writeFixture(repoRoot, "bridge/src/secret/kept.ts", "export const keptSecretSegment = true;\n");
  await writeFixture(repoRoot, "bridge/src/profile/kept.ts", "export const keptProfileSegment = true;\n");
  await writeFixture(repoRoot, "bridge/src/runtime-data/kept.ts", "export const keptRuntimeDataSegment = true;\n");
  await writeFixture(repoRoot, "bridge/src/runtime_data/kept.ts", "export const keptRuntimeDataSnakeSegment = true;\n");
  await writeFixture(repoRoot, "addon/smartthings_web_bridge/config.yaml", "name: Fixture\n");
  await writeFixture(
    repoRoot,
    "addon/smartthings_web_bridge/Dockerfile",
    "FROM scratch\nCOPY package.json package-lock.json tsconfig.json ./\nCOPY tsconfig.build.json ./\nCOPY bridge ./bridge\nCOPY rootfs /\n",
  );
  await writeFixture(repoRoot, "addon/smartthings_web_bridge/DOCS.md", "# Docs\n");
  await writeFixture(repoRoot, "addon/smartthings_web_bridge/rootfs/etc/service/run", "#!/bin/sh\n");
  await writeFixture(repoRoot, "addon/smartthings_web_bridge/rootfs/etc/service/.env", "SECRET=1\n");
  await writeFixture(repoRoot, "addon/smartthings_web_bridge/rootfs/etc/service/profile/state.json", "must not copy");

  return repoRoot;
};

const readManifest = async (packageDir: string) => {
  const raw = await readFile(join(packageDir, "addon-package-manifest.json"), "utf8");
  return JSON.parse(raw) as {
    schema_version: number;
    files: Array<{ path: string; sha256: string }>;
  };
};

const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");

const sha256File = async (path: string) => sha256Text(await readFile(path, "utf8"));

const dockerfileCopySources = (dockerfile: string) =>
  dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("COPY "))
    .flatMap((line) => {
      const parts = line.split(/\s+/).slice(1);
      if (parts[0]?.startsWith("--")) {
        return [];
      }
      return parts.slice(0, -1);
    })
    .filter((source) => !source.startsWith("["));

const expectPathExists = async (path: string) => {
  await expect(access(path)).resolves.toBeUndefined();
};

describe("packageAddon", { timeout: 15_000 }, () => {
  test("copies only addon package sources and writes a deterministic manifest", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();

    const first = await packageAddon({ repoRoot, outputRoot });
    const firstManifestRaw = await readFile(join(first.packageDir, "addon-package-manifest.json"), "utf8");
    const second = await packageAddon({ repoRoot, outputRoot });
    const secondManifestRaw = await readFile(join(second.packageDir, "addon-package-manifest.json"), "utf8");
    const manifest = await readManifest(second.packageDir);
    const paths = manifest.files.map((entry) => entry.path);

    expect(second.packageDir).toBe(join(outputRoot, "smartthings_web_bridge"));
    expect(second.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.manifestSha256).toBe(sha256Text(secondManifestRaw));
    expect(second.files).toEqual(paths);
    expect(firstManifestRaw).toBe(secondManifestRaw);
    expect(manifest.schema_version).toBe(1);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("package.json");
    expect(paths).toContain("package-lock.json");
    expect(paths).toContain("tsconfig.json");
    expect(paths).toContain("tsconfig.build.json");
    expect(paths).toContain("bridge/src/main.ts");
    expect(paths).toContain("bridge/src/nested/runtime.ts");
    expect(paths).toContain("bridge/src/secret/kept.ts");
    expect(paths).toContain("bridge/src/profile/kept.ts");
    expect(paths).toContain("bridge/src/runtime-data/kept.ts");
    expect(paths).toContain("bridge/src/runtime_data/kept.ts");
    expect(paths).toContain("config.yaml");
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("DOCS.md");
    expect(paths).toContain("rootfs/etc/service/run");
    expect(paths).not.toContain("addon/smartthings_web_bridge/config.yaml");
    expect(paths).not.toContain("addon/smartthings_web_bridge/Dockerfile");
    expect(paths).not.toContain("addon/smartthings_web_bridge/rootfs/etc/service/run");
    expect(paths).not.toContain("addon-package-manifest.json");
    expect(paths.every((path) => !path.startsWith("addon/"))).toBe(true);
    expect(paths.some((path) => path.includes("tests/"))).toBe(false);
    expect(paths.some((path) => path.includes("fixtures/"))).toBe(false);
    expect(paths.some((path) => path.includes("dist/"))).toBe(false);
    expect(paths.some((path) => path.includes("/runtime/"))).toBe(false);
    expect(paths.some((path) => path.includes("/.git/"))).toBe(false);
    expect(paths.some((path) => path.includes("/node_modules/"))).toBe(false);
    expect(paths.some((path) => path.includes("/secrets/"))).toBe(false);
    expect(paths.some((path) => path.includes("/profiles/"))).toBe(false);
    expect(paths.some((path) => path.endsWith("/.env"))).toBe(false);

    for (const entry of manifest.files) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sha256).toBe(await sha256File(join(second.packageDir, ...entry.path.split("/"))));
    }

    await expectPathExists(join(second.packageDir, "config.yaml"));
    await expectPathExists(join(second.packageDir, "Dockerfile"));
    await expectPathExists(join(second.packageDir, "rootfs/etc/service/run"));

    const dockerfile = await readFile(join(second.packageDir, "Dockerfile"), "utf8");
    const copySources = dockerfileCopySources(dockerfile);
    expect(copySources).not.toContain("vitest.config.ts");
    for (const source of copySources) {
      await expectPathExists(join(second.packageDir, ...source.split("/")));
    }
  });

  test("produces the same LF package manifest from LF and CRLF checkouts", async () => {
    const lfRepoRoot = await createMinimalRepo();
    const crlfRepoRoot = await createMinimalRepo();
    const lfOutputRoot = await makeTempRoot();
    const crlfOutputRoot = await makeTempRoot();
    await rewriteTreeWithCrlf(crlfRepoRoot);

    const lfResult = await packageAddon({ repoRoot: lfRepoRoot, outputRoot: lfOutputRoot });
    const crlfResult = await packageAddon({ repoRoot: crlfRepoRoot, outputRoot: crlfOutputRoot });
    const lfManifest = await readFile(
      join(lfResult.packageDir, "addon-package-manifest.json"),
      "utf8"
    );
    const crlfManifest = await readFile(
      join(crlfResult.packageDir, "addon-package-manifest.json"),
      "utf8"
    );

    expect(crlfResult.manifestSha256).toBe(lfResult.manifestSha256);
    expect(crlfManifest).toBe(lfManifest);
    for (const entry of (await readManifest(crlfResult.packageDir)).files) {
      const packaged = await readFile(join(crlfResult.packageDir, ...entry.path.split("/")), "utf8");
      expect(packaged).not.toContain("\r");
    }
  });

  test("rejects invalid UTF-8 in a declared text source", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();
    await writeFile(join(repoRoot, "bridge/src/main.ts"), Buffer.from([0xff, 0xfe]));

    await expect(packageAddon({ repoRoot, outputRoot })).rejects.toThrow(
      /not valid UTF-8/u
    );
  });

  test("removes stale generated files on rerun", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();
    const result = await packageAddon({ repoRoot, outputRoot });
    const stalePath = join(result.packageDir, "stale.txt");
    await writeFile(stalePath, "old");

    await packageAddon({ repoRoot, outputRoot });

    await expect(readFile(stalePath, "utf8")).rejects.toThrow();
  });

  test("validates required sources before deleting previous output", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();
    const result = await packageAddon({ repoRoot, outputRoot });
    const markerPath = join(result.packageDir, "keep.txt");
    await writeFile(markerPath, "existing output");
    await rm(join(repoRoot, "bridge/src"), { recursive: true, force: true });

    await expect(packageAddon({ repoRoot, outputRoot })).rejects.toThrow(/Missing required source/);

    await expect(readFile(markerPath, "utf8")).resolves.toBe("existing output");
  });

  test("rejects output that overlaps source roots before deleting source files", async () => {
    const repoRoot = await createMinimalRepo();
    const configPath = join(repoRoot, "addon/smartthings_web_bridge/config.yaml");

    await expect(packageAddon({ repoRoot, outputRoot: join(repoRoot, "addon") })).rejects.toThrow(/overlap/i);

    await expect(readFile(configPath, "utf8")).resolves.toBe("name: Fixture\n");
  });

  test("rejects output nested under a source root before deleting source files", async () => {
    const repoRoot = await createMinimalRepo();
    const nestedSourcePath = join(repoRoot, "bridge/src/nested/runtime.ts");

    await expect(packageAddon({ repoRoot, outputRoot: join(repoRoot, "bridge/src/nested") })).rejects.toThrow(
      /overlap/i,
    );

    await expect(readFile(nestedSourcePath, "utf8")).resolves.toBe("export const runtime = 1;\n");
  });

  test("rejects output root reparse points before deleting canonical source files", async () => {
    const repoRoot = await createMinimalRepo();
    const outputParent = await makeTempRoot();
    const outputRoot = join(outputParent, "out");
    const configPath = join(repoRoot, "addon/smartthings_web_bridge/config.yaml");
    await symlink(join(repoRoot, "addon"), outputRoot, "junction");

    await expect(packageAddon({ repoRoot, outputRoot })).rejects.toThrow(/symlink|junction|reparse/i);

    await expect(readFile(configPath, "utf8")).resolves.toBe("name: Fixture\n");
  });

  test("rejects flattened destination collisions before replacing previous output", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();
    const result = await packageAddon({ repoRoot, outputRoot });
    const markerPath = join(result.packageDir, "keep.txt");
    const collidingSource = join(repoRoot, "addon/smartthings_web_bridge/package.json");
    await writeFile(markerPath, "previous output");
    await writeFile(collidingSource, "{\"name\":\"addon-collision\"}\n");

    await expect(packageAddon({ repoRoot, outputRoot })).rejects.toThrow(/collision|duplicate/i);

    await expect(readFile(markerPath, "utf8")).resolves.toBe("previous output");
    await expect(readFile(collidingSource, "utf8")).resolves.toBe("{\"name\":\"addon-collision\"}\n");
  });

  test("rejects symlinks without replacing existing output", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();
    const result = await packageAddon({ repoRoot, outputRoot });
    const markerPath = join(result.packageDir, "keep.txt");
    await writeFile(markerPath, "existing output");
    const linkedTarget = await makeTempRoot();
    await symlink(linkedTarget, join(repoRoot, "bridge/src/linked"), "junction");

    await expect(packageAddon({ repoRoot, outputRoot })).rejects.toThrow(/symlink|reparse/i);

    await expect(readFile(markerPath, "utf8")).resolves.toBe("existing output");
  });

  test("rejects source identity changes before copying bytes", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();
    const leakedTargetRoot = await makeTempRoot();
    await writeFixture(leakedTargetRoot, "runtime.ts", "leaked target bytes");

    await expect(
      packageAddon({
        repoRoot,
        outputRoot,
        beforeCopy: async ({ relativePath }) => {
          if (relativePath !== "bridge/src/nested/runtime.ts") {
            return;
          }

          await rm(join(repoRoot, "bridge/src/nested"), { recursive: true, force: true });
          await symlink(leakedTargetRoot, join(repoRoot, "bridge/src/nested"), "junction");
        },
      }),
    ).rejects.toThrow(/changed|symlink|reparse/i);

    await expect(readFile(join(outputRoot, "smartthings_web_bridge/bridge/src/nested/runtime.ts"), "utf8")).rejects.toThrow();
  });

  test("preserves previous output when source identity changes during staged packaging", async () => {
    const repoRoot = await createMinimalRepo();
    const outputRoot = await makeTempRoot();
    const result = await packageAddon({ repoRoot, outputRoot });
    const markerPath = join(result.packageDir, "keep.txt");
    const leakedTargetRoot = await makeTempRoot();
    await writeFile(markerPath, "previous output");
    await writeFixture(leakedTargetRoot, "runtime.ts", "leaked target bytes");

    await expect(
      packageAddon({
        repoRoot,
        outputRoot,
        beforeCopy: async ({ relativePath }) => {
          if (relativePath !== "bridge/src/nested/runtime.ts") {
            return;
          }

          await rm(join(repoRoot, "bridge/src/nested"), { recursive: true, force: true });
          await symlink(leakedTargetRoot, join(repoRoot, "bridge/src/nested"), "junction");
        },
      }),
    ).rejects.toThrow(/changed|symlink|reparse/i);

    await expect(readFile(markerPath, "utf8")).resolves.toBe("previous output");
    await expect(readFile(join(result.packageDir, "bridge/src/nested/runtime.ts"), "utf8")).resolves.toBe(
      "export const runtime = 1;\n",
    );
  });

  test("CLI defaults cwd repo root to dist-addon output", async () => {
    const repoRoot = await createMinimalRepo();
    const toolPath = join(process.cwd(), "tools/package-addon.ts");
    const tsxCliPath = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

    const { stdout } = await execFileAsync(process.execPath, [tsxCliPath, toolPath], { cwd: repoRoot });
    const result = JSON.parse(stdout) as { packageDir: string; files: string[]; manifestSha256: string };

    expect(result.packageDir).toBe(join(repoRoot, "dist-addon", "smartthings_web_bridge"));
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.files).toContain("package-lock.json");
    await expect(readFile(join(result.packageDir, "addon-package-manifest.json"), "utf8")).resolves.toContain(
      "\"schema_version\": 1",
    );
  });
});

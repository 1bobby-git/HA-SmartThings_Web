import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const updater = join(repoRoot, "tools", "update-local-addon.sh");

function createBridgePackage(root: string): { archive: string; sha256: string } {
  const packageRoot = join(root, "package");
  const packageDir = join(packageRoot, "smartthings_web_bridge");
  const archive = join(root, "smartthings-web-bridge-0.1.168.tgz");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "config.yaml"),
    'name: SmartThings Web Bridge\nslug: "smartthings_web_bridge"\nversion: "0.1.168"\n',
  );
  writeFileSync(join(packageDir, "new.txt"), "new\n");
  execFileSync("tar", ["-C", packageRoot, "-czf", archive, "smartthings_web_bridge"]);
  return {
    archive,
    sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  };
}

function createFakeHa(root: string): { fakeHa: string; haLog: string } {
  const binRoot = join(root, "bin");
  const haLog = join(root, "ha-calls.log");
  const fakeHa = join(binRoot, "ha");
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(
    fakeHa,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(haLog)}\nif [[ "$1" == "addons" && "$2" == "info" ]]; then\n  printf 'version: 0.1.167\\nversion_latest: 0.1.167\\n'\nfi\n`,
    { mode: 0o755 },
  );
  return { fakeHa, haLog };
}

function createHealthEndpoint(root: string): string {
  const healthRoot = join(root, "health-endpoint");
  mkdirSync(join(healthRoot, "health"), { recursive: true });
  writeFileSync(join(healthRoot, "health", "live"), "ok\n");
  return `file://${healthRoot}`;
}

function runUpdater(root: string, addonsRoot: string, backupRoot: string): string[] {
  const { archive, sha256 } = createBridgePackage(root);
  const { fakeHa, haLog } = createFakeHa(root);
  execFileSync("bash", [updater, "0.1.168"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMARTTHINGS_WEB_ADDONS_ROOT: addonsRoot,
      SMARTTHINGS_WEB_BACKUP_ROOT: backupRoot,
      SMARTTHINGS_WEB_HA_BIN: fakeHa,
      SMARTTHINGS_WEB_BRIDGE_ASSET_URL: `file://${archive}`,
      SMARTTHINGS_WEB_BRIDGE_SHA256: sha256,
      SMARTTHINGS_WEB_BRIDGE_URL: createHealthEndpoint(root),
    },
    stdio: "pipe",
  });
  return readFileSync(haLog, "utf8").trim().split("\n");
}

const expectedHaCalls = [
  "addons info local_smartthings_web_bridge",
  "addons reload",
  "addons update local_smartthings_web_bridge",
  "addons start local_smartthings_web_bridge",
  "addons info local_smartthings_web_bridge",
];

describe("local SmartThings Web Bridge update helper", () => {
  test("replaces one quoted-slug source tree, keeps a backup, and invokes Supervisor update", () => {
    const root = mkdtempSync(join(tmpdir(), "smartthings-web-local-update-"));
    const addonsRoot = join(root, "addons");
    const addonDir = join(addonsRoot, "smartthings_web_bridge");
    const backupRoot = join(root, "backups");

    mkdirSync(addonDir, { recursive: true });
    writeFileSync(
      join(addonDir, "config.yaml"),
      'name: SmartThings Web Bridge\nslug: "smartthings_web_bridge"\nversion: "0.1.167"\n',
    );
    writeFileSync(join(addonDir, "old.txt"), "old\n");

    const calls = runUpdater(root, addonsRoot, backupRoot);

    expect(readFileSync(join(addonDir, "config.yaml"), "utf8")).toContain('version: "0.1.168"');
    expect(readFileSync(join(addonDir, "new.txt"), "utf8")).toBe("new\n");
    expect(() => readFileSync(join(addonDir, "old.txt"), "utf8")).toThrow();
    expect(calls).toEqual(expectedHaCalls);
    expect(readdirSync(backupRoot).some((name) => name.endsWith(".tgz"))).toBe(true);
  });

  test("recreates a missing /addons source tree for an already installed local app", () => {
    const root = mkdtempSync(join(tmpdir(), "smartthings-web-local-bootstrap-"));
    const addonsRoot = join(root, "addons");
    const addonDir = join(addonsRoot, "smartthings_web_bridge");
    const backupRoot = join(root, "backups");
    mkdirSync(addonsRoot, { recursive: true });

    const calls = runUpdater(root, addonsRoot, backupRoot);

    expect(readFileSync(join(addonDir, "config.yaml"), "utf8")).toContain('version: "0.1.168"');
    expect(readFileSync(join(addonDir, "new.txt"), "utf8")).toBe("new\n");
    expect(calls).toEqual(expectedHaCalls);
    expect(existsSync(backupRoot)).toBe(false);
  });
});

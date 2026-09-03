import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const updater = join(repoRoot, "tools", "update-local-addon.sh");

describe("local SmartThings Web Bridge update helper", () => {
  test("replaces one local source tree, keeps a backup, and invokes Supervisor update", () => {
    const root = mkdtempSync(join(tmpdir(), "smartthings-web-local-update-"));
    const addonsRoot = join(root, "addons");
    const addonDir = join(addonsRoot, "smartthings_web_bridge");
    const packageRoot = join(root, "package");
    const packageDir = join(packageRoot, "smartthings_web_bridge");
    const backupRoot = join(root, "backups");
    const binRoot = join(root, "bin");
    const haLog = join(root, "ha-calls.log");
    const archive = join(root, "smartthings-web-bridge-0.1.168.tgz");

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(
      join(addonDir, "config.yaml"),
      "name: SmartThings Web Bridge\nslug: smartthings_web_bridge\nversion: 0.1.167\n",
    );
    writeFileSync(join(addonDir, "old.txt"), "old\n");
    writeFileSync(
      join(packageDir, "config.yaml"),
      "name: SmartThings Web Bridge\nslug: smartthings_web_bridge\nversion: 0.1.168\n",
    );
    writeFileSync(join(packageDir, "new.txt"), "new\n");
    execFileSync("tar", ["-C", packageRoot, "-czf", archive, "smartthings_web_bridge"]);

    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const fakeHa = join(binRoot, "ha");
    writeFileSync(
      fakeHa,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(haLog)}\n`,
      { mode: 0o755 },
    );

    execFileSync("bash", [updater, "0.1.168"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SMARTTHINGS_WEB_ADDONS_ROOT: addonsRoot,
        SMARTTHINGS_WEB_BACKUP_ROOT: backupRoot,
        SMARTTHINGS_WEB_HA_BIN: fakeHa,
        SMARTTHINGS_WEB_BRIDGE_ASSET_URL: `file://${archive}`,
        SMARTTHINGS_WEB_BRIDGE_SHA256: sha256,
      },
      stdio: "pipe",
    });

    expect(readFileSync(join(addonDir, "config.yaml"), "utf8")).toContain("version: 0.1.168");
    expect(readFileSync(join(addonDir, "new.txt"), "utf8")).toBe("new\n");
    expect(() => readFileSync(join(addonDir, "old.txt"), "utf8")).toThrow();
    expect(readFileSync(haLog, "utf8").trim().split("\n")).toEqual([
      "addons reload",
      "addons update local_smartthings_web_bridge",
      "addons info local_smartthings_web_bridge",
    ]);
    expect(readdirSync(backupRoot).some((name) => name.endsWith(".tgz"))).toBe(true);
  });
});

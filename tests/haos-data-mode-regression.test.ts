import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readText = (path: string) => readFileSync(path, "utf8");

describe("HAOS AppArmor ownership handoff", () => {
  test("changes modes as pwuser without granting CAP_FOWNER", () => {
    const prepare = readText(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data"
    );
    const apparmor = readText("addon/smartthings_web_bridge/apparmor.txt");
    const smoke = readText("tools/ci-haos-runtime-smoke.sh");

    expect(prepare).toContain(
      's6-setuidgid pwuser chmod "$pm_mode" "$pm_path" || fail "$pm_failure"'
    );
    expect(prepare).toContain(
      'set_pwuser_mode 0700 "$DATA_DIR" "data_dir_mode"'
    );
    expect(prepare).toContain(
      'set_pwuser_mode 0700 "$rd_path" "runtime_directory_mode:$rd_label"'
    );
    expect(prepare).toContain(
      'set_pwuser_mode 0600 "$pf_path" "critical_file_mode:$pf_label"'
    );
    expect(prepare).not.toContain(
      'chown pwuser:pwuser "$DATA_DIR" || fail "data_dir_chown"\nchmod 0700 "$DATA_DIR"'
    );
    expect(apparmor).not.toContain("capability fowner,");
    expect(smoke).toContain("--cap-drop=FOWNER");
    expect(smoke).toContain("grep -q 'data_prep:ready'");
  });

  test("sets marker mode before handing ownership to pwuser", () => {
    const maintenance = readText(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/maintain-profile"
    );
    const modeIndex = maintenance.indexOf('chmod 0600 "$marker"');
    const ownerIndex = maintenance.indexOf('chown pwuser:pwuser "$marker"');
    expect(modeIndex).toBeGreaterThan(-1);
    expect(ownerIndex).toBeGreaterThan(modeIndex);
  });
});

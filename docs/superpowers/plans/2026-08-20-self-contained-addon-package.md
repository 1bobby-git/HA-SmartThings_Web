# Self-Contained Home Assistant Add-on Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and verify a self-contained local Home Assistant add-on directory that Supervisor can build without access to the monorepo parent directory.

**Architecture:** A pure TypeScript packager copies an allowlisted set of canonical monorepo files into ignored `dist-addon/smartthings_web_bridge`, rewrites no source content, rejects links, and emits deterministic SHA-256 metadata. The add-on Dockerfile becomes context-local and all install documentation points to the generated directory.

**Tech Stack:** Node.js 24, TypeScript 7, Vitest 4, Docker/BuildKit, Home Assistant local add-on metadata.

---

### Task 1: Lock the self-contained package contract

**Files:**
- Create: `tests/addon-package.test.ts`
- Create: `tools/package-addon.ts`

- [ ] **Step 1: Write the failing package-layout tests**

Add tests that import the wished-for API and require the exact package layout:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { packageAddon } from "../tools/package-addon.js";

test("creates a self-contained Supervisor build context", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "stw-addon-package-"));
  try {
    const result = packageAddon({ repoRoot: process.cwd(), outputRoot });
    expect(result.packageDir).toBe(join(outputRoot, "smartthings_web_bridge"));
    expect(result.files).toEqual(expect.arrayContaining([
      "config.yaml",
      "Dockerfile",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "bridge/src/main.ts",
      "rootfs/etc/nginx/nginx.conf",
      "addon-package-manifest.json"
    ]));
    const dockerfile = readFileSync(join(result.packageDir, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY bridge ./bridge");
    expect(dockerfile).toContain("COPY rootfs /");
    expect(dockerfile).not.toContain("COPY addon/");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run tests/addon-package.test.ts`

Expected: FAIL because `tools/package-addon.ts` does not exist.

- [ ] **Step 3: Add forbidden-content and deterministic-manifest tests**

Require that packaged paths contain no `node_modules`, tests, fixtures, `.git`, `.env`, `bridge-secret`, `chromium-profile`, or symlinks. Package twice and assert identical manifest text and removal of an injected stale file.

- [ ] **Step 4: Re-run and confirm the failures describe missing behavior**

Run: `npx vitest run tests/addon-package.test.ts`

Expected: FAIL only because the packager API is missing.

### Task 2: Implement the allowlisted packager

**Files:**
- Create: `tools/package-addon.ts`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Implement the package API and CLI**

Use explicit allowlists and link rejection:

```ts
export interface PackageAddonOptions {
  repoRoot: string;
  outputRoot: string;
}

export interface AddonPackageResult {
  packageDir: string;
  files: string[];
  manifestSha256: string;
}

export function packageAddon(options: PackageAddonOptions): AddonPackageResult {
  const packageDir = resolve(options.outputRoot, "smartthings_web_bridge");
  validateSources(options.repoRoot);
  assertInside(resolve(options.outputRoot), packageDir);
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });
  copyAllowlistedFiles(options.repoRoot, packageDir);
  const manifest = createManifest(packageDir);
  writeFileSync(join(packageDir, "addon-package-manifest.json"), `${stableJson(manifest)}\n`, {
    mode: 0o644
  });
  return summarizePackage(packageDir);
}
```

The approved sources are root `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `bridge/src`, and the files under `addon/smartthings_web_bridge` excluding generated directories.

- [ ] **Step 2: Add the scripts and ignore rule**

Add:

```json
"package:addon": "tsx tools/package-addon.ts"
```

Add `dist-addon/` to `.gitignore`.

- [ ] **Step 3: Run the package tests and confirm GREEN**

Run: `npx vitest run tests/addon-package.test.ts`

Expected: all package tests pass.

- [ ] **Step 4: Generate the real package**

Run: `npm run package:addon`

Expected: `dist-addon/smartthings_web_bridge/addon-package-manifest.json` exists and every listed digest verifies.

### Task 3: Make the add-on Dockerfile context-local

**Files:**
- Modify: `addon/smartthings_web_bridge/Dockerfile`
- Modify: `tests/addon-config.test.ts`

- [ ] **Step 1: Write the failing Docker-context assertions**

Add assertions:

```ts
expect(dockerfile).toContain("COPY bridge ./bridge");
expect(dockerfile).toContain("COPY rootfs /");
expect(dockerfile).not.toContain("COPY addon/smartthings_web_bridge/rootfs /");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run tests/addon-config.test.ts`

Expected: FAIL on the repository-root `COPY addon/smartthings_web_bridge/rootfs /` line.

- [ ] **Step 3: Change only the rootfs copy path**

Replace it with:

```dockerfile
COPY rootfs /
```

All other build inputs already become available at the generated context root.

- [ ] **Step 4: Run focused package/add-on tests**

Run: `npx vitest run tests/addon-config.test.ts tests/addon-package.test.ts`

Expected: PASS.

### Task 4: Correct the installation documentation

**Files:**
- Modify: `README.md`
- Modify: `addon/smartthings_web_bridge/DOCS.md`
- Modify: `addon/smartthings_web_bridge/README.md`
- Modify: `MANUAL_TEST.md`
- Modify: `tests/documentation-gate.test.ts`

- [ ] **Step 1: Write failing documentation assertions**

Require `npm run package:addon`, `dist-addon/smartthings_web_bridge`, and an explicit warning not to copy the raw source-template folder.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run tests/documentation-gate.test.ts`

Expected: FAIL because documentation still points to the incomplete raw folder.

- [ ] **Step 3: Update the private local-install instructions**

Document the exact generated-directory workflow and keep `/addons/smartthings_web_bridge` as the destination. Do not claim live installation yet.

- [ ] **Step 4: Run documentation and secret gates**

Run: `npx vitest run tests/documentation-gate.test.ts && npm run audit:secrets`

Expected: PASS.

### Task 5: Build and smoke the exact generated context

**Files:**
- Modify after evidence: `protocol/fixtures/2026-08-20-addon-smoke-summary.json`
- Modify after evidence: `protocol/fixtures/2026-08-20-addon-smoke-summary.json.sha256`

- [ ] **Step 1: Build with the generated directory as the only context**

Run:

```powershell
docker build --build-arg BUILD_ARCH=amd64 `
  -f dist-addon/smartthings_web_bridge/Dockerfile `
  -t ha-smartthings-web-addon:phase1-packaged `
  dist-addon/smartthings_web_bridge
```

Expected: build succeeds without reading any parent path.

- [ ] **Step 2: Run the existing isolated Ingress smoke**

Verify `LOGIN_REQUIRED`, liveness 200, readiness 503, allowed Ingress 200, denied client 403, no host ports, and private data modes.

- [ ] **Step 3: Update sanitized smoke evidence and its hash**

Record only image digest, versions, status codes, permissions, and limitations. Do not store profile contents, URLs, identifiers, headers, or credentials.

- [ ] **Step 4: Run full verification**

Run:

```text
npm test
npm run typecheck
npm run build
npm run audit:api-free
npm run audit:secrets
npm run protocol:replay
npm run snapshot:replay
git diff --check
```

Expected: all commands pass and fixture hashes match.

## Self-review

- Every generated input is named explicitly and comes from the canonical monorepo.
- The package output is ignored and can be deleted without losing source.
- Docker proof uses the same context that Home Assistant Supervisor will receive.
- Live HA upload/install remains outside this plan's local mutation scope.
- Git commit/push steps are intentionally omitted because the repository's current plan requires explicit Git authorization.

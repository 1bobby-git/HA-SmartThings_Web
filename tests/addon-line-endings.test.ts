import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const requiredAttributes = [
  "protocol/fixtures/*.json text eol=lf",
  "protocol/fixtures/*.sha256 text eol=lf",
  "protocol/fixtures/**/*.json text eol=lf",
  "protocol/fixtures/**/*.sha256 text eol=lf",
  "addon/smartthings_web_bridge/Dockerfile text eol=lf",
  "addon/smartthings_web_bridge/apparmor.txt text eol=lf",
  "addon/smartthings_web_bridge/config.yaml text eol=lf",
  "addon/smartthings_web_bridge/rootfs/** text eol=lf",
  "docker/** text eol=lf",
  "*.sh text eol=lf"
];

function regularFilesUnder(root: string): string[] {
  const files: string[] = [];
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) {
    return files;
  }
  if (stat.isFile()) {
    return [root];
  }
  if (!stat.isDirectory()) {
    return files;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...regularFilesUnder(path));
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function hasCrLf(bytes: Buffer): boolean {
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      return true;
    }
  }
  return false;
}

function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

describe("add-on runtime line endings", () => {
  test("pins Linux runtime text files to LF in gitattributes", () => {
    const gitattributes = readFileSync(".gitattributes", "utf8").split(/\r?\n/).filter(Boolean);

    for (const rule of requiredAttributes) {
      expect(gitattributes).toContain(rule);
    }
  });

  test("keeps packaged Linux runtime files free of CRLF and BOM shebangs", () => {
    const targetFiles = new Set([
      "addon/smartthings_web_bridge/Dockerfile",
      "addon/smartthings_web_bridge/apparmor.txt",
      "addon/smartthings_web_bridge/config.yaml",
      "docker/Dockerfile",
      ...regularFilesUnder("addon/smartthings_web_bridge/rootfs").map((path) => relative(process.cwd(), path).replace(/\\/g, "/")),
      ...regularFilesUnder("docker").map((path) => relative(process.cwd(), path).replace(/\\/g, "/"))
    ]);

    for (const path of [...targetFiles].sort()) {
      const bytes = readFileSync(path);
      expect(hasCrLf(bytes), `${path} contains CRLF bytes`).toBe(false);

      const text = bytes.toString("utf8");
      if (text.startsWith("\uFEFF#!")) {
        throw new Error(`${path} has a BOM before its shebang`);
      }
      if (text.startsWith("#!")) {
        expect(hasUtf8Bom(bytes), `${path} shebang must not start after a UTF-8 BOM`).toBe(false);
        expect(bytes.subarray(0, 2).toString("utf8"), `${path} shebang must start at byte 0`).toBe("#!");
      }
    }
  });
});

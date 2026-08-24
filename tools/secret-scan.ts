import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export type SecretRule = "secret-assignment" | "bearer-material";

export interface SecretFinding {
  path: string;
  rule: SecretRule;
  line: number;
  key?: string;
}

export interface SecretScanOptions {
  cwd?: string;
  roots?: string[];
}

const productionRoots = ["bridge/src", "addon", "docker", "package.json"];
const skipEntries = new Set([".git", "node_modules", "dist", "package-lock.json"]);
const excludedPathPattern = /^(?:docs|tests|protocol\/fixtures|tools)\//;
const sensitiveAssignment =
  /(?<![A-Za-z0-9_$])["']?(password|mfa(?:Code|_code)?|captcha(?:Code|_code)?|cookie|authorization|csrf(?:Token|_token)?|session(?:Token|_token|[-_]?id)?|access(?:Token|_token)?|refresh(?:Token|_token)?|client(?:Secret|_secret)?|bridge(?:Token|_token)|token|secret)["']?(?![A-Za-z0-9_$])\s*(?:[:=]|=>)\s*["'`][^"'`\n]{3,}["'`]/gi;
const bearerMaterial = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;

export function scanProductionSecrets(options: SecretScanOptions = {}): SecretFinding[] {
  const cwd = options.cwd ?? process.cwd();
  const roots = options.roots ?? productionRoots;
  const findings: SecretFinding[] = [];

  for (const root of roots) {
    walk(join(cwd, root), cwd, (path) => {
      const rel = relative(cwd, path).replace(/\\/g, "/");
      if (excludedPathPattern.test(rel)) {
        return;
      }
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        for (const assignment of line.matchAll(sensitiveAssignment)) {
          findings.push({ path: rel, rule: "secret-assignment", line: index + 1, key: assignment[1] ?? "unknown" });
        }
        if (bearerMaterial.test(line)) {
          findings.push({ path: rel, rule: "bearer-material", line: index + 1 });
        }
      }
    });
  }

  return findings;
}

function walk(path: string, cwd: string, onFile: (path: string) => void): void {
  if (!existsSync(path)) {
    return;
  }
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (skipEntries.has(entry.name)) {
        continue;
      }
      walk(join(path, entry.name), cwd, onFile);
    }
    return;
  }
  if (stat.isFile() && stat.size <= 1_000_000) {
    onFile(path);
  }
}

function runCli(): void {
  const findings = scanProductionSecrets();
  if (findings.length === 0) {
    return;
  }
  console.error("Potential secret material found:");
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line} ${finding.rule}${finding.key ? ` ${finding.key}` : ""}`);
  }
  process.exit(1);
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (executedPath && import.meta.url === executedPath) {
  runCli();
}

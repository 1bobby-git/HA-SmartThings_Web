import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const patterns = [
  /client_secret\s*[:=]/i,
  /refresh_token\s*[:=]/i,
  /access_token\s*[:=]/i,
  /Bearer\s+[A-Za-z0-9._-]{20,}/
];

const roots = ["bridge/src", "addon", "docker", "tools", "package.json"];
const skip = new Set([".git", "node_modules", "package-lock.json"]);
const hits: string[] = [];

for (const root of roots) {
  walk(join(process.cwd(), root));
}

if (hits.length > 0) {
  console.error(`Potential secret material found:\n${hits.join("\n")}`);
  process.exit(1);
}

function walk(dir: string): void {
  if (!existsSync(dir)) {
    return;
  }
  if (!statSync(dir).isDirectory()) {
    scanFile(dir);
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    scanFile(path);
  }
}

function scanFile(path: string): void {
  if (statSync(path).size > 1_000_000) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      hits.push(`${path}: ${pattern}`);
    }
  }
}

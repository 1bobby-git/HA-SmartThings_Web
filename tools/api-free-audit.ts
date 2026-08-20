import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const forbidden = [
  /api\.smartthings\.com/i,
  /\bPAT\b/i,
  /Personal Access Token/i,
  /OAuth/i,
  /installedAppId/i,
  /create_subscription/i,
  /SmartApp/i,
  /webhook/i,
  /@smartthings\/core-sdk/i
];

const roots = ["bridge/src", "addon", "docker", "package.json"];
const skip = new Set([".git", "node_modules", "package-lock.json"]);
const hits: string[] = [];

for (const root of roots) {
  walk(join(process.cwd(), root));
}

if (hits.length > 0) {
  console.error(`Forbidden SmartThings API patterns found:\n${hits.join("\n")}`);
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
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      hits.push(`${path}: ${pattern}`);
    }
  }
}

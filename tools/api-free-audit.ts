import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export type ApiFreeRule =
  | "direct-smartthings-api-host"
  | "smartthings-v1-endpoint"
  | "official-smartthings-auth"
  | "official-smartthings-sdk"
  | "direct-http-client"
  | "polling-smartthings-call"
  | "playwright-network-mutation";

export interface AuditFinding {
  path: string;
  rule: ApiFreeRule;
  line: number;
  excerpt: string;
}

export interface AuditOptions {
  cwd?: string;
  roots?: string[];
}

const defaultProductionRoots = ["bridge/src", "addon", "docker", "package.json"];
const skipEntries = new Set([".git", "node_modules", "dist", "package-lock.json"]);

const rules: Array<{ rule: ApiFreeRule; pattern: RegExp }> = [
  { rule: "direct-smartthings-api-host", pattern: /api\.smartthings\.com/i },
  {
    rule: "smartthings-v1-endpoint",
    pattern: /(?:smartthings\.com\s*[/\\]?|["'`])\/v1\/(?:devices|locations|capabilities|installedapps|subscriptions|scenes|rules)\b/i
  },
  {
    rule: "official-smartthings-auth",
    pattern: /\b(?:PAT|Personal Access Token|OAuth|API Access App|SmartApp|installedApp(?:Id)?|subscription|webhook)\b/i
  },
  {
    rule: "official-smartthings-sdk",
    pattern: /(?:@smartthings\/(?:core-)?sdk|pysmartthings|SmartThingsClient|new\s+SmartThings)/i
  },
  { rule: "direct-http-client", pattern: /\b(?:fetch\s*\(|axios\b|node-fetch\b|got\b|undici\b)/i },
  {
    rule: "playwright-network-mutation",
    pattern: /\.(?:route|fulfill|abort|setExtraHTTPHeaders|addCookies)\s*\(|\b(?:Network\.setRequestInterception|Fetch\.enable)\b/i
  },
  { rule: "polling-smartthings-call", pattern: /setInterval\s*\(/i }
];

export function auditSmartThingsApiFree(options: AuditOptions = {}): AuditFinding[] {
  const cwd = options.cwd ?? process.cwd();
  const roots = options.roots ?? defaultProductionRoots;
  const findings: AuditFinding[] = [];

  for (const root of roots) {
    walk(join(cwd, root), (path) => {
      const text = readFileSync(path, "utf8");
      const lines = text.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        for (const { rule, pattern } of rules) {
          if (pattern.test(line) && isApiFinding(rule, line, lines, index)) {
            findings.push({
              path: relative(cwd, path).replace(/\\/g, "/"),
              rule,
              line: index + 1,
              excerpt: line.trim()
            });
          }
        }
      }
    });
  }

  return findings;
}

function isApiFinding(rule: ApiFreeRule, line: string, lines: string[], index: number): boolean {
  if (rule !== "polling-smartthings-call") {
    return true;
  }
  return /setInterval\s*\(/.test(line) && /smartthings|\/v1\/|fetch\s*\(|axios|got|undici/i.test(nearby(lines, index));
}

function nearby(lines: string[], index: number): string {
  return lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 4)).join("\n");
}

function walk(path: string, onFile: (path: string) => void): void {
  if (!existsSync(path)) {
    return;
  }
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (skipEntries.has(entry.name)) {
        continue;
      }
      walk(join(path, entry.name), onFile);
    }
    return;
  }
  if (stat.isFile() && stat.size <= 1_000_000) {
    onFile(path);
  }
}

function runCli(): void {
  const findings = auditSmartThingsApiFree();
  if (findings.length === 0) {
    return;
  }
  console.error("Forbidden SmartThings API patterns found:");
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line} ${finding.rule} ${finding.excerpt}`);
  }
  process.exit(1);
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (executedPath && import.meta.url === executedPath) {
  runCli();
}

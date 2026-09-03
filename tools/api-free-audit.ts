import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export type ApiFreeRule =
  | "direct-smartthings-api-host"
  | "smartthings-v1-endpoint"
  | "official-smartthings-auth"
  | "official-smartthings-sdk"
  | "direct-http-client"
  | "direct-smartthings-socket"
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
    pattern:
      /\b(?:PAT|Personal Access Token|OAuth|API Access App|SmartApp|installedApp(?:Id)?|webhook)\b|\bcreate[_-]?subscription\s*\(/i
  },
  {
    rule: "official-smartthings-sdk",
    pattern: /(?:@smartthings\/(?:core-)?sdk|pysmartthings|\bSmartThingsClient\b|new\s+SmartThings(?:Client\b|\s*\())/i
  },
  { rule: "direct-http-client", pattern: /\b(?:fetch\s*\(|axios\b|node-fetch\b|got\b|undici\b)/i },
  {
    rule: "direct-smartthings-socket",
    pattern: /new\s+(?:WebSocket|EventSource)\s*\(|\b(?:io|socketIoClient)\s*\(/i
  },
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
          if (
            pattern.test(line) &&
            isApiFinding(
              rule,
              line,
              lines,
              index,
              relative(cwd, path).replace(/\\/g, "/")
            )
          ) {
            findings.push({
              path: relative(cwd, path).replace(/\\/g, "/"),
              rule,
              line: index + 1,
              excerpt: sanitizeAuditExcerpt(line.trim())
            });
          }
        }
      }
    });
  }

  return findings;
}

function sanitizeAuditExcerpt(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"'`,)]+/gi, "Bearer [REDACTED]")
    .replace(
      /(?<![A-Za-z0-9_$])(["']?)((?:x[-_])?(?:csrf(?:Token|[-_]?token)?|api[-_]?secret)|password|mfa(?:Code|_code)?|captcha(?:Code|_code)?|cookie|set[-_]?cookie|authorization|session(?:Token|_token|[-_]?id)?|access(?:Token|_token)?|refresh(?:Token|_token)?|client(?:Secret|[-_]secret)?|bridge(?:Token|_token)|token|secret)\1(?![A-Za-z0-9_$])\s*[:=]\s*(["'`])[^"'`]*\3/gi,
      (_match, quote: string, key: string, valueQuote: string) =>
        `${quote}${key}${quote}: ${valueQuote}[REDACTED]${valueQuote}`
    )
    .replace(
      /([?&](?:access_token|refresh_token|token|session|csrf|authorization)=)[^&#\s"']+/gi,
      "$1[REDACTED]"
    );
}

function isApiFinding(
  rule: ApiFreeRule,
  line: string,
  lines: string[],
  index: number,
  relativePath: string
): boolean {
  const fileText = lines.join("\n");
  if (
    rule === "direct-http-client" &&
    /\bfetch\s*\(\s*["'`]\/?api\/v1\/[A-Za-z0-9._/-]+["'`]/u.test(line)
  ) {
    return false;
  }
  if (
    rule === "direct-http-client" &&
    relativePath === "bridge/src/advanced/authenticated-session.ts" &&
    /authenticated-page-same-origin-advanced-request/u.test(nearby(lines, index)) &&
    /credentials:\s*"same-origin"/u.test(nearby(lines, index)) &&
    /method:\s*input\.method/u.test(nearby(lines, index)) ||
    (
      rule === "direct-http-client" &&
      relativePath === "bridge/src/advanced/authenticated-session.ts" &&
      /authenticated-page-same-origin-advanced-request/u.test(nearby(lines, index)) &&
      /credentials:\s*"same-origin"/u.test(nearby(lines, index)) &&
      /method:\s*"(?:GET|POST)"/u.test(nearby(lines, index))
    )
  ) {
    if (
      /url\.origin\s*!==\s*SMARTTHINGS_ORIGIN/u.test(fileText) &&
      /url\.pathname\.startsWith\("\/advanced\/cupcake-api\/"\)/u.test(fileText)
    ) {
      return false;
    }
  }
  if (
    rule === "direct-http-client" &&
    relativePath === "bridge/src/browser/keeper-page.ts" &&
    /authenticated-page-same-origin-read-only-(?:get|session-touch)/u.test(nearby(lines, index)) &&
    /credentials:\s*"same-origin"/u.test(nearby(lines, index)) &&
    /method:\s*"GET"/u.test(nearby(lines, index))
  ) {
    return false;
  }
  if (
    rule === "playwright-network-mutation" &&
    relativePath === "bridge/src/browser/keeper-page.ts" &&
    /\bcontroller\.abort\(\)/u.test(line) &&
    /authenticated-page-same-origin-read-only-session-touch/u.test(lines.join("\n"))
  ) {
    return false;
  }
  if (
    rule === "playwright-network-mutation" &&
    relativePath === "bridge/src/advanced/authenticated-session.ts" &&
    /\bcontroller\.abort\(\)/u.test(line) &&
    /authenticated-page-same-origin-advanced-request/u.test(fileText) &&
    /url\.origin\s*!==\s*SMARTTHINGS_ORIGIN/u.test(fileText) &&
    /url\.pathname\.startsWith\("\/advanced\/cupcake-api\/"\)/u.test(fileText)
  ) {
    return false;
  }
  if (rule === "direct-smartthings-socket") {
    return /(?:my\.smartthings\.com|smartthings\.com|samsungiotcloud|socket\.io)/i.test(
      nearby(lines, index)
    );
  }
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

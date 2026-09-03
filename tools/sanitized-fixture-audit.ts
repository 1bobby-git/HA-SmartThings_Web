import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type SanitizedFixtureRule =
  | "invalid-json"
  | "uuid"
  | "bearer-material"
  | "ip-address"
  | "sensitive-key"
  | "identifier-value"
  | "filesystem-entry";

export interface SanitizedFixtureFinding {
  path: string;
  rule: SanitizedFixtureRule;
  jsonPath: string;
}

export interface SanitizedFixtureScanOptions {
  cwd?: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type IdentifierKind = "device" | "location" | "account" | "user" | "event" | "subscription" | "ack" | "owner" | "generic";

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const sensitiveAssignmentPattern =
  /(?:password|mfa(?:code)?|captcha(?:code)?|cookie|authorization|csrf(?:token)?|session(?:token|id)?|access(?:token)?|refresh(?:token)?|client(?:secret)?|bridge(?:token)?|token|secret)\s*(?:[:=]|=>)/i;
const tokenLikePattern =
  /(?:^|[^a-z0-9])(?:sk|pk|ghp|github_pat|token|secret|bearer|jwt|session|access|refresh|authorization)[_-]?[a-z0-9._~+/=-]{12,}/i;
const highEntropyPattern = /[A-Za-z0-9._~+/=-]{32,}/;
const safeAliasPatterns: Record<IdentifierKind, RegExp> = {
  device: /^dev_\d{3,}$/,
  location: /^loc_\d{3,}$/,
  account: /^acct_\d{3,}$/,
  user: /^user_\d{3,}$/,
  event: /^evt_\d{3,}$/,
  subscription: /^sub_\d{3,}$/,
  ack: /^ack_\d{3,}$/,
  owner: /^owner_\d{3,}$/,
  generic: /^(?:dev|loc|acct|user|evt|sub|ack|owner)_\d{3,}$/
};

const fixedProtocolStrings = new Set([
  "api/subscription DEVICE_EVENT",
  "api/subscription CONTROL_EVENT",
  "api/subscription SPIGOT_EVENT",
  "find",
  "api/device",
  "api/device/health",
  "api/device/status",
  "api/location",
  "api/room",
  "api/scene"
]);

export function scanSanitizedFixtures(options: SanitizedFixtureScanOptions = {}): SanitizedFixtureFinding[] {
  const cwd = options.cwd ?? process.cwd();
  const fixtureRoot = join(cwd, "protocol", "fixtures");
  if (!existsSync(fixtureRoot)) {
    return [];
  }

  const findings: SanitizedFixtureFinding[] = [];
  walkFixtureJsonFiles(fixtureRoot, cwd, findings, (absolutePath, relPath) => {
    try {
      findings.push(...scanSanitizedFixtureText(relPath, readFileSync(absolutePath, "utf8")));
    } catch {
      findings.push(makeFinding(relPath, "filesystem-entry", "$"));
    }
  });
  return findings;
}

export function scanSanitizedFixtureText(path: string, text: string): SanitizedFixtureFinding[] {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return [makeFinding(path, "invalid-json", "$")];
  }

  const findings: SanitizedFixtureFinding[] = [];
  visitJson(parsed, "$", undefined, (value, jsonPath, key) => {
    if (typeof value !== "string") {
      return;
    }
    if (fixedProtocolStrings.has(value)) {
      return;
    }
    if (uuidPattern.test(value)) {
      findings.push(makeFinding(path, "uuid", jsonPath));
    }
    if (bearerPattern.test(value)) {
      findings.push(makeFinding(path, "bearer-material", jsonPath));
    }
    if (isIP(value) !== 0) {
      findings.push(makeFinding(path, "ip-address", jsonPath));
    }
    if (key && isSensitiveKey(key) && value !== "[REDACTED]") {
      findings.push(makeFinding(path, "sensitive-key", jsonPath));
    }

    const identifierKind = key ? identifierKindForKey(key) : undefined;
    if (identifierKind && !safeAliasPatterns[identifierKind].test(value)) {
      findings.push(makeFinding(path, "identifier-value", jsonPath));
    }
  });

  return findings;
}

export function formatSanitizedFixtureFinding(finding: SanitizedFixtureFinding): string {
  return `${finding.path} ${finding.rule} ${finding.jsonPath}`;
}

function visitJson(
  value: JsonValue,
  jsonPath: string,
  key: string | undefined,
  onValue: (value: JsonValue, jsonPath: string, key: string | undefined) => void
): void {
  onValue(value, jsonPath, key);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visitJson(item, `${jsonPath}[${index}]`, key, onValue);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      visitJson(childValue, `${jsonPath}.${formatPathKey(childKey)}`, childKey, onValue);
    }
  }
}

function walkFixtureJsonFiles(
  absolutePath: string,
  cwd: string,
  findings: SanitizedFixtureFinding[],
  onJsonFile: (absolutePath: string, relPath: string) => void
): void {
  const relPath = relative(cwd, absolutePath).replace(/\\/g, "/");
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    findings.push(makeFinding(relPath, "filesystem-entry", "$"));
    return;
  }

  if (stat.isSymbolicLink()) {
    findings.push(makeFinding(relPath, "filesystem-entry", "$"));
    return;
  }

  if (stat.isDirectory()) {
    let entries;
    try {
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      findings.push(makeFinding(relPath, "filesystem-entry", "$"));
      return;
    }
    for (const entry of entries) {
      walkFixtureJsonFiles(join(absolutePath, entry.name), cwd, findings, onJsonFile);
    }
    return;
  }

  if (stat.isFile() && absolutePath.endsWith(".json")) {
    onJsonFile(absolutePath, relPath);
  }
}

function formatPathKey(key: string): string {
  if (isUnsafeReportSegment(key)) {
    return "[REDACTED_KEY]";
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

function makeFinding(path: string, rule: SanitizedFixtureRule, jsonPath: string): SanitizedFixtureFinding {
  return {
    path: sanitizeReportPath(path),
    rule,
    jsonPath
  };
}

function sanitizeReportPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (isUnsafeReportSegment(segment) ? "[REDACTED_PATH]" : segment))
    .join("/");
}

function isUnsafeReportSegment(segment: string): boolean {
  if (segment === "." || segment === "..") {
    return true;
  }
  if (uuidPattern.test(segment) || bearerPattern.test(segment) || emailPattern.test(segment)) {
    return true;
  }
  if (hasValidIpCandidate(segment)) {
    return true;
  }
  if (sensitiveAssignmentPattern.test(segment) || tokenLikePattern.test(segment)) {
    return true;
  }
  return highEntropyPattern.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

function hasValidIpCandidate(text: string): boolean {
  for (const candidate of ipCandidates(text)) {
    if (isIP(candidate) !== 0) {
      return true;
    }
  }
  return false;
}

function ipCandidates(text: string): string[] {
  const candidates = new Set<string>([text]);
  const stem = stripKnownReportExtension(text);
  candidates.add(stem);

  for (const source of [text, stem]) {
    const bracketedIpv6 = source.match(/\[([0-9A-Fa-f:.]+)\]/);
    if (bracketedIpv6?.[1]) {
      candidates.add(bracketedIpv6[1]);
    }

    for (const match of source.matchAll(/(?:^|[^0-9])((?:\d{1,3}\.){3}\d{1,3})(?:$|[^0-9])/g)) {
      if (match[1]) {
        candidates.add(match[1]);
      }
    }
  }

  return [...candidates];
}

function stripKnownReportExtension(text: string): string {
  return text.replace(/\.(?:json|sha256)$/i, "");
}

function isSensitiveKey(key: string): boolean {
  if (key.startsWith("/") || key.endsWith("_redacted")) {
    return false;
  }
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "password" ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "sessiontoken" ||
    normalized === "clientsecret" ||
    normalized === "csrftoken" ||
    normalized === "captchacode" ||
    normalized === "mfacode"
  );
}

function identifierKindForKey(key: string): IdentifierKind | undefined {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  switch (normalized) {
    case "deviceid":
    case "deviceids":
      return "device";
    case "locationid":
    case "locationids":
      return "location";
    case "accountid":
    case "accountids":
      return "account";
    case "userid":
    case "userids":
      return "user";
    case "eventid":
    case "eventids":
      return "event";
    case "subscriptionid":
    case "subscriptionids":
      return "subscription";
    case "ackid":
    case "ackids":
      return "ack";
    case "ownerid":
    case "ownerids":
      return "owner";
    case "id":
    case "ids":
      return "generic";
    default:
      return undefined;
  }
}

function runCli(): void {
  const findings = scanSanitizedFixtures();
  if (findings.length === 0) {
    return;
  }
  console.error("Unsafe protocol fixture material found:");
  for (const finding of findings) {
    console.error(formatSanitizedFixtureFinding(finding));
  }
  process.exit(1);
}

if (isCliInvocation()) {
  runCli();
}

function isCliInvocation(): boolean {
  if (process.env.SANITIZED_FIXTURE_AUDIT_CLI === "1" || process.env.npm_lifecycle_event === "audit:fixtures") {
    return true;
  }
  return process.argv.some((arg) => {
    const normalized = arg.replace(/\\/g, "/");
    return normalized === "sanitized-fixture-audit.ts" || normalized.endsWith("/sanitized-fixture-audit.ts");
  }) || (!isVitestProcess() && fileURLToPath(import.meta.url).replace(/\\/g, "/").endsWith("/tools/sanitized-fixture-audit.ts"));
}

function isVitestProcess(): boolean {
  return process.env.VITEST === "true" || process.argv.some((arg) => arg.includes("vitest"));
}

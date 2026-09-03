import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  evaluateWebParity,
  reportHasFailingParity,
  type HomeAssistantEntityProjection,
  type WebParityInventory
} from "./smartthings-web-parity-audit-core.js";

const MAX_INPUT_BYTES = 4_000_000;
const DEFAULT_TOKEN_FILE = "/data/bridge-secret";
const SAFE_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SAFE_ADDON_HOST_PATTERN = /^local-smartthings-web-bridge(?:\.local)?$/u;

interface CliOptions {
  inventoryFile?: string | undefined;
  projectionFile: string;
  bridgeUrl?: string | undefined;
  tokenFile?: string | undefined;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const [inventory, projection] = await Promise.all([
    readInventory(options),
    readJsonFile<HomeAssistantEntityProjection[]>(options.projectionFile)
  ]);
  const report = evaluateWebParity(inventory, projection);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (reportHasFailingParity(report)) {
    process.exitCode = 1;
  }
}

async function readInventory(options: CliOptions): Promise<WebParityInventory> {
  if (options.inventoryFile) {
    return readJsonFile<WebParityInventory>(options.inventoryFile);
  }
  if (!options.bridgeUrl) {
    throw new Error("web_parity_audit_inventory_source_required");
  }
  const token = await readToken(options.tokenFile);
  try {
    const response = await fetch(
      new URL("/api/v1/inventory", normalizedBridgeUrl(options.bridgeUrl)),
      { headers: token ? { authorization: `Bearer ${token}` } : {} }
    );
    if (!response.ok) {
      throw new Error("web_parity_audit_bridge_inventory_failed");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
      throw new Error("web_parity_audit_input_too_large");
    }
    return JSON.parse(text) as WebParityInventory;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("web_parity_audit_")) {
      throw error;
    }
    throw new Error("web_parity_audit_bridge_inventory_failed");
  }
}

async function readToken(tokenFile: string | undefined): Promise<string | undefined> {
  if (!tokenFile) {
    const envToken = validateToken(process.env.SMARTTHINGS_WEB_PARITY_AUDIT_TOKEN);
    if (envToken) return envToken;
  }
  const path = tokenFile ?? (existsSync(DEFAULT_TOKEN_FILE) ? DEFAULT_TOKEN_FILE : undefined);
  if (!path) return undefined;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("web_parity_audit_token_file_invalid");
  }
  if (Buffer.byteLength(text, "utf8") > 16_384) {
    throw new Error("web_parity_audit_token_file_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return validateToken(text.trim());
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const value = (parsed as Record<string, unknown>).bridge_token;
    return typeof value === "string" ? validateToken(value) : undefined;
  }
  throw new Error("web_parity_audit_token_file_invalid");
}

async function readJsonFile<T>(path: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("web_parity_audit_file_read_failed");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("web_parity_audit_input_too_large");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("web_parity_audit_json_invalid");
  }
}

function validateToken(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (Buffer.byteLength(value, "utf8") > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("web_parity_audit_token_invalid");
  }
  return value;
}

function normalizedBridgeUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!SAFE_LOOPBACK_HOSTS.has(url.hostname) && !SAFE_ADDON_HOST_PATTERN.test(url.hostname))
  ) {
    throw new Error("web_parity_audit_bridge_url_invalid");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("web_parity_audit_arguments_invalid");
    }
    if (values.has(key)) {
      throw new Error("web_parity_audit_arguments_invalid");
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--inventory",
    "--projection",
    "--bridge-url",
    "--token-file"
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error("web_parity_audit_arguments_invalid");
    }
  }
  const projectionFile = values.get("--projection");
  if (!projectionFile) {
    throw new Error("web_parity_audit_projection_required");
  }
  if (values.has("--inventory") === values.has("--bridge-url")) {
    throw new Error("web_parity_audit_inventory_source_required");
  }
  return {
    inventoryFile: values.get("--inventory"),
    projectionFile,
    bridgeUrl: values.get("--bridge-url"),
    tokenFile: values.get("--token-file")
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "web_parity_audit_failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

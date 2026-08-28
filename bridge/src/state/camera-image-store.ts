import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeSocketIoTextFrame } from "../inspector/socketio-decoder.js";
import type { BridgeInventory } from "./device-store.js";

export interface BridgeCameraImage {
  body: Buffer;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  capturedAt: string;
}

interface CameraImageStoreOptions {
  dataDir: string;
  aliasDeviceId: (rawDeviceId: string) => string;
  fetchImage?: typeof fetch;
  now?: () => Date;
  maxBytes?: number;
}

interface PersistedMetadata {
  schemaVersion: 1;
  contentType: BridgeCameraImage["contentType"];
  capturedAt: string;
}

const DEVICE_ALIAS = /^dev_[0-9]{3,32}$/u;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_HOST_SUFFIXES = [
  ".st-av.net",
  ".smartthings.com",
  ".samsung.com",
  ".samsungcloud.com",
  ".samsungiotcloud.com",
  ".akamaized.net"
] as const;

export class CameraImageStore {
  readonly #root: string;
  readonly #aliasDeviceId: (rawDeviceId: string) => string;
  readonly #fetchImage: typeof fetch;
  readonly #now: () => Date;
  readonly #maxBytes: number;
  readonly #pendingThumbnails = new Map<string, string>();
  readonly #pendingBinaryThumbnails = new Map<
    string,
    Array<{ deviceId: string; remaining: number }>
  >();
  readonly #imageUrlDevices = new Map<string, string>();
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: CameraImageStoreOptions) {
    this.#root = join(options.dataDir, "camera-images");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    chmodSync(this.#root, 0o700);
    this.#aliasDeviceId = options.aliasDeviceId;
    this.#fetchImage = options.fetchImage ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  }

  observeRawWebSocketFrame(
    direction: "sent" | "received",
    raw: string,
    connectionId = "legacy"
  ): void {
    const decoded = decodeSocketIoTextFrame(raw);
    if (direction === "sent" && decoded.kind === "event") {
      if (
        decoded.eventName === "get" &&
        decoded.args[0] === "api/camera/thumbnail" &&
        decoded.ackId !== undefined &&
        typeof decoded.args[1] === "string"
      ) {
        const imageUrl = safeCameraImageUrl(decoded.args[1]);
        const alias = imageUrl
          ? this.#imageUrlDevices.get(imageUrl)
          : this.#safeAlias(decoded.args[1]);
        if (alias) this.#pendingThumbnails.set(pendingKey(connectionId, decoded.ackId), alias);
      }
      return;
    }
    if (direction !== "received") return;
    for (const reference of findImageReferences(decoded)) {
      const alias = this.#safeAlias(reference.rawDeviceId);
      const url = safeCameraImageUrl(reference.url);
      if (alias && url) this.#imageUrlDevices.set(url, alias);
    }
    if (decoded.kind === "binary_ack" && decoded.ackId !== undefined) {
      const key = pendingKey(connectionId, decoded.ackId);
      const alias = this.#pendingThumbnails.get(key);
      this.#pendingThumbnails.delete(key);
      if (!alias || decoded.attachments < 1) return;
      const pending = this.#pendingBinaryThumbnails.get(connectionId) ?? [];
      pending.push({ deviceId: alias, remaining: decoded.attachments });
      this.#pendingBinaryThumbnails.set(connectionId, pending);
      return;
    }
    if (decoded.kind === "ack" && decoded.ackId !== undefined) {
      const key = pendingKey(connectionId, decoded.ackId);
      const alias = this.#pendingThumbnails.get(key);
      this.#pendingThumbnails.delete(key);
      if (!alias) return;
      const body = decoded.args[0] === null ? decoded.args[1] : decoded.args[0];
      const url = findImageUrl(body);
      if (url) this.#download(alias, url);
      return;
    }
    if (decoded.kind !== "event" || decoded.eventName !== "api/subscription DEVICE_EVENT") {
      return;
    }
    const envelope = asRecord(decoded.args[0]);
    const data = asRecord(envelope?.data);
    const event = asRecord(data?.device_event ?? data?.deviceEvent);
    const attribute = readString(event?.attribute);
    const rawDeviceId = readString(event?.device_id ?? event?.deviceId);
    const url = readString(event?.value);
    if (attribute !== "image" || !rawDeviceId || !url) return;
    const alias = this.#safeAlias(rawDeviceId);
    if (alias) this.#download(alias, url);
  }

  observeRawWebSocketBinaryFrame(
    direction: "sent" | "received",
    raw: ArrayBuffer | ArrayBufferView,
    connectionId = "legacy"
  ): void {
    if (direction !== "received") return;
    const pending = this.#pendingBinaryThumbnails.get(connectionId);
    const current = pending?.[0];
    if (!pending || !current) return;
    current.remaining -= 1;
    if (current.remaining <= 0) pending.shift();
    if (pending.length === 0) this.#pendingBinaryThumbnails.delete(connectionId);

    const body = toBuffer(raw);
    const contentType = imageContentType(body);
    if (!contentType || body.length === 0 || body.length > this.#maxBytes) return;
    this.#persist(current.deviceId, body, contentType, this.#now().toISOString());
  }

  observeInventory(inventory: BridgeInventory): void {
    for (const device of inventory.devices) {
      if (!DEVICE_ALIAS.test(device.id)) continue;
      for (const state of device.states) {
        if (state.attribute !== "image" || typeof state.value !== "string") continue;
        const url = safeCameraImageUrl(state.value);
        if (!url) continue;
        this.#imageUrlDevices.set(url, device.id);
        this.#download(device.id, url);
      }
    }
  }

  observeRawAdvancedDeviceSnapshot(snapshot: unknown): void {
    const rows = advancedDeviceRows(snapshot);
    if (!rows) return;
    for (const row of rows) {
      const rawDeviceId = readString(row.deviceId ?? row.device_id ?? row.id);
      if (!rawDeviceId) continue;
      const alias = this.#safeAlias(rawDeviceId);
      if (!alias) continue;
      for (const url of findAdvancedImageUrls(row)) {
        this.#imageUrlDevices.set(url, alias);
        this.#download(alias, url);
      }
    }
  }

  get(deviceId: string): BridgeCameraImage | undefined {
    if (!DEVICE_ALIAS.test(deviceId)) return undefined;
    try {
      const metadata = parseMetadata(
        JSON.parse(readFileSync(join(this.#root, `${deviceId}.json`), "utf8"))
      );
      if (!metadata) return undefined;
      const body = readFileSync(join(this.#root, `${deviceId}.bin`));
      if (body.length === 0 || body.length > this.#maxBytes) return undefined;
      return { body, contentType: metadata.contentType, capturedAt: metadata.capturedAt };
    } catch {
      return undefined;
    }
  }

  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  reset(): void {
    this.#pendingThumbnails.clear();
    this.#pendingBinaryThumbnails.clear();
    this.#imageUrlDevices.clear();
  }

  #safeAlias(rawDeviceId: string): string | undefined {
    try {
      const alias = this.#aliasDeviceId(rawDeviceId);
      return DEVICE_ALIAS.test(alias) ? alias : undefined;
    } catch {
      return undefined;
    }
  }

  #download(deviceId: string, rawUrl: string): void {
    const task = this.#downloadAndPersist(deviceId, rawUrl).catch(() => undefined);
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
  }

  async #downloadAndPersist(deviceId: string, rawUrl: string): Promise<void> {
    const url = safeCameraImageUrl(rawUrl);
    if (!url) return;
    const response = await this.#fetchImage(url, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) return;
    const contentType = safeContentType(response.headers.get("content-type"));
    if (!contentType) return;
    const declaredLengthHeader = response.headers.get("content-length");
    if (declaredLengthHeader !== null) {
      const declaredLength = Number(declaredLengthHeader);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > this.#maxBytes) {
        return;
      }
    }
    const body = await readBoundedResponseBody(response, this.#maxBytes);
    if (!body) return;
    this.#persist(deviceId, body, contentType, this.#now().toISOString());
  }

  #persist(
    deviceId: string,
    body: Buffer,
    contentType: BridgeCameraImage["contentType"],
    capturedAt: string
  ): void {
    const bodyPath = join(this.#root, `${deviceId}.bin`);
    const metadataPath = join(this.#root, `${deviceId}.json`);
    const tempBody = `${bodyPath}.tmp`;
    const tempMetadata = `${metadataPath}.tmp`;
    writeFileSync(tempBody, body, { mode: 0o600 });
    writeFileSync(
      tempMetadata,
      JSON.stringify({ schemaVersion: 1, contentType, capturedAt } satisfies PersistedMetadata),
      { encoding: "utf8", mode: 0o600 }
    );
    if (statSync(tempBody).size !== body.length) return;
    renameSync(tempBody, bodyPath);
    renameSync(tempMetadata, metadataPath);
    chmodSync(bodyPath, 0o600);
    chmodSync(metadataPath, 0o600);
  }
}

function toBuffer(value: ArrayBuffer | ArrayBufferView): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function imageContentType(body: Buffer): BridgeCameraImage["contentType"] | undefined {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    body.length >= 8 &&
    body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;

  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value || result.value.byteLength === 0) continue;
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("camera_image_too_large").catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }

  return byteLength === 0 ? undefined : Buffer.concat(chunks, byteLength);
}

export function safeCameraImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const hostname = url.hostname.toLowerCase();
    if (!ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function pendingKey(connectionId: string, ackId: number): string {
  return `${connectionId}\u0000${ackId}`;
}

function safeContentType(value: string | null | undefined): BridgeCameraImage["contentType"] | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === "image/jpeg" || normalized === "image/png" || normalized === "image/webp"
    ? normalized
    : undefined;
}

function parseMetadata(value: unknown): PersistedMetadata | undefined {
  const record = asRecord(value);
  const contentType = safeContentType(readString(record?.contentType));
  const capturedAt = readString(record?.capturedAt);
  if (
    record?.schemaVersion !== 1 ||
    !contentType ||
    !capturedAt ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    return undefined;
  }
  return { schemaVersion: 1, contentType, capturedAt };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findImageUrl(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findImageUrl(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = readString(record.url);
  if (direct) return direct;
  for (const nestedValue of Object.values(record)) {
    const nested = findImageUrl(nestedValue, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function findImageReferences(
  value: unknown,
  depth = 0,
  references: Array<{ rawDeviceId: string; url: string }> = []
): Array<{ rawDeviceId: string; url: string }> {
  if (depth > 8 || value === null || typeof value !== "object") return references;
  if (Array.isArray(value)) {
    for (const item of value) findImageReferences(item, depth + 1, references);
    return references;
  }

  const record = value as Record<string, unknown>;
  const attribute = readString(record.attributeName ?? record.attribute);
  const rawDeviceId = readString(record.deviceId ?? record.device_id);
  const url = readString(record.value);
  if (attribute === "image" && rawDeviceId && url) {
    references.push({ rawDeviceId, url });
  }
  for (const nested of Object.values(record)) {
    findImageReferences(nested, depth + 1, references);
  }
  return references;
}

function advancedDeviceRows(value: unknown): Record<string, unknown>[] | null {
  const record = asRecord(value);
  const rows =
    record && Array.isArray(record.items)
      ? record.items
      : record && Array.isArray(record.devices)
        ? record.devices
        : record && Array.isArray(record.data)
          ? record.data
          : value;
  if (!Array.isArray(rows)) return null;
  const records = rows.map(asRecord);
  return records.some((item) => !item) ? null : (records as Record<string, unknown>[]);
}

function findAdvancedImageUrls(value: unknown, keyHint?: string, depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => findAdvancedImageUrls(item, keyHint, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const attribute = readString(record.attributeName ?? record.attribute) ?? keyHint;
  const directValue = readString(record.value);
  const directUrl =
    attribute === "image" && directValue ? safeCameraImageUrl(directValue) : undefined;
  const nestedUrls = Object.entries(record).flatMap(([key, nested]) =>
    findAdvancedImageUrls(nested, key, depth + 1)
  );
  return directUrl ? [directUrl, ...nestedUrls] : nestedUrls;
}

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeSocketIoTextFrame } from "../inspector/socketio-decoder.js";

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
  readonly #pendingThumbnails = new Map<number, string>();
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

  observeRawWebSocketFrame(direction: "sent" | "received", raw: string): void {
    const decoded = decodeSocketIoTextFrame(raw);
    if (direction === "sent" && decoded.kind === "event") {
      if (
        decoded.eventName === "get" &&
        decoded.args[0] === "api/camera/thumbnail" &&
        decoded.ackId !== undefined &&
        typeof decoded.args[1] === "string"
      ) {
        const alias = this.#safeAlias(decoded.args[1]);
        if (alias) this.#pendingThumbnails.set(decoded.ackId, alias);
      }
      return;
    }
    if (direction !== "received") return;
    if (decoded.kind === "ack" && decoded.ackId !== undefined) {
      const alias = this.#pendingThumbnails.get(decoded.ackId);
      this.#pendingThumbnails.delete(decoded.ackId);
      if (!alias) return;
      const body = decoded.args[0] === null ? decoded.args[1] : decoded.args[0];
      const url = readString(asRecord(body)?.url);
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
    const url = safeImageUrl(rawUrl);
    if (!url) return;
    const response = await this.#fetchImage(url, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) return;
    const contentType = safeContentType(response.headers.get("content-type"));
    if (!contentType) return;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxBytes) return;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > this.#maxBytes) return;
    const capturedAt = this.#now().toISOString();
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

function safeImageUrl(value: string): string | undefined {
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

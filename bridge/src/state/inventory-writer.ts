import { Worker } from "node:worker_threads";
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BridgeInventory } from "./device-store.js";

export interface InventoryWriteResult {
  outcome: "persisted" | "unchanged" | "failed";
  serializeMs: number;
  writeMs: number;
  transferMs?: number;
}
export interface InventoryWriter {
  write(inventory: BridgeInventory): Promise<InventoryWriteResult>;
  close(): Promise<void>;
}

/** Private sidecar: never contend with synchronous identity/capture writes. */
export function inventoryCachePath(sqlitePath: string): string { return `${sqlitePath}.inventory`; }

/** Startup only. The caller validates the same schema as the legacy DB. */
export function readInventoryCache(path: string, identity: string): { json: string; persistedAtMs: number } | undefined {
  let db: DatabaseSync | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("inventory_cache_not_regular");
    if (stat.size === 0) return undefined;
    db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    const bound = db.prepare("SELECT identity FROM cache_identity WHERE singleton=1").get();
    if (bound?.identity !== identity) return undefined;
    const row = db.prepare("SELECT inventory_json AS json, persisted_at AS persistedAt FROM normalized_inventory WHERE schema_version=1").get();
    return typeof row?.json === "string" ? { json: row.json,
      persistedAtMs: typeof row.persistedAt === "string" ? Date.parse(row.persistedAt) || 0 : 0 } : undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("inventory_cache_read_failed");
  } finally { db?.close(); }
}

/** A single lazy worker, at most one submitted inventory. No synchronous write fallback. */
export class ThreadedInventoryWriter implements InventoryWriter {
  #worker: Worker | undefined;
  #pending: { id: number; resolve: (result: InventoryWriteResult) => void;
    timer: ReturnType<typeof setTimeout>; transferMs: number } | undefined;
  #id = 0;
  #retiring: Promise<void> = Promise.resolve();
  #inFlight: Promise<InventoryWriteResult> | undefined;
  #closed = false;
  #shutdown: Promise<void> | undefined;
  constructor(private readonly path: string, private readonly identity: string) {}

  write(inventory: BridgeInventory): Promise<InventoryWriteResult> {
    if (this.#closed || this.#pending) return Promise.reject(new Error("inventory_worker_unavailable"));
    const promise = new Promise<InventoryWriteResult>((resolve) => {
      const id = ++this.#id;
      const timer = setTimeout(() => this.#fail(), 15_000);
      timer.unref();
      this.#pending = { id, resolve, timer, transferMs: 0 };
      void this.#retiring.then(() => {
        // A timed-out thread must exit before a replacement can write. An old
        // commit may have finished despite timeout; it cannot overwrite a new one.
        if (this.#pending?.id !== id) return;
        try {
          const worker = this.#worker ?? this.#start();
          const transferStart = performance.now();
          worker.postMessage({ id, inventory });
          if (this.#pending?.id === id) this.#pending.transferMs = Math.max(0, Math.round(performance.now() - transferStart));
        } catch { this.#fail(); }
      });
    });
    this.#inFlight = promise;
    return promise;
  }

  close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closed = true;
    this.#shutdown = this.#drainAndClose();
    return this.#shutdown;
  }

  async #drainAndClose(): Promise<void> {
    await this.#inFlight;
    await this.#retiring;
    const worker = this.#worker;
    this.#worker = undefined;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void worker.terminate().then(() => resolve(), () => resolve());
      }, 5_000);
      timer.unref();
      worker.once("exit", () => { clearTimeout(timer); resolve(); });
      try { worker.postMessage({ close: true }); }
      catch { clearTimeout(timer); void worker.terminate().then(() => resolve(), () => resolve()); }
    });
  }

  #start(): Worker {
    // Native Node 24 type stripping in source tests, ordinary JS in the package.
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = new Worker(new URL(`./inventory-writer-thread.${extension}`, import.meta.url), {
      workerData: { path: this.path, identity: this.identity }, stdout: true, stderr: true
    });
    this.#worker = worker;
    worker.stdout.resume(); worker.stderr.resume();
    worker.on("message", (message: unknown) => {
      if (worker !== this.#worker || typeof message !== "object" || message === null) return;
      const value = message as Record<string, unknown>;
      if ("failure" in value) { this.#fail(); return; }
      if (value.id !== this.#pending?.id) return;
      if (!["persisted", "unchanged", "failed"].includes(String(value.outcome)) ||
          ![value.serializeMs, value.writeMs].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
        this.#fail(); return;
      }
      this.#settle(value as unknown as InventoryWriteResult);
    });
    worker.on("error", () => { if (worker === this.#worker) this.#fail(); });
    worker.on("exit", () => { if (worker === this.#worker) this.#fail(); });
    return worker;
  }

  #settle(result: InventoryWriteResult): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve({ outcome: result.outcome, serializeMs: result.serializeMs, writeMs: result.writeMs, transferMs: pending.transferMs });
  }

  #fail(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#settle({ outcome: "failed", serializeMs: 0, writeMs: 0 });
    // Keep the previous worker's exit isolated from any replacement.
    if (worker) {
      const stopped = worker.terminate().then(() => undefined, () => undefined);
      this.#retiring = Promise.all([this.#retiring, stopped]).then(() => undefined);
    }
  }
}

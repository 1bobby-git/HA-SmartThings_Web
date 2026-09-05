import type { BrowserPageLike } from "./keeper-page.js";
import { normalizeLocationArmState } from "../state/location-arm-state.js";

export interface LocationStatusSnapshot {
  locationId: string;
  armState: string;
  updatedAt: string | null;
}

/** Read only the existing authenticated Cake location service; never create a client or mutate it. */
export async function readLocationSecurityStatus(
  page: BrowserPageLike, rawLocationId: string, timeoutMs = 2_000
): Promise<LocationStatusSnapshot | undefined> {
  if (!page.evaluate || page.isClosed() || !rawLocationId) return undefined;
  try {
    const url = new URL(page.url());
    if (url.origin !== "https://my.smartthings.com" || !/^\/location(?:\/[^/]+)?\/?$/u.test(url.pathname)) return undefined;
  } catch { return undefined; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = page.evaluate(async ({ id, timeout }): Promise<LocationStatusSnapshot | undefined> => {
      const client = (window as unknown as Record<symbol, unknown>)[Symbol.for("smartthings_web_bridge.cake_client")] as
        { service?: (name: string) => { get?: (key: string) => Promise<unknown> } } | undefined;
      if (typeof client?.service !== "function") return undefined;
      const service = client.service("api/location");
      if (typeof service?.get !== "function") return undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          service.get(id),
          new Promise<undefined>((resolve) => { deadline = setTimeout(() => resolve(undefined), timeout); })
        ]);
        const record = (value: unknown): Record<string, unknown> | undefined =>
          value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
        const outer = record(response);
        const row = record(outer?.data) ?? outer;
        if (!row || (row.locationId ?? row.location_id ?? row.id) !== id) return undefined;
        const armState = row.armState ?? row.arm_state;
        if (typeof armState !== "string" || armState.length > 40) return undefined;
        const updatedAt = row.updatedAt ?? row.updated_at ?? row.timestamp;
        return { locationId: id, armState, updatedAt: typeof updatedAt === "string" ? updatedAt : null };
      } catch { return undefined; }
      finally { if (deadline) clearTimeout(deadline); }
    }, { id: rawLocationId, timeout: Math.max(1, Math.min(2_000, timeoutMs)) });
    const value = await Promise.race([work,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(1, Math.min(2_000, timeoutMs)) + 100); })]);
    return value?.locationId === rawLocationId && normalizeLocationArmState(value.armState) ? value : undefined;
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}

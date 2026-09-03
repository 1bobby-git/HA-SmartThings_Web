import type {
  AdvancedDevicePage,
  AdvancedDeviceRow,
  AdvancedEndpointCategory
} from "./types.js";

export class AdvancedParseError extends Error {
  constructor(
    readonly endpoint: AdvancedEndpointCategory,
    readonly code: string
  ) {
    super(`${endpoint}:${code}`);
    this.name = "AdvancedParseError";
  }
}

export function parseRows(endpoint: AdvancedEndpointCategory, value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw new AdvancedParseError(endpoint, "missing_rows");
  for (const key of ["items", "devices", "data", "results", "locations", "rooms"] as const) {
    if (Array.isArray(value[key])) return value[key];
  }
  throw new AdvancedParseError(endpoint, "missing_rows");
}

export function parseDevicePage(value: unknown): AdvancedDevicePage {
  const items = parseRows("devices", value).map((row): AdvancedDeviceRow => {
    if (!isRecord(row) || !safeIdentifier(row.deviceId)) {
      throw new AdvancedParseError("devices", "invalid_device_row");
    }
    const parsed: AdvancedDeviceRow = { ...row, deviceId: row.deviceId };
    if (row.locationId !== undefined) {
      if (!safeIdentifier(row.locationId)) {
        throw new AdvancedParseError("devices", "invalid_location_id");
      }
      parsed.locationId = row.locationId;
    }
    if (row.label !== undefined && typeof row.label === "string") parsed.label = row.label;
    return parsed;
  });

  const next = explicitNext(value) ?? fallbackNext(value, items.length);
  return next === undefined ? { items } : { items, next };
}

export function mergeDevicePages(pages: readonly AdvancedDevicePage[]): AdvancedDeviceRow[] {
  const merged = new Map<string, AdvancedDeviceRow>();
  for (const page of pages) {
    for (const row of page.items) merged.set(row.deviceId, row);
  }
  return [...merged.values()];
}

function explicitNext(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = firstSafePath(value.next, value.nextLink, value.nextPageLink);
  if (direct) return direct;
  const links = value.links;
  if (Array.isArray(links)) {
    for (const link of links) {
      if (!isRecord(link)) continue;
      const relation = typeof link.rel === "string" ? link.rel.toLowerCase() : "";
      if (relation === "next") {
        const path = firstSafePath(link.href, link.url);
        if (path) return path;
      }
    }
  } else if (isRecord(links)) {
    const next = links.next;
    if (isRecord(next)) return firstSafePath(next.href, next.url);
    return firstSafePath(next);
  }
  return undefined;
}

function fallbackNext(value: unknown, itemCount: number): string | undefined {
  if (!isRecord(value)) return undefined;
  const page = safeNonNegativeInteger(value.page) ?? safeNonNegativeInteger(value.pageNumber) ?? 0;
  const max = safePositiveInteger(value.max) ?? safePositiveInteger(value.pageSize) ?? 200;
  const total = safeNonNegativeInteger(value.total) ?? safeNonNegativeInteger(value.totalCount);
  const hasNext = value.hasNext === true || value.isNext === true;
  if (hasNext || (total !== undefined && (page + 1) * max < total) || itemCount >= max) {
    return `fallback:${page + 1}`;
  }
  return undefined;
}

function firstSafePath(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 2_048) continue;
    try {
      const url = new URL(value, "https://my.smartthings.com");
      if (url.origin !== "https://my.smartthings.com") continue;
      if (!url.pathname.startsWith("/advanced/cupcake-api/")) continue;
      return `${url.pathname}${url.search}`;
    } catch {
      continue;
    }
  }
  return undefined;
}

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0
    ? value
    : undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

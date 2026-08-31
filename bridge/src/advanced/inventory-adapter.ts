import {
  ADVANCED_DEVICES_FIRST_PAGE_QUERY,
  ADVANCED_DEVICES_NEXT_PAGE_QUERY,
  advancedEndpoints
} from "./endpoints.js";
import { mergeDevicePages, parseDevicePage, parseRows } from "./parsers.js";
import type {
  AdvancedParser,
  AuthenticatedAdvancedSession
} from "./authenticated-session.js";
import type {
  AdvancedDeviceRow,
  AdvancedEndpointCategory
} from "./types.js";

export interface AdvancedLocationRow extends Record<string, unknown> {
  locationId: string;
}

export interface AdvancedRoomRow extends Record<string, unknown> {
  roomId: string;
  locationId?: string;
}

export interface AdvancedDeviceInventoryResult {
  devices: AdvancedDeviceRow[];
  pageCount: number;
  fetchedAtMs: number;
}

export interface AdvancedInventorySnapshot extends AdvancedDeviceInventoryResult {
  locations: AdvancedLocationRow[];
  rooms: AdvancedRoomRow[];
}

const MAX_DEVICE_PAGES = 100;

export class AdvancedInventoryAdapter {
  readonly #now: () => number;

  constructor(
    private readonly session: AuthenticatedAdvancedSession,
    options: { now?: () => number } = {}
  ) {
    this.#now = options.now ?? Date.now;
  }

  async getInventory(): Promise<AdvancedInventorySnapshot> {
    const deviceResult = await this.getDevices();
    const locationResult = await Promise.allSettled([this.getLocations()]);
    const locations =
      locationResult[0]?.status === "fulfilled" ? locationResult[0].value : [];
    const roomResults = await Promise.allSettled(
      locations.map((location) => this.getRooms(location.locationId))
    );
    return {
      ...deviceResult,
      locations,
      rooms: roomResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      )
    };
  }

  async getDevices(): Promise<AdvancedDeviceInventoryResult> {
    const pages = [];
    const seen = new Set<string>();
    let path = advancedEndpoints.devices(ADVANCED_DEVICES_FIRST_PAGE_QUERY);
    while (pages.length < MAX_DEVICE_PAGES) {
      if (seen.has(path)) throw new Error("advanced_pagination_loop");
      seen.add(path);
      const page = await this.session.request(
        { endpoint: "devices", method: "GET", path },
        parseDevicePage
      );
      pages.push(page);
      if (!page.next) break;
      path = page.next.startsWith("fallback:")
        ? advancedEndpoints.devices(
            ADVANCED_DEVICES_NEXT_PAGE_QUERY(Number(page.next.slice("fallback:".length)))
          )
        : page.next;
    }
    if (pages.length === MAX_DEVICE_PAGES && pages.at(-1)?.next) {
      throw new Error("advanced_pagination_limit");
    }
    return {
      devices: mergeDevicePages(pages),
      pageCount: pages.length,
      fetchedAtMs: this.#now()
    };
  }

  async getLocations(): Promise<AdvancedLocationRow[]> {
    return this.getRows("locations", advancedEndpoints.locations(), (row) => {
      const locationId = firstIdentifier(row.locationId, row.id);
      return locationId ? { ...row, locationId } : undefined;
    });
  }

  async getRooms(locationId: string): Promise<AdvancedRoomRow[]> {
    return this.getRows("rooms", advancedEndpoints.rooms(locationId), (row) => {
      const roomId = firstIdentifier(row.roomId, row.id);
      if (!roomId) return undefined;
      const owner = firstIdentifier(row.locationId, row.location_id) ?? locationId;
      return { ...row, roomId, locationId: owner };
    });
  }

  getDeviceStatus(deviceId: string): Promise<unknown> {
    return this.getObject("device_status", advancedEndpoints.deviceStatus(deviceId));
  }

  getDeviceHealth(deviceId: string): Promise<unknown> {
    return this.getObject("device_health", advancedEndpoints.deviceHealth(deviceId));
  }

  getDevicePreferences(deviceId: string): Promise<unknown> {
    return this.getObject("device_preferences", advancedEndpoints.devicePreferences(deviceId));
  }

  getDeviceProfile(profileId: string): Promise<unknown> {
    return this.getObject("device_profile", advancedEndpoints.deviceProfile(profileId));
  }

  getCapabilityDefinition(capabilityId: string, version: number): Promise<unknown> {
    return this.getObject("capability", advancedEndpoints.capability(capabilityId, version));
  }

  getDeviceHistory(deviceId: string, locationId: string): Promise<unknown> {
    return this.getObject(
      "history",
      withQuery(advancedEndpoints.deviceHistory(), { deviceId, locationId })
    );
  }

  getRules(locationId: string): Promise<unknown> {
    return this.getObject("rules", withQuery(advancedEndpoints.rules(), { locationId }));
  }

  getClientRules(locationId: string): Promise<unknown> {
    return this.getObject(
      "rules",
      withQuery(advancedEndpoints.clientRules(), { locationId })
    );
  }

  getScenes(locationId: string): Promise<unknown> {
    return this.getObject("scenes", withQuery(advancedEndpoints.scenes(), { locationId }));
  }

  getHub(hubId: string): Promise<unknown> {
    return this.getObject("hub", advancedEndpoints.hub(hubId));
  }

  getHubDrivers(hubId: string): Promise<unknown> {
    return this.getObject("hub_drivers", advancedEndpoints.hubDrivers(hubId));
  }

  private getObject(endpoint: AdvancedEndpointCategory, path: string): Promise<unknown> {
    return this.session.request({ endpoint, method: "GET", path }, identity);
  }

  private async getRows<T>(
    endpoint: AdvancedEndpointCategory,
    path: string,
    parse: (row: Record<string, unknown>) => T | undefined
  ): Promise<T[]> {
    return this.session.request(
      { endpoint, method: "GET", path },
      (value) =>
        parseRows(endpoint, value).flatMap((row) => {
          if (!isRecord(row)) return [];
          const parsed = parse(row);
          return parsed === undefined ? [] : [parsed];
        })
    );
  }
}

const identity: AdvancedParser<unknown> = (value) => value;

function withQuery(path: string, values: Readonly<Record<string, string>>): string {
  const url = new URL(path, "https://my.smartthings.com");
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function firstIdentifier(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 512 &&
      !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

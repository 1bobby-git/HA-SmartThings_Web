import { normalizeLocationArmState } from "./location-arm-state.js";

export interface LocationReadState {
  locationId: string;
  armState: string;
  updatedAt: string | null;
}
export interface PreviousLocationState { armState?: string; updatedAt?: string | null }

/**
 * A missing push must not freeze a dated location forever. An undated, contrary
 * status needs two independent exact-location reads; never use the requested mode
 * or UI button text as evidence, and never manufacture an upstream timestamp.
 */
export async function verifyLocationRead(
  read: () => Promise<LocationReadState | undefined>,
  locationId: string,
  previous: PreviousLocationState | undefined
): Promise<{ observed: LocationReadState; undatedConfirmed: boolean } | undefined> {
  const first = await read();
  const valid = (value: LocationReadState | undefined): value is LocationReadState =>
    value?.locationId === locationId && normalizeLocationArmState(value.armState) !== undefined;
  if (!valid(first)) return undefined;
  if (!previous?.updatedAt || first.updatedAt ||
      normalizeLocationArmState(previous.armState) === normalizeLocationArmState(first.armState)) {
    return { observed: first, undatedConfirmed: false };
  }
  const second = await read();
  if (!valid(second) || normalizeLocationArmState(second.armState) !== normalizeLocationArmState(first.armState)) return undefined;
  return { observed: second, undatedConfirmed: second.updatedAt === null };
}

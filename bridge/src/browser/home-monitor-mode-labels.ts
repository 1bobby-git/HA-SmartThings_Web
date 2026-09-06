/** Only for an identified Home Monitor card or its associated popup, never page-wide navigation. */
export function scopedHomeMonitorModeGroups(groups: readonly (readonly string[])[]): string[][] {
  const aliases = [[], ["Arm home", "Armed home", "Armed (Home)", "Home", "Home mode", "집", "집 모드", "보안(집)"], []];
  return groups.map((group, index) => [...new Set([...group, ...(aliases[index] ?? [])])]);
}

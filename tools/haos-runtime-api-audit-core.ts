const MAX_INPUT_BYTES = 1_000_000;
const BRIDGE_PROCESS_NAMES = new Set(["MainThread", "node"]);
const BROWSER_PROCESS_NAMES = new Set(["chrome", "chromium", "chromium-browse"]);

export type RuntimeApiAuditStatus = "pass" | "fail" | "inconclusive";
export type RuntimeApiAuditFailure = "bridge_external_connection_observed";
export type RuntimeApiAuditInconclusiveReason =
  | "bridge_process_not_unique"
  | "browser_process_not_observed"
  | "bridge_listener_not_observed"
  | "browser_external_connection_not_observed"
  | "insufficient_samples";

export interface RuntimeProcessRecord {
  processId: number;
  parentProcessId: number;
  name: string;
}

export interface RuntimeProcessSelection {
  bridgeProcessId: number;
  browserProcessIds: readonly number[];
}

export interface RuntimeTcpEntry {
  inode: number;
  state: string;
  localPort: number;
  remoteScope: "unspecified" | "loopback" | "private" | "external";
}

export interface RuntimeRoleSocketCounts {
  processCount: number;
  tcpSocketCount: number;
  listeningSocketCount: number;
  establishedLoopbackCount: number;
  establishedPrivateCount: number;
  establishedExternalCount: number;
  otherTcpSocketCount: number;
}

export interface RuntimeSocketSample {
  schemaVersion: 1;
  sampledAt: string;
  status: RuntimeApiAuditStatus;
  observationScope: "process_socket_snapshot";
  bridge: RuntimeRoleSocketCounts;
  chromium: RuntimeRoleSocketCounts;
  checks: {
    bridgeHttpListenerObserved: boolean;
    bridgeExternalConnectionObserved: boolean;
    browserExternalConnectionObserved: boolean;
  };
  failures: RuntimeApiAuditFailure[];
  inconclusiveReasons: RuntimeApiAuditInconclusiveReason[];
}

export interface RuntimeApiAuditSummary {
  schemaVersion: 1;
  status: RuntimeApiAuditStatus;
  observationScope: "bounded_process_socket_sampling";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sampleCount: number;
  passingSampleCount: number;
  inconclusiveSampleCount: number;
  bridge: RuntimeRoleSocketCounts;
  chromium: RuntimeRoleSocketCounts;
  checks: {
    bridgeHttpListenerObservedEverySample: boolean;
    bridgeExternalConnectionObserved: boolean;
    browserExternalConnectionObserved: boolean;
  };
  failures: RuntimeApiAuditFailure[];
  inconclusiveReasons: RuntimeApiAuditInconclusiveReason[];
  limitations: readonly [
    "bounded_sample_not_complete_network_history",
    "destinations_and_ports_intentionally_not_retained"
  ];
}

export function haosAddonContainerName(addonSlug: string): string {
  return `app_${addonSlug}`;
}

export function parseGuestExecText(
  raw: string,
  commandFailure: string,
  responseFailure: string
): string {
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
      throw new Error(responseFailure);
    }
    const wrapper = requireRecord(JSON.parse(raw));
    if (wrapper.exitcode !== 0 || wrapper.exited !== 1) {
      throw new Error(commandFailure);
    }
    if (wrapper["out-truncated"] !== undefined && wrapper["out-truncated"] !== 0) {
      throw new Error(responseFailure);
    }
    if (
      typeof wrapper["out-data"] !== "string" ||
      Buffer.byteLength(wrapper["out-data"], "utf8") > MAX_INPUT_BYTES
    ) {
      throw new Error(responseFailure);
    }
    return wrapper["out-data"];
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === commandFailure || error.message === responseFailure)
    ) {
      throw error;
    }
    throw new Error(responseFailure);
  }
}

export function parseRuntimeProcessTable(value: string): RuntimeProcessRecord[] {
  assertBounded(value, "runtime_process_table_invalid");
  const records: RuntimeProcessRecord[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || /^PID\s+PPID\s+COMMAND$/u.test(trimmed)) {
      continue;
    }
    const parts = trimmed.split(/\s+/u);
    const processId = safePositiveInteger(parts[0]);
    const parentProcessId = safeNonNegativeInteger(parts[1]);
    const name = parts[2];
    if (!name || !/^[A-Za-z0-9_.:-]{1,64}$/u.test(name)) {
      throw new Error("runtime_process_table_invalid");
    }
    records.push({ processId, parentProcessId, name });
  }
  if (records.length === 0) {
    throw new Error("runtime_process_table_invalid");
  }
  return records;
}

export function selectRuntimeProcesses(
  processes: readonly RuntimeProcessRecord[]
): RuntimeProcessSelection | null {
  const byId = new Map(processes.map((process) => [process.processId, process]));
  const browserProcesses = processes.filter((process) => BROWSER_PROCESS_NAMES.has(process.name));
  const candidates = processes.filter(
    (process) =>
      BRIDGE_PROCESS_NAMES.has(process.name) &&
      browserProcesses.some((browser) => isDescendantOf(browser, process.processId, byId))
  );
  if (candidates.length !== 1) {
    return null;
  }
  const bridge = candidates[0];
  if (!bridge) {
    return null;
  }
  const browserProcessIds = browserProcesses
    .filter((browser) => isDescendantOf(browser, bridge.processId, byId))
    .map((browser) => browser.processId)
    .sort((left, right) => left - right);
  if (browserProcessIds.length === 0) {
    return null;
  }
  return { bridgeProcessId: bridge.processId, browserProcessIds };
}

export function parseSocketFdListings(
  value: string,
  expectedProcessIds: readonly number[]
): ReadonlyMap<number, ReadonlySet<number>> {
  assertBounded(value, "runtime_fd_listing_invalid");
  const expected = new Set(expectedProcessIds);
  const sockets = new Map<number, Set<number>>(
    expectedProcessIds.map((processId) => [processId, new Set<number>()])
  );
  let currentProcessId: number | undefined =
    expectedProcessIds.length === 1 ? expectedProcessIds[0] : undefined;

  for (const line of value.split(/\r?\n/u)) {
    const header = /^\/proc\/(\d+)\/fd:$/u.exec(line.trim());
    if (header) {
      const parsed = safePositiveInteger(header[1]);
      currentProcessId = expected.has(parsed) ? parsed : undefined;
      continue;
    }
    const socket = /->\s+socket:\[(\d+)\]\s*$/u.exec(line);
    if (!socket || currentProcessId === undefined) {
      continue;
    }
    sockets.get(currentProcessId)?.add(safePositiveInteger(socket[1]));
  }
  return sockets;
}

export function parseProcTcpTable(
  value: string,
  family: "ipv4" | "ipv6"
): RuntimeTcpEntry[] {
  assertBounded(value, "runtime_tcp_table_invalid");
  const addressLength = family === "ipv4" ? 8 : 32;
  const addressPattern = new RegExp(`^[0-9A-Fa-f]{${String(addressLength)}}:[0-9A-Fa-f]{4}$`, "u");
  const entries: RuntimeTcpEntry[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("sl")) {
      continue;
    }
    const parts = trimmed.split(/\s+/u);
    const localAddress = parts[1];
    const remoteAddress = parts[2];
    const state = parts[3];
    const inode = parts[9];
    if (
      !localAddress ||
      !remoteAddress ||
      !state ||
      !inode ||
      !addressPattern.test(localAddress) ||
      !addressPattern.test(remoteAddress) ||
      !/^[0-9A-Fa-f]{2}$/u.test(state)
    ) {
      throw new Error("runtime_tcp_table_invalid");
    }
    entries.push({
      inode: safeNonNegativeInteger(inode),
      state: state.toUpperCase(),
      localPort: Number.parseInt(localAddress.slice(-4), 16),
      remoteScope: classifyRemoteAddress(remoteAddress.slice(0, addressLength), family)
    });
  }
  return entries;
}

export function createRuntimeSocketSample(input: {
  sampledAt: string;
  selection: RuntimeProcessSelection | null;
  socketsByProcess: ReadonlyMap<number, ReadonlySet<number>>;
  tcpEntries: readonly RuntimeTcpEntry[];
}): RuntimeSocketSample {
  const sampledAt = safeTimestamp(input.sampledAt);
  const failures: RuntimeApiAuditFailure[] = [];
  const inconclusiveReasons: RuntimeApiAuditInconclusiveReason[] = [];
  if (!input.selection) {
    inconclusiveReasons.push("bridge_process_not_unique", "browser_process_not_observed");
  }
  const bridgeProcessIds = input.selection ? [input.selection.bridgeProcessId] : [];
  const browserProcessIds = input.selection ? input.selection.browserProcessIds : [];
  const bridge = countRoleSockets(bridgeProcessIds, input.socketsByProcess, input.tcpEntries);
  const chromium = countRoleSockets(browserProcessIds, input.socketsByProcess, input.tcpEntries);
  const bridgeHttpListenerObserved = roleHasListener(
    bridgeProcessIds,
    input.socketsByProcess,
    input.tcpEntries,
    8098
  );
  const bridgeExternalConnectionObserved = bridge.establishedExternalCount > 0;
  const browserExternalConnectionObserved = chromium.establishedExternalCount > 0;
  if (bridgeExternalConnectionObserved) {
    failures.push("bridge_external_connection_observed");
  }
  if (input.selection && !bridgeHttpListenerObserved) {
    inconclusiveReasons.push("bridge_listener_not_observed");
  }
  if (input.selection && !browserExternalConnectionObserved) {
    inconclusiveReasons.push("browser_external_connection_not_observed");
  }
  const status: RuntimeApiAuditStatus =
    failures.length > 0 ? "fail" : inconclusiveReasons.length > 0 ? "inconclusive" : "pass";
  return {
    schemaVersion: 1,
    sampledAt,
    status,
    observationScope: "process_socket_snapshot",
    bridge,
    chromium,
    checks: {
      bridgeHttpListenerObserved,
      bridgeExternalConnectionObserved,
      browserExternalConnectionObserved
    },
    failures,
    inconclusiveReasons
  };
}

export function summarizeRuntimeApiAudit(
  samples: readonly RuntimeSocketSample[],
  startedAt: string,
  endedAt: string
): RuntimeApiAuditSummary {
  const safeStartedAt = safeTimestamp(startedAt);
  const safeEndedAt = safeTimestamp(endedAt);
  const durationMs = Date.parse(safeEndedAt) - Date.parse(safeStartedAt);
  if (durationMs < 0) {
    throw new Error("runtime_audit_timestamp_order");
  }
  const failures = unique(samples.flatMap((sample) => sample.failures));
  const bridgeExternalConnectionObserved = samples.some(
    (sample) => sample.checks.bridgeExternalConnectionObserved
  );
  const browserExternalConnectionObserved = samples.some(
    (sample) => sample.checks.browserExternalConnectionObserved
  );
  const bridgeHttpListenerObservedEverySample =
    samples.length > 0 && samples.every((sample) => sample.checks.bridgeHttpListenerObserved);
  const inconclusiveReasons = new Set<RuntimeApiAuditInconclusiveReason>();
  if (samples.length < 2) {
    inconclusiveReasons.add("insufficient_samples");
  }
  for (const sample of samples) {
    for (const reason of sample.inconclusiveReasons) {
      inconclusiveReasons.add(reason);
    }
  }
  if (!browserExternalConnectionObserved) {
    inconclusiveReasons.add("browser_external_connection_not_observed");
  }
  if (!bridgeHttpListenerObservedEverySample) {
    inconclusiveReasons.add("bridge_listener_not_observed");
  }
  const status: RuntimeApiAuditStatus =
    failures.length > 0
      ? "fail"
      : inconclusiveReasons.size > 0
        ? "inconclusive"
        : "pass";
  return {
    schemaVersion: 1,
    status,
    observationScope: "bounded_process_socket_sampling",
    startedAt: safeStartedAt,
    endedAt: safeEndedAt,
    durationMs,
    sampleCount: samples.length,
    passingSampleCount: samples.filter((sample) => sample.status === "pass").length,
    inconclusiveSampleCount: samples.filter((sample) => sample.status === "inconclusive").length,
    bridge: maximumRoleCounts(samples.map((sample) => sample.bridge)),
    chromium: maximumRoleCounts(samples.map((sample) => sample.chromium)),
    checks: {
      bridgeHttpListenerObservedEverySample,
      bridgeExternalConnectionObserved,
      browserExternalConnectionObserved
    },
    failures,
    inconclusiveReasons: [...inconclusiveReasons],
    limitations: [
      "bounded_sample_not_complete_network_history",
      "destinations_and_ports_intentionally_not_retained"
    ]
  };
}

function countRoleSockets(
  processIds: readonly number[],
  socketsByProcess: ReadonlyMap<number, ReadonlySet<number>>,
  tcpEntries: readonly RuntimeTcpEntry[]
): RuntimeRoleSocketCounts {
  const inodes = new Set<number>();
  for (const processId of processIds) {
    for (const inode of socketsByProcess.get(processId) ?? []) {
      inodes.add(inode);
    }
  }
  const entries = uniqueEntries(tcpEntries.filter((entry) => inodes.has(entry.inode)));
  const listeningSocketCount = entries.filter((entry) => entry.state === "0A").length;
  const established = entries.filter((entry) => entry.state === "01");
  const counted =
    listeningSocketCount +
    established.filter((entry) => entry.remoteScope === "loopback").length +
    established.filter((entry) => entry.remoteScope === "private").length +
    established.filter((entry) => entry.remoteScope === "external").length;
  return {
    processCount: processIds.length,
    tcpSocketCount: entries.length,
    listeningSocketCount,
    establishedLoopbackCount: established.filter((entry) => entry.remoteScope === "loopback").length,
    establishedPrivateCount: established.filter((entry) => entry.remoteScope === "private").length,
    establishedExternalCount: established.filter((entry) => entry.remoteScope === "external").length,
    otherTcpSocketCount: entries.length - counted
  };
}

function roleHasListener(
  processIds: readonly number[],
  socketsByProcess: ReadonlyMap<number, ReadonlySet<number>>,
  tcpEntries: readonly RuntimeTcpEntry[],
  port: number
): boolean {
  const inodes = new Set<number>();
  for (const processId of processIds) {
    for (const inode of socketsByProcess.get(processId) ?? []) {
      inodes.add(inode);
    }
  }
  return tcpEntries.some(
    (entry) => inodes.has(entry.inode) && entry.state === "0A" && entry.localPort === port
  );
}

function maximumRoleCounts(values: readonly RuntimeRoleSocketCounts[]): RuntimeRoleSocketCounts {
  const keys: Array<keyof RuntimeRoleSocketCounts> = [
    "processCount",
    "tcpSocketCount",
    "listeningSocketCount",
    "establishedLoopbackCount",
    "establishedPrivateCount",
    "establishedExternalCount",
    "otherTcpSocketCount"
  ];
  const result = Object.fromEntries(
    keys.map((key) => [key, Math.max(0, ...values.map((value) => value[key]))])
  );
  return result as unknown as RuntimeRoleSocketCounts;
}

function classifyRemoteAddress(
  value: string,
  family: "ipv4" | "ipv6"
): RuntimeTcpEntry["remoteScope"] {
  const bytes = family === "ipv4" ? decodeIpv4(value) : decodeIpv6(value);
  if (bytes.every((byte) => byte === 0)) {
    return "unspecified";
  }
  if (family === "ipv4") {
    return classifyIpv4(bytes);
  }
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return "loopback";
  }
  if (bytes[0] !== undefined && (bytes[0] & 0xfe) === 0xfc) {
    return "private";
  }
  if (bytes[0] === 0xfe && bytes[1] !== undefined && (bytes[1] & 0xc0) === 0x80) {
    return "private";
  }
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return ipv4Mapped ? classifyIpv4(bytes.slice(12)) : "external";
}

function classifyIpv4(bytes: readonly number[]): RuntimeTcpEntry["remoteScope"] {
  const first = bytes[0];
  const second = bytes[1];
  if (first === 127) {
    return "loopback";
  }
  if (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127)
  ) {
    return "private";
  }
  return "external";
}

function decodeIpv4(value: string): number[] {
  return hexBytes(value).reverse();
}

function decodeIpv6(value: string): number[] {
  const bytes = hexBytes(value);
  const result: number[] = [];
  for (let index = 0; index < bytes.length; index += 4) {
    result.push(...bytes.slice(index, index + 4).reverse());
  }
  return result;
}

function hexBytes(value: string): number[] {
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 2) {
    result.push(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return result;
}

function isDescendantOf(
  process: RuntimeProcessRecord,
  ancestorProcessId: number,
  byId: ReadonlyMap<number, RuntimeProcessRecord>
): boolean {
  const visited = new Set<number>();
  let current: RuntimeProcessRecord | undefined = process;
  while (current && !visited.has(current.processId)) {
    if (current.parentProcessId === ancestorProcessId) {
      return true;
    }
    visited.add(current.processId);
    current = byId.get(current.parentProcessId);
  }
  return false;
}

function uniqueEntries(entries: readonly RuntimeTcpEntry[]): RuntimeTcpEntry[] {
  return [...new Map(entries.map((entry) => [entry.inode, entry])).values()];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function safeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("runtime_audit_timestamp_invalid");
  }
  return value;
}

function safePositiveInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("runtime_numeric_field_invalid");
  }
  return parsed;
}

function safeNonNegativeInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("runtime_numeric_field_invalid");
  }
  return parsed;
}

function assertBounded(value: string, code: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(code);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

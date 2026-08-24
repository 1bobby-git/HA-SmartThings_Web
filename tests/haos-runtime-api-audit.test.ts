import { describe, expect, test } from "vitest";

import {
  createRuntimeSocketSample,
  haosAddonContainerName,
  parseGuestExecText,
  parseProcTcpTable,
  parseRuntimeProcessTable,
  parseSocketFdListings,
  selectRuntimeProcesses,
  summarizeRuntimeApiAudit
} from "../tools/haos-runtime-api-audit-core.js";

const processTable = `PID PPID COMMAND
100 1 MainThread
101 100 chrome
102 101 chrome
103 1 chrome_crashpad
`;

describe("HAOS runtime API-free audit", () => {
  test("maps a Supervisor add-on slug to its Docker container name", () => {
    expect(haosAddonContainerName("local_smartthings_web_bridge")).toBe(
      "app_local_smartthings_web_bridge"
    );
  });

  test("separates the Bridge from its Chromium descendants", () => {
    const processes = parseRuntimeProcessTable(processTable);
    expect(selectRuntimeProcesses(processes)).toEqual({
      bridgeProcessId: 100,
      browserProcessIds: [101, 102]
    });
  });

  test("passes when only Chromium owns an external connection", () => {
    const sample = healthySample("2026-08-24T10:00:00.000Z");

    expect(sample.status).toBe("pass");
    expect(sample.bridge).toMatchObject({
      processCount: 1,
      listeningSocketCount: 1,
      establishedLoopbackCount: 1,
      establishedExternalCount: 0
    });
    expect(sample.chromium).toMatchObject({
      processCount: 2,
      establishedExternalCount: 1
    });
    expect(sample.checks).toEqual({
      bridgeHttpListenerObserved: true,
      bridgeExternalConnectionObserved: false,
      browserExternalConnectionObserved: true
    });

    const serialized = JSON.stringify(sample);
    expect(serialized).not.toMatch(
      /8\.8\.8\.8|08080808|\b(?:100|101|102|1000|1001|2000|8098|443)\b|processId|inode|localPort/u
    );
  });

  test("fails closed when the Bridge owns any external established socket", () => {
    const selection = selectRuntimeProcesses(parseRuntimeProcessTable(processTable));
    const sockets = parseSocketFdListings(
      fdListings().replace(
        "lrwx------ 1 1001 1001 64 Aug 24 10:00 24 -> socket:[1001]\n",
        "lrwx------ 1 1001 1001 64 Aug 24 10:00 24 -> socket:[1001]\n" +
          "lrwx------ 1 1001 1001 64 Aug 24 10:00 25 -> socket:[3000]\n"
      ),
      [100, 101, 102]
    );
    const tcpEntries = parseProcTcpTable(
      `${tcpTable()}${tcpRow(3, "0100007F:CAFE", "08080808:01BB", "01", 3000)}\n`,
      "ipv4"
    );
    const sample = createRuntimeSocketSample({
      sampledAt: "2026-08-24T10:00:00.000Z",
      selection,
      socketsByProcess: sockets,
      tcpEntries
    });

    expect(sample.status).toBe("fail");
    expect(sample.failures).toEqual(["bridge_external_connection_observed"]);
    expect(sample.bridge.establishedExternalCount).toBe(1);
  });

  test("requires repeated samples and preserves the bounded-evidence limitation", () => {
    const first = healthySample("2026-08-24T10:00:00.000Z");
    const second = healthySample("2026-08-24T10:00:05.000Z");

    const complete = summarizeRuntimeApiAudit(
      [first, second],
      "2026-08-24T10:00:00.000Z",
      "2026-08-24T10:00:05.000Z"
    );
    expect(complete.status).toBe("pass");
    expect(complete.sampleCount).toBe(2);
    expect(complete.checks).toEqual({
      bridgeHttpListenerObservedEverySample: true,
      bridgeExternalConnectionObserved: false,
      browserExternalConnectionObserved: true
    });
    expect(complete.limitations).toContain("bounded_sample_not_complete_network_history");

    const single = summarizeRuntimeApiAudit(
      [first],
      "2026-08-24T10:00:00.000Z",
      "2026-08-24T10:00:00.000Z"
    );
    expect(single.status).toBe("inconclusive");
    expect(single.inconclusiveReasons).toContain("insufficient_samples");
  });

  test("does not expose rejected guest output", () => {
    const secret = "Bearer raw-secret-token";
    expect(() =>
      parseGuestExecText(
        JSON.stringify({ exitcode: 1, exited: 1, "out-data": secret }),
        "runtime_command_failed",
        "runtime_response_invalid"
      )
    ).toThrowError("runtime_command_failed");
    expect(() =>
      parseGuestExecText(
        JSON.stringify({ exitcode: 0, exited: 1, "out-data": { secret } }),
        "runtime_command_failed",
        "runtime_response_invalid"
      )
    ).toThrowError("runtime_response_invalid");
  });

  test("rejects malformed process and TCP tables", () => {
    expect(() => parseRuntimeProcessTable("PID PPID COMMAND\nraw secret value\n")).toThrow();
    expect(() => parseProcTcpTable("0: raw raw 01", "ipv4")).toThrowError(
      "runtime_tcp_table_invalid"
    );
  });
});

function healthySample(sampledAt: string) {
  const selection = selectRuntimeProcesses(parseRuntimeProcessTable(processTable));
  const sockets = parseSocketFdListings(fdListings(), [100, 101, 102]);
  const tcpEntries = parseProcTcpTable(tcpTable(), "ipv4");
  return createRuntimeSocketSample({ sampledAt, selection, socketsByProcess: sockets, tcpEntries });
}

function fdListings(): string {
  return `/proc/100/fd:
total 0
lrwx------ 1 1001 1001 64 Aug 24 10:00 23 -> socket:[1000]
lrwx------ 1 1001 1001 64 Aug 24 10:00 24 -> socket:[1001]

/proc/101/fd:
total 0
lrwx------ 1 1001 1001 64 Aug 24 10:00 10 -> socket:[2000]

/proc/102/fd:
total 0
lrwx------ 1 1001 1001 64 Aug 24 10:00 11 -> socket:[2000]
`;
}

function tcpTable(): string {
  return `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode
${tcpRow(0, "00000000:1FA2", "00000000:0000", "0A", 1000)}
${tcpRow(1, "0100007F:1FA2", "0100007F:C350", "01", 1001)}
${tcpRow(2, "0100007F:C350", "08080808:01BB", "01", 2000)}
`;
}

function tcpRow(
  index: number,
  localAddress: string,
  remoteAddress: string,
  state: string,
  inode: number
): string {
  return `${String(index)}: ${localAddress} ${remoteAddress} ${state} 00000000:00000000 00:00000000 00000000 1001 0 ${String(inode)} 1 0000000000000000 100 0 0 10 0`;
}

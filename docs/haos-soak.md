# HAOS Passive Soak

The Phase 1 durability gate uses an external, read-only collector. It does not click the SmartThings UI, change a device, restart Home Assistant, or issue a SmartThings request from the bridge.

## Default run

From the repository root:

```powershell
$soakOutput = Join-Path $env:LOCALAPPDATA "HA-SmartThings-Web\soak\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
npm run soak:haos -- --duration-hours 72 --interval-seconds 300 --output-dir $soakOutput
```

The defaults target the current HAOS validation environment through the existing `pve-new-ts` SSH host, VM `100`, and installed app slug `local_smartthings_web_bridge`. Override them only for another controlled environment with `--ssh-target`, `--vm-id`, and `--addon-slug`.

The output directory must resolve outside this Git repository. The collector refuses an in-repository path, uses SSH batch mode with a bounded timeout, and never persists SSH stdout, stderr, the complete Supervisor app record, an Ingress path, or a browser/network capture.

## Stored evidence

`samples.jsonl` contains only an explicit allowlist:

- sample timestamp;
- live, ready, runtime state, safe URL category, and aggregate connection/device counts;
- decoded, unique, duplicate, dedupe-journal, invalid-frame, protocol-change, and restart counts;
- bridge, browser, and protocol versions;
- heartbeat/snapshot/frame/event/parser/push ages and browser uptime;
- CPU, memory, network-byte, and block-I/O aggregates from Supervisor stats.

`status.json` is the latest automatic evaluation. `run.json` contains timing and the `allowlisted_aggregates_only` output policy. On completion, `final-summary.json` and its SHA-256 sidecar are written. A future repository fixture may contain only the reviewed final aggregate and hash, never the external JSONL stream.

## Verdict rules

The run fails if any sample:

- is not live, ready, and `CONNECTED`;
- contains a protocol change, a nonzero restart count, or a browser-uptime rollback that proves a successful browser/context restart;
- raises the invalid-frame count above the first sample;
- regresses decoded, unique, or duplicate event counters;
- is missing for more than twice the configured interval;
- records a sanitized collection error; or
- shows sustained first-window to last-window memory growth above 256 MiB by default.

Equal event counters are allowed during a passive idle period but produce `event_counters_flat` as a warning. The status remains `pending` until a sample reaches the configured end time. Only a complete run with no failures becomes `pass`.

This test proves passive long-idle durability only. Host reboot, network interruption, physical-action correlation, browser command feasibility, and complete API independence remain separate Phase 1 gates.

# Advanced Command Service and Global Web Parity Design

**Date:** 2026-09-01
**Status:** Approved in conversation; pending implementation plan

## Purpose

Make every `smartthings_web` device reflect the safe functionality and visible metadata exposed by the authenticated SmartThings Web surfaces. Advanced commands are exposed through Home Assistant services instead of producing one entity per command. Common reversible capabilities remain native Home Assistant entities.

The reported Galaxy Home Mini, refrigerator, rattan light, multi-outlet, and Mood Light defects are acceptance examples, not device-specific patches. The implementation must apply the same rules to the complete current and future Bridge inventory.

## Current Evidence

- Galaxy Home Mini (`dev_204`) is correctly classified as `media_player`, but its Bridge inventory contains only Refresh while SmartThings Advanced shows 51 commands. `speechSynthesis.speak` has one text argument named `phrase`.
- Rattan light (`dev_324`) and Mood Light (`dev_662`) have online `switch` state and light presentation/state evidence, but only Refresh is present in their Bridge controls. The exact-toggle requirement therefore prevents `light` or `switch` creation.
- Multi-outlet (`dev_191`) has two independent safe toggles on the same main component. Their control labels are Power and `yjswitchstatus`, but the switch platform discards labels for `switch` attributes, so both entities inherit the device name.
- Refrigerator (`dev_392`) has refrigerator presentation artwork and type metadata but no primary device entity. Its state entities intentionally do not receive device artwork, leaving no refrigerator-specific visual on generic sensors.
- Home Assistant cannot set the glyph of a Device Registry row through `DeviceInfo`. The integration can control entity icons and entity pictures only.

## Goals

1. Provide capability-aware `list_commands`, `execute_command`, and `speak` services.
2. Project all safe, reversible Web/Advanced controls into native HA entities.
3. Apply Web labels, component roles, presentation types, and icons consistently across every device.
4. Preserve existing entity IDs and user names while repairing generated names and adding missing entities.
5. Keep command completion grounded in accepted receipts, newer push events, or bounded Advanced status evidence.
6. Produce an inventory-wide parity audit with explicit reasons for every omitted write feature.

## Non-goals

- Do not use the official SmartThings API, PAT, OAuth, SmartApp, webhook, cookie replay, or stored browser credentials.
- Do not treat DOM text or animation as device state authority.
- Do not create one HA entity for every Advanced command.
- Do not expose lock, door, garage, valve, security-disarm, low-level OCF, or network/group reconfiguration commands.
- Do not rename user-customized entities or take ownership of entities from another integration.

## Architecture

### 1. Advanced Command Catalog

Add a focused Bridge command-catalog module. For each device it consumes the normalized component/capability/version inventory and lazily resolves capability definitions through the existing `CapabilityDefinitionCache`.

Each safe catalog entry contains:

```text
device alias
component alias and role
capability alias and version
command
argument descriptors: name, required, type, enum, minimum, maximum, unit
execution transport
confirmation mode
display label and label source
```

Raw SmartThings device/component/capability identifiers remain in the existing volatile browser-session map. Persisted inventory and HA payloads contain aliases and safe presentation metadata only. Sensitive argument definitions and dangerous commands are excluded before the catalog leaves the Bridge.

Capability definitions are loaded with bounded concurrency, cached by capability/version, and deduplicated across devices. A failed definition lookup does not remove pushed state; it records a catalog omission reason.

Location detail observation records the rendered control label as presentation metadata alongside the raw developer label. This is allowed for naming and control targeting only; it is never accepted as device state. Advanced-only commands use the capability display metadata when available and otherwise fall through to the localized role/fallback rules.

### 2. Control Projection

Normalize Location-native and Advanced controls into one control contract with an explicit transport:

- `location_native`: an exact observed Web action exists.
- `advanced`: no exact Location action exists, but the device advertises an exact safe command with a validated capability version and schema.

For a safe state-backed switch, an Advanced `on` and `off` pair is sufficient to create an Advanced reversible toggle. Light-specific state evidence then projects that toggle as `light`; otherwise it becomes `switch`. Existing richer-domain ownership for fan, media, cover, and climate remains unchanged.

An Advanced-only control never falls back to DOM. Composite devices with verified child routing retain their existing Location-native child transaction and Advanced status confirmation path.

### 3. Home Assistant Services

Register three services:

#### `smartthings_web.list_commands`

Input:

- HA Device Registry ID or Bridge `dev_N` alias
- optional component/capability filters

Response:

- safe catalog entries with argument schemas
- omitted-command counts grouped by reason

#### `smartthings_web.execute_command`

Input:

- HA Device Registry ID or Bridge alias
- component
- capability
- command
- ordered arguments
- optional confirmation and timeout

The HA side resolves Device Registry IDs through the `smartthings_web` identifier and forwards aliases only. The Bridge requires an exact catalog match and validates every argument against the cached capability definition before dispatch.

#### `smartthings_web.speak`

Input:

- target HA device
- `phrase`, length 1 through 1,024 characters, with control characters rejected

The service selects exactly one safe `speechSynthesis.speak` descriptor and calls the generic execution path. It fails if the device exposes no unique matching descriptor.

### 4. Execution and Confirmation

Routing is deterministic:

```text
exact Location-native action
  else exact validated Advanced descriptor
  else unsupported_command
```

Stateful commands require a newer matching push or bounded Advanced status recheck. Stateless commands such as `speak` and Refresh complete from a validated `ACCEPTED` receipt. An HTTP success without a valid receipt is not success.

Advanced 404/unsupported results are cached only for the exact device/capability/command tuple. Authentication failure creates the existing Samsung-login repair. Transient request failures retry at most twice. Permission, invalid-argument, and offline responses fail immediately.

### 5. Global Entity Naming

Naming priority for generated entities is:

1. Visible Web control label.
2. Safe localized label derived from a known Web label/capability role.
3. Advanced component role.
4. Existing deterministic fallback.

A device with one primary toggle continues to use the device name. Multiple toggles, including multiple capabilities on the same component, receive distinct control names. For the reported multi-outlet this produces `전원` and `장치 상태`.

Registry migration updates `original_name` and generated suggestions only. It preserves `entity_id`, explicit user names, disabled state, area assignment, and foreign ownership.

### 6. Global Entity Icons

- Primary controls retain allowlisted SmartThings artwork and mapped device icons.
- Entities with HA device classes keep their functional icons.
- Generic sensors without a device class receive the mapped device-type icon, such as `mdi:fridge` for refrigerator data.
- Refresh keeps `mdi:refresh` and remains a settings entity.
- No synthetic summary sensor is created solely to carry an icon.

### 7. Inventory-wide Parity Audit

Add a read-only audit that evaluates every current inventory device and reports:

- state-backed safe write features
- Location-native controls
- Advanced-only controls
- projected HA entities
- safe service commands
- omissions grouped by missing schema, ambiguous mapping, unsafe command, unsupported transport, offline state, or missing confirmation evidence
- duplicate labels, duplicate unique IDs, and dangerous command exposure

The audit must use normalized aliases and counts. It must not print raw identifiers, secrets, cookies, command phrases, or full device payloads.

## Registry and Runtime Migration

The first ready inventory after upgrade performs an additive migration:

1. Build the complete command catalog and normalized control list.
2. Discover newly eligible entities.
3. Repair generated original names and icon metadata.
4. Preserve existing IDs and all user overrides.
5. Mark only current `smartthings_web` entities that are absent from the complete ready inventory as stale.

Cached inventory during login or reconnect gaps cannot delete or rename entities. Official `smartthings` and all other integrations remain untouched.

## Safety Policy

The catalog and executor both reject dangerous semantics. Matching includes command, capability, attribute, component role, control label, option command, and argument names. Rejection applies even when Advanced advertises the command.

Blocked families include:

- lock/unlock and access control
- door/garage/valve movement
- security disarm or alarm-state weakening
- low-level OCF payload commands
- network audio group membership, master, channel, role, and topology changes
- commands with sensitive arguments

Safe speaker playback, volume, input, TTS, reversible ordinary power, lighting, fan, cover, climate, number, select, and stateless refresh commands remain eligible when their schemas and confirmation paths are exact.

## Verification Strategy

### Automated tests

- Command-catalog parsing, cache reuse, schema validation, filtering, and omission reasons.
- Service Device Registry resolution, response payloads, arguments, and error mapping.
- Advanced-only reversible toggle projection into switch/light.
- No Advanced/DOM regression for composite child transactions.
- Same-component multiple-toggle naming and user-override preservation.
- Device-class icon preservation and generic device-type icon fallback.
- Inventory-wide audit invariants: zero dangerous exposure, duplicate unique IDs, and unexplained safe-feature omissions.
- Full Vitest and Python suites, typecheck, build, packaging, secret audit, API-free audit, and fixture audit.

### Live HAOS acceptance

- Galaxy Home Mini: catalog lists `speechSynthesis.speak(phrase)` and a harmless test phrase is audibly accepted through `smartthings_web.speak`.
- Rattan light and Mood Light: missing light entities appear; on then off is confirmed and final state matches the initial state.
- Multi-outlet: two existing entity IDs remain, generated names become `전원` and `장치 상태`, and each reversible channel is verified independently.
- Refrigerator: functional sensor icons remain; generic refrigerator sensors show `mdi:fridge`.
- Full inventory parity audit runs before and after deployment with no dangerous command exposure and no unexplained safe feature omissions.
- Bridge returns `CONNECTED` and ready after add-on restart and Home Assistant Core restart.
- Existing composite bathroom control, offline classification, realtime sensors, and registry ownership checks remain green.

## Release and Rollback

Release as the next version after `0.1.153` only after independent architecture and code review. Create a predeployment backup of add-on source, integration source, registry files, and Bridge SQLite. Publish add-on and integration assets from the exact release commit and verify asset and package-manifest hashes.

Rollback restores the previous sources and registry/database backup. All live command probes are reversible and restore their initial state. No dangerous-device probe is permitted.

## Acceptance Criteria

The work is complete only when:

1. The three command services are available and capability/schema validated.
2. Galaxy TTS works through the service on the real device.
3. Every safe reversible Web/Advanced capability is either represented by a native HA entity or has an explicit audited omission reason.
4. Generated labels and generic icons follow the same rules for every device, not a hard-coded device list.
5. The reported example devices pass while an inventory-wide audit confirms the global contract.
6. Tests, reviews, release, HAOS deployment, restart continuity, and final-state restoration all pass with fresh evidence.

"""Apply reviewed 1.8.8 edits to exact candidate source, before normal PR CI.

No HA installation, account, credentials, or live devices are accessed. All input
and output file hashes are validated before any source is written.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

PATCHES = json.loads(r'''
{
  ".github/workflows/candidate-source.yml": {
    "before": "f70f08c0e53de5d0f6080c00f0166b1c23a3e92ac8eb67217277b22e9aa2d937",
    "after": null,
    "edits": []
  },
  ".github/workflows/validate.yml": {
    "before": "b0ce2952d285a6e159103ccf0189d3c6d22d273b912864301f8ec39e7cb4a8df",
    "after": "2c895c443f61d71bf84dea0b0eef9be5bdc8e36a027c706abc8ad93411ada133",
    "edits": [[40,40,"          node tools/home-monitor-selector-regression.mjs\n"]]
  },
  "CHANGELOG.md": {
    "before": "1e6aefcdbe6b653327288025e43e16f83cadb76f08e6b0a42fc1ac9573ca901d",
    "after": "5b514d14f25f7a9d204b7b9fc6da7d92566c789143fc381693c375a22ccce8c1",
    "edits": [[5,5,"\n## 1.8.8\n\n- Home Monitor의 현재 모드 선택기를 해당 카드 안에서만 찾고 같은 버튼의 중복 문구를 병합합니다. 서로 다른 버튼, 비활성 제어, 다른 팝업은 계속 차단합니다.\n- 선택기가 확인되면 숨겨진 직접 모드 버튼을 기다리던 반복 탐색을 건너뜁니다. 기존 직접 버튼 클릭, 실제 보안 상태 확인, 제어 탭 유지 및 대기열 제한은 유지합니다.\n- 기존 HA 영역을 Unicode·공백 정규화로 재사용하고, 방 정보가 늦게 도착한 미지정 기기에 영역을 연결합니다. 사용자 지정 영역·엔티티 식별자는 덮어쓰지 않습니다.\n- 일부 Web 기기 응답에서 roomId가 생략돼도 기존 방 정보를 보존합니다. 명시적 null 또는 다른 위치로 이동한 경우에는 이전 방 연결을 유지하지 않습니다.\n- controlId가 지정된 개별 스위치 요청을 여러 채널의 일괄 동작으로 확대하지 않습니다. 기존 명시적 일괄 요청, 제어 허용 검사와 상태 확인은 유지합니다.\n- 로컬 및 CI 회귀 검증과 실제 Samsung 계정/HA 기기 검증은 구분합니다. 실제 제어 성공률·서버 지연 개선은 사용 환경에서 별도 확인이 필요합니다.\n\n"]]
  },
  "README.md": {
    "before": "29cf558f45ec30f3f5dff1be1a118b66098a99b214a98abcbd8087288b0886e3",
    "after": "a73e5984c89e49f1537aee3a3751ef9399151787012a020ffe093fccfa933451",
    "edits": [[353,354,"## 1.8.7 초기 통합 배포 기록\n"],[355,356,"최초 1.8.7 배포는 Home Assistant 통합만 업데이트했습니다. 해당 최초 배포에서 브리지 앱과 Node 패키지는 1.8.6을 유지했습니다. 함께 첨부한 smartthings-web-bridge-1.8.6.tgz는 이전 릴리스와 SHA-256이 동일한 파일이며 재빌드하거나 업데이트한 앱이 아닙니다. HACS 통합 업데이트를 위해 브리지를 재설치할 필요는 없습니다. 브리지 1.8.7의 후속 변경은 `bridge-v1.8.7`에 반영됐습니다.\n\n## 유지보수 업데이트 1.8.8\n\nHome Monitor 선택기 탐색, 지연된 방 정보의 HA 영역 연결, 개별 스위치 채널 제어를 보완했습니다. Bridge 앱과 HA 통합을 모두 1.8.8로 업데이트합니다. 기존 로그인과 엔티티 ID는 유지하며 실환경 동작·지연은 별도 확인이 필요합니다. [변경 내용 및 검증 범위](docs/release-1.8.8.md)를 참고하세요.\n"]]
  },
  "addon/smartthings_web_bridge/CHANGELOG.md": {
    "before": "9c716c1a98332f00625825f1fe901ddf10ba4f9b30af224afd9a331c0608a770",
    "after": "6f66ae29ef1f07190c551ddb74dbbff6e348535e7fe708765a74eb14bf30c795",
    "edits": [[0,0,"## 1.8.8\n\n- Home Monitor의 현재 모드 선택기를 해당 카드 안에서만 찾고 같은 버튼의 중복 문구를 병합합니다. 서로 다른 버튼, 비활성 제어, 다른 팝업은 계속 차단합니다.\n- 선택기가 확인되면 숨겨진 직접 모드 버튼을 기다리던 반복 탐색을 건너뜁니다. 기존 직접 버튼 클릭, 실제 보안 상태 확인, 제어 탭 유지 및 대기열 제한은 유지합니다.\n- 기존 HA 영역을 Unicode·공백 정규화로 재사용하고, 방 정보가 늦게 도착한 미지정 기기에 영역을 연결합니다. 사용자 지정 영역·엔티티 식별자는 덮어쓰지 않습니다.\n- 일부 Web 기기 응답에서 roomId가 생략돼도 기존 방 정보를 보존합니다. 명시적 null 또는 다른 위치로 이동한 경우에는 이전 방 연결을 유지하지 않습니다.\n- controlId가 지정된 개별 스위치 요청을 여러 채널의 일괄 동작으로 확대하지 않습니다. 기존 명시적 일괄 요청, 제어 허용 검사와 상태 확인은 유지합니다.\n- 로컬 및 CI 회귀 검증과 실제 Samsung 계정/HA 기기 검증은 구분합니다. 실제 제어 성공률·서버 지연 개선은 사용 환경에서 별도 확인이 필요합니다.\n\n"]]
  },
  "addon/smartthings_web_bridge/config.yaml": {
    "before": "d22a6c02b8fc0e34cf86a78e6f292321deb2c8d5c63550ab48b39716f7794828",
    "after": "3ad0251080e002a49cca981534e9ea42295d942581db325ca18f4f70a7d97e18",
    "edits": [[3,4,"version: 1.8.8\n"]]
  },
  "bridge/src/browser/command-page.ts": {
    "before": "82d55fe7578717c49452b9073c9a8771066dafb1f904de210e88c25704725a3a",
    "after": "2ac4286497ea360631aab423172a26af38af6a32534628cfae6a3980f1adbeba",
    "edits": [[668,669,"          budget(5_000), this.#onHomeMonitorCardDiagnostic, true\n"],[681,700,"        let action: CommandLocatorLike | undefined;\n        let textResult: Awaited<ReturnType<typeof clickRequestedText>>;\n        // An observed selector is ready: do not repeat action lookups for a hidden mode.\n        if (dashboardResult !== \"selector\") {\n          action = await findHomeMonitorCardAction(\n            page,\n            monitorName,\n            monitorLabels,\n            actionName,\n            budget(1_000)\n          );\n          if (action) {\n            await action.click({ timeout: budget(3_000) });\n            return;\n          }\n          textResult = await clickRequestedText(budget(600));\n          if (textResult === \"clicked\") return;\n          if (textResult === \"ambiguous\") throw new Error(\"command_control_ambiguous\");\n          if (await clickHomeMonitorCardActionByText(page, monitorLabels, actionLabels)) return;\n          action = await findLocationActionControl(page, actionName, budget(250));\n          if (action) {\n            await action.click({ timeout: budget(3_000) });\n            return;\n          }\n"],[711,711,"        }\n        if (currentModeResult === \"blocked\") {\n          throw new Error(\"command_control_not_found\");\n"]]
  },
  "bridge/src/browser/home-monitor-card.ts": {
    "before": "63bb2dc2fac06599ff3b2d3a44eebdbb29edae834c5a89311e586c1e22e3f80e",
    "after": "9782348b503c0b7ec926e87f74c9bc09ea99816fc2cbaac83f25d73704be5ee5",
    "edits": [[1,1,"import { hasHomeMonitorSelector } from \"./home-monitor-selector.js\";\n"],[180,182,"  onDiagnostic?: (value: HomeMonitorCardDiagnostics) => void,\n  stopForSelector = false\n): Promise<\"clicked\" | \"not_found\" | \"ambiguous\" | \"unavailable\" | \"blocked\" | \"dialog\" | \"selector\"> {\n"],[209,209,"      if (stopForSelector && last.kind === \"missing\" &&\n          await hasHomeMonitorSelector(page, monitorLabels, modeLabelGroups)) {\n        report(\"selector_available\");\n        return \"selector\";\n      }\n"]]
  },
  "bridge/src/browser/home-monitor-dom.ts": {
    "before": "0b5e1345e62666b8bbf7729778829f9dd1c81ff6a1587c8acf2e829b995842e3",
    "after": "71aaf4caf2c6db002efa617c0e4812445a66f676240d234a16cd035550f7eb38",
    "edits": [[1,1,"import { clickScopedHomeMonitorSelector } from \"./home-monitor-selector.js\";\n"],[6,7,"  | \"unavailable\"\n  | \"blocked\";\n"],[235,236," * text is resolved inside that card only and clicked with a trusted pointer.\n"],[243,377,"  return clickScopedHomeMonitorSelector(page, monitorLabels, modeLabelGroups, timeoutMs);\n"]]
  },
  "bridge/src/command/command-service.ts": {
    "before": "559a8ca5b9be16699d75b3be931b9fa8efd355ba41aef65db0e1654aa33bcc28",
    "after": "598570244533bb21ce16ff6c6d3bf1063f31664f18286faebb4884a613584c08",
    "edits": [[409,410,"    // A concrete HA control is a single channel, not an aggregate command.\n    // Check the ORIGINAL request: resolution also supplies an inferred controlId.\n    if (effective.confirm !== false && state && !request.controlId) {\n"]]
  },
  "bridge/src/runtime.ts": {
    "before": "098c1e7396b8d1107bc98c24ad51828d5e9f9dbec4125f4dbf4f3a951a679afb",
    "after": "bd7bfbf7541ff33a56f71ec21b5993b3344e7036c0cae920ef7e6bb730dd7b81",
    "edits": [[105,106,"const bridgeVersion = \"1.8.8\";\n"]]
  },
  "bridge/src/state/device-store.ts": {
    "before": "820d1324c97a13877f2dd73411262c67c2c016c2209fe9858f74a342a8a310cb",
    "after": "1fd6635dbb2966732ae50701583d5cb927afa0e0186f4be93248f222cb62e80c",
    "edits": [[722,722,"        const previousLocation = this.#devices.get(id)?.locationId;\n        const locationChanged = previousLocation !== undefined && previousLocation !== locationId;\n"],[724,725,"        // Card/health enrichment can omit roomId; absence is not a room removal.\n        // Only an explicit null clears it. Ignore malformed non-null identifiers.\n        const nextRoomId = source.roomId === null\n          ? null\n          : safeId(source.roomId, \"identifier\") ?? device.roomId;\n"],[733,733,"          locationChanged ||\n"],[1104,1105,"      if (existing.locationId !== locationId) {\n        existing.locationId = locationId;\n        existing.roomId = null; // A room from the previous location must not leak.\n      }\n"]]
  },
  "bridge/tests/browser/home-monitor-live-dom.test.ts": {
    "before": "22b954a482bdacf278233e389d6b9b60cdd13a835c571fb00dfe3312cd275752",
    "after": "50b3f7f898397303b3db87fa7ce12218e1a383cc60871c276a0d12de01a6e18e",
    "edits": [[35,36,"  locator(selector?: string): MissingLocator {\n    if (selector?.includes(\"data-stw-hm-selector\")) {\n      const control = new MissingLocator();\n      control.click = vi.fn(async () => { this.cardOpened = true; });\n      return control;\n    }\n    return this.missing;\n  }\n"],[54,57,"    if (_pageFunction.name === \"probeHomeMonitorSelector\") {\n      return {\n        kind: input.cleanup ? \"missing\" : this.cardOpened ? \"dialog\" : \"target\",\n        titles: 1, localModes: 1, localGroups: 1, targets: 1\n      } as Result;\n"],[141,142,"    const selectorSource = readFileSync(\"bridge/src/browser/home-monitor-selector.ts\", \"utf8\");\n    expect(domSource).toContain(\"clickScopedHomeMonitorSelector\");\n    expect(selectorSource).toContain(\"probeHomeMonitorSelector\");\n    expect(selectorSource).toContain(\"data-stw-hm-selector\");\n"]]
  },
  "bridge/tests/command/command-service.test.ts": {
    "before": "e4e20bd89ee0191e54d6f3bc158906dda01f16e7d5f22347255f0eb56557cc9f",
    "after": "d7cd7e9cb09167581e37b8af6731589e18d2c5684d30f9fb48c925b433358e88",
    "edits": [[14,14,"  test.each([\"main\", \"switch2\", \"switch3\", \"switch4\"])(\"a concrete %s switch control never becomes a component aggregate\", async (component) => {\n    const fixture = multiSwitchFixture([\"main\", \"switch2\", \"switch3\", \"switch4\"]);\n    const controlId = component === \"main\" ? \"identifier_toggle_aggregate\" : `identifier_toggle_${component}`;\n    const label = component === \"main\" ? \"Aggregate power\" : component;\n    if (component !== \"main\") observeDeviceDetails(fixture.store, [\n      detailSwatch(\"TOGGLE\", \"toggle\", { swatchId: controlId, label,\n        componentId: `identifier_${component}`, commands: [\"on\", \"off\"] })\n    ]);\n    fixture.executeDeviceAction.mockImplementation(async (input) => {\n      fixture.store.observe(received(deviceEventFrame(\"off\", \"2026-09-01T02:00:00.000Z\", \"switch\",\n        \"dev_001\", \"identifier_switch\", undefined, input.component)));\n      return undefined;\n    });\n    const result = await fixture.service.execute({\n      targetType: \"device\", targetId: \"dev_001\", component: `identifier_${component}`,\n      capability: \"identifier_switch\", attribute: \"switch\", controlId, controlLabel: label,\n      command: \"off\", arguments: [], clientRequestId: `request_concrete_${component}`\n    });\n    expect(result.status).toBe(\"confirmed\");\n    expect(fixture.executeDeviceAction).toHaveBeenCalledOnce();\n    expect(fixture.executeDeviceAction.mock.calls[0]?.[0]).toMatchObject({ deviceId: \"dev_001\", component: `identifier_${component}`, command: \"off\" });\n    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();\n    const states = fixture.store.snapshot().devices.find((device) => device.id === \"dev_001\")!.states;\n    for (const state of states.filter((item) => item.attribute === \"switch\" && item.componentRole)) {\n      expect(state.value).toBe(state.component === `identifier_${component}` ? \"off\" : \"on\");\n    }\n    fixture.store.close();\n  });\n\n  test(\"unknown concrete control ID still fails without executing any aggregate\", async () => {\n    const fixture = multiSwitchFixture([\"main\", \"switch2\"]);\n    await expect(fixture.service.execute({\n      targetType: \"device\", targetId: \"dev_001\", component: \"identifier_main\",\n      capability: \"identifier_switch\", attribute: \"switch\", controlId: \"identifier_missing\",\n      command: \"off\", arguments: [], clientRequestId: \"request_missing_concrete\"\n    })).rejects.toMatchObject({ code: \"capability_not_found\" });\n    expect(fixture.executeDeviceAction).not.toHaveBeenCalled();\n    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();\n    fixture.store.close();\n  });\n\n  test(\"a concrete main command does not require a guessed child mapping\", async () => {\n    const fixture = multiSwitchFixture([\"main\", \"switch2\", \"switch3\", \"switch4\"]);\n    configureChildMappedSwitch(fixture.store, { ambiguous: true });\n    const result = await fixture.service.execute({\n      targetType: \"device\", targetId: \"dev_001\", component: \"identifier_main\",\n      capability: \"identifier_switch\", attribute: \"switch\", controlId: \"identifier_toggle_aggregate\",\n      controlLabel: \"Aggregate power\", command: \"off\", arguments: [], clientRequestId: \"request_concrete_no_children\"\n    });\n    expect(result.status).toBe(\"confirmed\");\n    expect(fixture.executeDeviceAction).toHaveBeenCalledOnce();\n    expect(fixture.executeDeviceAction.mock.calls[0]?.[0].deviceId).toBe(\"dev_001\");\n    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();\n    fixture.store.close();\n  });\n\n"]]
  },
  "bridge/tests/state/device-store.test.ts": {
    "before": "9cd3ad64bb5c57a57ce674702f0b46131291621a1aace93f9da2d79ea4c3a775",
    "after": "e17875ba01d867caa462f0666bfd82f32a05c16c2b9d4fdcf8f08cd84b7040b8",
    "edits": [[14,14,"  test(\"preserves room metadata when a Web card omits roomId\", () => {\n    const store = new DeviceStore();\n    const device = { deviceId: \"dev_001\", locationId: \"loc_001\", deviceName: \"Bathroom light\" };\n    observeDeviceSnapshot(store, { ...device, roomId: \"identifier_bathroom\" });\n    const afterRoom = store.snapshot().sequence;\n    observeDeviceSnapshot(store, device);\n    expect(store.snapshot().devices[0]?.roomId).toBe(\"identifier_bathroom\");\n    expect(store.snapshot().sequence).toBe(afterRoom);\n    store.close();\n  });\n\n  test.each([undefined, \"\", 42, \"not a valid id\"])(\"malformed room metadata %s does not erase a known room\", (roomId) => {\n    const store = new DeviceStore();\n    const device = { deviceId: \"dev_001\", locationId: \"loc_001\", deviceName: \"Bathroom light\" };\n    observeDeviceSnapshot(store, { ...device, roomId: \"identifier_bathroom\" });\n    observeDeviceSnapshot(store, { ...device, roomId });\n    expect(store.snapshot().devices[0]?.roomId).toBe(\"identifier_bathroom\");\n    store.close();\n  });\n\n  test(\"explicit null removes a room and later omissions do not restore it\", () => {\n    const store = new DeviceStore();\n    const device = { deviceId: \"dev_001\", locationId: \"loc_001\", deviceName: \"Bathroom light\" };\n    observeDeviceSnapshot(store, { ...device, roomId: \"identifier_bathroom\" });\n    observeDeviceSnapshot(store, { ...device, roomId: null });\n    observeDeviceSnapshot(store, device);\n    expect(store.snapshot().devices[0]?.roomId).toBeNull();\n    store.close();\n  });\n\n  test(\"moving a device to another location cannot retain its old room\", () => {\n    const store = new DeviceStore();\n    observeDeviceSnapshot(store, { deviceId: \"dev_001\", locationId: \"loc_001\", deviceName: \"Light\", roomId: \"identifier_bathroom\" });\n    const listener = vi.fn();\n    store.subscribe(listener);\n    observeDeviceSnapshot(store, { deviceId: \"dev_001\", locationId: \"loc_002\", deviceName: \"Light\" });\n    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: \"inventory\" }));\n    expect(store.snapshot().devices[0]).toMatchObject({ locationId: \"loc_002\", roomId: null });\n    store.close();\n  });\n\n"]]
  },
  "custom_components/smartthings_web/__init__.py": {
    "before": "7a2074e5efee82cd5fcaa95fc6d554168ef653ef424e5b2199bb10975bd44a4a",
    "after": "664befb360b475737690bf437e0bdd267220490068e581368753eb4073a48b6f",
    "edits": [[13,13,"from homeassistant.helpers import area_registry as ar\n"],[62,62,"from .room_assignment import resolve_room_area, repair_missing_device_area\n"],[169,169,"        area_registry = ar.async_get(hass)\n        resolved_areas = {}\n"],[185,185,"            room_name = room[1] if room and room[0] == location_id else None\n            if room_name and room_name not in resolved_areas:\n                resolved_areas[room_name] = resolve_room_area(area_registry, room_name)\n            area = resolved_areas.get(room_name)\n"],[187,188,"                suggested_area=area.name if area else None,\n"],[189,189,"            )\n            repair_missing_device_area(\n                registry, registry_entry.id, entry.entry_id, area.id if area else None\n"]]
  },
  "custom_components/smartthings_web/manifest.json": {
    "before": "b0457c98e6bc178c13415359a0c2d209d0ea4f9aa1a71b602d7308549dcb2512",
    "after": "2a786716d65c12f1dadf644d4b11622e64fab731b92547933b4aa5bee4c3b2c5",
    "edits": [[12,13,"  \"version\": \"1.8.8\"\n"]]
  },
  "custom_components/smartthings_web/room_assignment.py": {
    "before": "c28b751ac8744f72b320aafc50363f8c09fbc3c35d3f7218a2eb28a8fab4e6c4",
    "after": "5189ac92999ac19c4fd8321aacdc2959fa18b3417135dfdf03ffa15e3ab9489f",
    "edits": [[66,66,"\n\nclass RoomAreaRegistry(Protocol):\n    \"\"\"Public area registry operations used during topology registration.\"\"\"\n\n    def async_list_areas(self) -> Iterable[NamedArea]: ...\n\n    def async_get_or_create(self, name: str) -> NamedArea: ...\n\n\ndef resolve_room_area(registry: RoomAreaRegistry, room_name: str) -> NamedArea | None:\n    \"\"\"Reuse a unique existing area, creating one only when no name matches.\n\n    Ambiguous normalized names are not made less ambiguous by creating another\n    duplicate. The caller must also verify that the room belongs to its location.\n    \"\"\"\n    key = room_name_key(room_name)\n    if not key:\n        return None\n    areas = tuple(registry.async_list_areas())\n    matched = matching_room_area(room_name, areas)\n    if matched is not None:\n        return matched\n    if any(room_name_key(area.name) == key for area in areas):\n        return None\n    return registry.async_get_or_create(\" \".join(unicodedata.normalize(\"NFC\", room_name).split()))\n"]]
  },
  "custom_components/smartthings_web/tests/test_room_assignment.py": {
    "before": "9f7ddda9008bfa52fedce7030e052199c5798bede746c0638bceef745a4bf9e2",
    "after": "ca335a70982c11eea3e49f9a267e1a31cabe7ba54c533a665c712a020e5223e9",
    "edits": [[90,90,"class AreaRegistry:\n    def __init__(self, areas):\n        self.entries = list(areas)\n        self.created = []\n\n    def async_list_areas(self):\n        return self.entries\n\n    def async_get_or_create(self, name):\n        item = area(f\"created_{len(self.created)}\", name)\n        self.created.append(name)\n        self.entries.append(item)\n        return item\n\n\nclass ResolveRoomAreaTests(unittest.TestCase):\n    def test_existing_canonical_name_is_reused(self):\n        original = area(\"bathroom\", \"화장실\")\n        registry = AreaRegistry([original])\n        self.assertIs(module.resolve_room_area(registry, \" 화장실 \"), original)\n        self.assertEqual(registry.created, [])\n\n    def test_ambiguous_normalized_name_is_not_created(self):\n        registry = AreaRegistry([area(\"a\", \"Room\"), area(\"b\", \"room\")])\n        self.assertIsNone(module.resolve_room_area(registry, \" ROOM \"))\n        self.assertEqual(registry.created, [])\n\n    def test_unknown_area_is_created_once(self):\n        registry = AreaRegistry([])\n        first = module.resolve_room_area(registry, \" 화장실 \")\n        self.assertIs(module.resolve_room_area(registry, \"화장실\"), first)\n        self.assertEqual(registry.created, [\"화장실\"])\n\n    def test_blank_room_does_not_create_an_area(self):\n        registry = AreaRegistry([])\n        self.assertIsNone(module.resolve_room_area(registry, \" \"))\n        self.assertEqual(registry.created, [])\n\n    def test_resolved_area_repairs_only_missing_assignment(self):\n        areas = AreaRegistry([area(\"bathroom\", \"화장실\")])\n        devices = Registry(SimpleNamespace(id=\"device\", area_id=None, config_entry_id=\"entry\"))\n        target = module.resolve_room_area(areas, \"화장실\")\n        self.assertTrue(repair(devices, \"device\", \"entry\", target.id))\n        self.assertFalse(repair(devices, \"device\", \"entry\", target.id))\n        self.assertEqual(devices.writes, [(\"device\", {\"area_id\": \"bathroom\"})])\n\n\n"]]
  },
  "docs/release-1.8.8.md": {
    "before": null,
    "after": "40ac6aed7ece7ea2eebae81789ff8e2aa3e3d0558255aaae4514c95c13ffce6c",
    "edits": [[0,0,"# SmartThings Web 1.8.8\n\n## 수정 근거\n\n사용자가 제공한 2026-09-06 단계 로그에서 외출은 2.726초, 해제는 6.014초에 확인됐고 실내는 대기열 0~2ms에도 약 8.5~8.9초 후 제어 탐색 중 모호성 오류가 났습니다. 보안 상태 전파가 아닌 선택기 탐색의 회귀를 별도로 보완합니다. 실제 화면에서 충돌한 요소는 개수 로그만으로 확정할 수 없습니다.\n\n## 1.8.8\n\n- Home Monitor의 현재 모드 선택기를 해당 카드 안에서만 찾고 같은 버튼의 중복 문구를 병합합니다. 서로 다른 버튼, 비활성 제어, 다른 팝업은 계속 차단합니다.\n- 선택기가 확인되면 숨겨진 직접 모드 버튼을 기다리던 반복 탐색을 건너뜁니다. 기존 직접 버튼 클릭, 실제 보안 상태 확인, 제어 탭 유지 및 대기열 제한은 유지합니다.\n- 기존 HA 영역을 Unicode·공백 정규화로 재사용하고, 방 정보가 늦게 도착한 미지정 기기에 영역을 연결합니다. 사용자 지정 영역·엔티티 식별자는 덮어쓰지 않습니다.\n- 일부 Web 기기 응답에서 roomId가 생략돼도 기존 방 정보를 보존합니다. 명시적 null 또는 다른 위치로 이동한 경우에는 이전 방 연결을 유지하지 않습니다.\n- controlId가 지정된 개별 스위치 요청을 여러 채널의 일괄 동작으로 확대하지 않습니다. 기존 명시적 일괄 요청, 제어 허용 검사와 상태 확인은 유지합니다.\n- 로컬 및 CI 회귀 검증과 실제 Samsung 계정/HA 기기 검증은 구분합니다. 실제 제어 성공률·서버 지연 개선은 사용 환경에서 별도 확인이 필요합니다.\n\n## 보존 범위\n\n자동 해제 후 재무장, 안전 검사 완화, 무조건 성공 처리, 숨은 재전송을 추가하지 않습니다. Scene, TTS, 로그인 프로필, 쿠키, 공개 서비스와 기존 entity_id/unique_id는 변경하지 않습니다. 영역이 이미 지정된 장치에는 영역을 강제로 재지정하지 않습니다. 두 위치에서 동일한 방 이름을 사용하는 경우 HA의 전역 영역을 재사용하며 위치 관계는 확인합니다.\n\n## 검증\n\nHome Monitor의 6방향 합성 전환과 오작동 방지, 지정 채널/일괄 동작 구분, 방 정보 누락·명시적 제거·위치 변경 및 기존 영역 재사용을 회귀 테스트합니다. CI의 Node/Python, TypeScript, Chromium, HACS/Hassfest, 정상·손상 데이터 시작 검사와 보안 검사 결과를 릴리스 시 확인합니다. 삼성 계정과 사용자 HA에서 직접 테스트하지 않았으며 합성 테스트 시간을 실제 서버 응답 시간으로 해석하지 않습니다.\n\n## 적용과 롤백\n\nBridge 앱과 HACS 통합 모두 1.8.8을 설치하고 Core를 재시작합니다. 업데이트 중에는 설치를 중복 요청하지 않습니다. 문제가 생기면 이전 배포 버전과 백업을 사용합니다. 기기/통합 삭제나 재페어링은 필요하지 않습니다.\n"]]
  },
  "package-lock.json": {
    "before": "1f6283aa632cb5e42ccad7020cb17266ee383c86cc8db06e58b13e3fa1af1cee",
    "after": "1f6661e9676ed82f36a14b91507634ee07a5e6816f0a60501a191c48546c5cea",
    "edits": [[2,3,"  \"version\": \"1.8.8\",\n"],[8,9,"      \"version\": \"1.8.8\",\n"]]
  },
  "package.json": {
    "before": "236a25f0012400c60dab39f1c49d602852bf2c8ba2ca8058d959df3071b6eff8",
    "after": "807ac33c0bfcd0c8cc1b137d84e20e380575955f71e98ed80d1ead77199a3093",
    "edits": [[2,3,"  \"version\": \"1.8.8\",\n"]]
  },
  "protocol/version.json": {
    "before": "f92806918de697e32c85b9d19a0ca3665fa7f80665a20d735112da2b024438f4",
    "after": "9a60e13f68c5dee5297667c11712943fb7f8ddfca9bde45976d82ed025ac449b",
    "edits": [[1,2,"  \"bridge_version\": \"1.8.8\",\n"]]
  },
  "tests/protocol-version-contract.test.ts": {
    "before": "d0ea7dc6ae438518d8a4ff5141dbc4fd148b07d210a7d30b71518af3cc4ac46b",
    "after": "d731a22084844072530247ec72e0656819efece53abc8d70348c10e835bb3203",
    "edits": [[14,17,"  test(\"keeps integration 1.8.8 compatible with Bridge 1.8.8 and protocol 5\", () => {\n    const expectedBridgeVersion = \"1.8.8\";\n    const expectedIntegrationVersion = \"1.8.8\";\n"]]
  },
  "tools/home-monitor-selector-regression.mjs": {
    "before": null,
    "after": "cd66f6c9eeb3296f57a05fbc9ea5d75040233c00aea53f36e45243ccc49cf90e",
    "edits": [[0,0,"import fs from 'node:fs';\nimport assert from 'node:assert/strict';\nimport {createRequire} from 'node:module';\nimport {performance} from 'node:perf_hooks';\nimport path from 'node:path';\nconst require=createRequire(import.meta.url);\nconst {chromium}=require('playwright-core');\nconst baseline=undefined;\nconst oldExecutor=undefined;\nconst candidate=await import('../dist/bridge/src/browser/home-monitor-dom.js');\nconst newExecutor=await import('../dist/bridge/src/browser/command-page.js');\n// All requests are intercepted. No Samsung account or physical commands are used.\nconst groups=[['Arm away','Armed away','Armed (Away)','Away','보안(외출)'],['Arm stay','Armed stay','Armed (Stay)','Stay','보안(실내)'],['Off','Disarm','Disarmed','Not armed','Security off','해제','해제됨']];\nconst titles=['SmartThings Home Monitor','Home Monitor'];\nconst browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});\nconst context=await browser.newContext();\n// The tests never contact a real SmartThings endpoint.\nawait context.route('**/*', route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));\nconst page=await context.newPage();\nconst shell=(inner,other='')=>`<style>button{cursor:pointer} span{display:inline-block} section{padding:10px}</style><main><section class=\"monitor-card\"><h2>Home Monitor</h2>${inner}</section>${other}</main><script>window.clicks=[];document.addEventListener('click',e=>window.clicks.push(e.target.closest('[id]')?.id||e.target.tagName));</script>`;\nconst other=(html)=>`<section><h2>Devices</h2>${html}</section>`;\nconst results=[];\nasync function test(name,work){const start=performance.now();try{const detail=await work();results.push({name,status:'passed',ms:Math.round(performance.now()-start),...detail});console.log('PASS',name,JSON.stringify(detail??{}));}catch(e){results.push({name,status:'failed',error:String(e)});console.error('FAIL',name,e.stack);}}\nasync function click(mod,html){await page.setContent(html);const start=performance.now();const result=await mod.clickCurrentHomeMonitorMode(page,titles,groups,150);return {result,clicks:await page.evaluate(()=>window.clicks),ms:Math.round(performance.now()-start)};}\nawait test('ignores same mode labels on other dashboard cards',async()=>{\n const html=shell('<button role=\"combobox\" id=\"current\">Off</button>',other('<button id=\"other-off\">Off</button>'));\n const old=baseline ? await click(baseline,html) : undefined;const fixed=await click(candidate,html);\n if(old)assert.equal(old.result,'ambiguous');assert.equal(fixed.result,'clicked');assert.deepEqual(fixed.clicks,['current']);return {baseline:old,candidate:fixed};\n});\nawait test('deduplicates spans on one current-mode button',async()=>{\n const html=shell('<button id=\"current\" aria-haspopup=\"listbox\"><span>Armed (Away)</span><span>Armed away</span></button>');\n const old=baseline ? await click(baseline,html) : undefined;const fixed=await click(candidate,html);\n if(old)assert.equal(old.result,'ambiguous');assert.equal(fixed.result,'clicked');assert.deepEqual(fixed.clicks,['current']);return {baseline:old,candidate:fixed};\n});\nawait test('foreign Off labels do not conflict with an armed-away state caption',async()=>{\n const fixed=await click(candidate,shell('<button id=\"current\"><span>Armed (Away)</span></button>',other('<button>Off</button><button>Off</button>')));\n assert.equal(fixed.result,'clicked');assert.deepEqual(fixed.clicks,['current']);return fixed;\n});\nfor(const [name,html,expected] of [\n ['two distinct current-mode controls remain ambiguous',shell('<button id=\"a\">Armed away</button><button id=\"b\">Armed away</button>'),'ambiguous'],\n ['two monitor cards remain ambiguous',shell('<button id=\"a\">Armed away</button>')+'<section><h2>Home Monitor</h2><button id=\"b\">Armed away</button></section>','ambiguous'],\n ['unknown modal blocks dashboard click',shell('<button id=\"a\">Armed away</button>')+'<div role=\"dialog\">Other dialog</div>','blocked'],\n ['no expansion into foreign widget',shell('<p>Unknown state</p>',other('<button id=\"b\">Armed away</button>')),'not_found'],\n ['never use Disarm action to open selector',shell('<button id=\"disarm\">Disarm</button>'),'not_found'],\n ['never use Off action to open selector',shell('<button id=\"off\">Off</button>'),'not_found'],\n ['disabled current-mode control is not clicked',shell('<button id=\"a\" disabled>Armed away</button>'),'blocked'],\n ['disabled ancestor is not clicked',shell('<div aria-disabled=\"true\"><button id=\"a\">Armed away</button></div>'),'blocked'],\n ['direct two-mode row is not treated as selector',shell('<button id=\"a\">보안(실내)</button><button id=\"b\">보안(외출)</button>'),'not_found'],\n]) {await test(name,async()=>{const result=await click(candidate,html);assert.equal(result.result,expected);assert.deepEqual(result.clicks,[]);return result;});}\nawait test('hidden ancestor does not add a duplicate candidate',async()=>{\n const result=await click(candidate,shell('<button id=\"a\">Armed away</button><div aria-hidden=\"true\"><button id=\"b\">Armed away</button></div>'));\n assert.equal(result.result,'clicked');assert.deepEqual(result.clicks,['a']);return result;\n});\nawait test('roleless current-state caption retains delegated click',async()=>{\n const result=await click(candidate,shell('<div id=\"current\" style=\"cursor:pointer\"><span>Armed ( Away )</span></div>'));\n assert.equal(result.result,'clicked');assert.deepEqual(result.clicks,['current']);return result;\n});\nawait test('open shadow root selector and cleanup',async()=>{\n await page.setContent('<div id=\"host\"></div><script>window.clicks=[];host.attachShadow({mode:\"open\"}).innerHTML=`<section><h2>Home Monitor</h2><button id=\"current\">Armed away</button></section>`;host.shadowRoot.addEventListener(\"click\",()=>window.clicks.push(\"current\"));</script>');\n assert.equal(await candidate.clickCurrentHomeMonitorMode(page,titles,groups,200),'clicked');\n assert.deepEqual(await page.evaluate(()=>window.clicks),['current']);\n assert.equal(await page.evaluate(()=>document.querySelector('#host').shadowRoot.querySelectorAll('[data-stw-hm-selector]').length),0);\n});\nfunction transitionFixture(current,duplicates=true){\n return shell(`<button id=\"current\" aria-haspopup=\"listbox\">${duplicates?`<span>${current}</span><span>${current}</span>`:current}</button>`,other('<button id=\"other-off\">Off</button>'))+`<script>\n window.actions=[];window.openerClicks=0;\n document.querySelector('#current').addEventListener('click',()=>{\n  window.openerClicks++;\n  if(document.querySelector('[role=\"dialog\"]'))return;\n  const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<h2>Home Monitor</h2><button data-mode=\"armAway\">보안(외출)</button><button data-mode=\"armStay\">보안(실내)</button><button data-mode=\"disarm\">Disarm</button>';\n  d.addEventListener('click',e=>{if(e.target.dataset.mode){window.actions.push(e.target.dataset.mode);d.remove();}});document.body.appendChild(d);\n });</script>`;\n}\nasync function execute(mod,action,html){\n const diagnostics=[];let commandPage;\n const manager={openCommandPage:async()=>{const native=await context.newPage();await native.setContent(html);commandPage=new Proxy(native,{get(target,key){if(key==='url')return ()=> 'https://my.smartthings.com/location/raw-test-location';const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});return commandPage;}};\n const executor=new mod.SmartThingsWebUiCommandExecutor(()=>manager,()=> 'loc_test_location',{resolveRawLocationId:()=> 'raw-test-location',onDiagnostic:s=>diagnostics.push(s)});\n const start=performance.now();let evidence;\n try{\n await executor.executeLocationAction({action,locationId:'loc_test_location',locationNames:{loc_test_location:'Test'},waitForConfirmation:async()=>{\n  evidence=await commandPage.evaluate(()=>({actions:window.actions,openerClicks:window.openerClicks}));\n  assert.deepEqual(evidence.actions,[action]);\n }});return {outcome:'confirmed_fixture',ms:Math.round(performance.now()-start),diagnostics,evidence};\n }catch(error){return {outcome:error.message,ms:Math.round(performance.now()-start),diagnostics,evidence};}\n}\nawait test('full executor uses the bounded selector fast path',async()=>{\n const html=transitionFixture('Armed (Away)');const old=oldExecutor ? await execute(oldExecutor,'armStay',html) : undefined;const fixed=await execute(newExecutor,'armStay',html);\n if(old)assert.equal(old.outcome,'command_control_ambiguous');assert.equal(fixed.outcome,'confirmed_fixture');assert(fixed.ms<3000);assert.equal(fixed.evidence.openerClicks,1);\n return {baseline:old,candidate:fixed};\n});\nfor(const [current,action] of [['Armed (Away)','armStay'],['Armed (Away)','disarm'],['Armed (Stay)','armAway'],['Armed (Stay)','disarm'],['Disarmed','armStay'],['Disarmed','armAway']]){\n await test(`selector ${current} -> ${action} dispatches only requested mode`,async()=>{const result=await execute(newExecutor,action,transitionFixture(current));assert.equal(result.outcome,'confirmed_fixture');assert.equal(result.evidence.openerClicks,1);return result;});\n}\nfor(const action of ['armAway','armStay','disarm']){\n await test(`existing direct dashboard ${action} remains one-click`,async()=>{\n const html=shell('<button data-mode=\"armAway\">보안(외출)</button><button data-mode=\"armStay\">보안(실내)</button><button data-mode=\"disarm\">Disarm</button>')+'<script>window.actions=[];document.addEventListener(\"click\",e=>{if(e.target.dataset.mode)window.actions.push(e.target.dataset.mode)});</script>';\n const result=await execute(newExecutor,action,html);assert.equal(result.outcome,'confirmed_fixture');return result;\n });\n}\nconst browserVersion=browser.version();\nawait browser.close();\nfs.writeFileSync(path.resolve(process.env.OUTPUT_PATH ?? 'home-monitor-selector-results.json'),JSON.stringify({scope:'Synthetic local Chromium fixtures, no Samsung account or physical commands',runtime:{node:process.version,playwright:require('playwright-core/package.json').version,chromium:browserVersion},results},null,2));\nconsole.log(`${results.filter(r=>r.status==='passed').length}/${results.length} passed`);\nif(results.some(r=>r.status!=='passed'))process.exitCode=1;\n"]]
  }
}
''')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    root = Path.cwd().resolve()
    prepared: list[tuple[Path, bytes | None]] = []
    for name, change in PATCHES.items():
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise SystemExit(f"Unsafe source path: {name}")
        current = path.read_bytes() if path.exists() else None
        actual = digest(current) if current is not None else None
        if actual != change["before"]:
            raise SystemExit(f"Source changed; refusing stale edit: {name}")
        if change["after"] is None:
            prepared.append((path, None))
            continue
        lines = (current or b"").decode("utf-8").splitlines(keepends=True)
        for start, stop, replacement in reversed(change["edits"]):
            lines[start:stop] = replacement.splitlines(keepends=True)
        result = "".join(lines).encode("utf-8")
        if digest(result) != change["after"]:
            raise SystemExit(f"Result checksum mismatch: {name}")
        prepared.append((path, result))
    for path, result in prepared:
        if result is None:
            path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(result)
    print(f"Applied {len(prepared)} checked source changes for 1.8.8")


if __name__ == "__main__":
    main()

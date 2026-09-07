from pathlib import Path
import json

root = Path.cwd()
assert json.loads((root / 'package.json').read_text())['version'] == '1.8.17'
p = root / 'bridge/src/advanced/command-catalog.ts'
s = p.read_text()
old = 'const MAX_PUBLIC_ENUM_VALUES = 128;'
assert s.count(old) == 1
s = s.replace(old, '''// Descriptive JSON Schema annotations never change the accepted argument values.
// Drop them before publishing the catalog; do not forward arbitrary descriptive text.
const SCHEMA_TEXT_ANNOTATIONS = new Set(["title", "description"]);
const MAX_PUBLIC_ENUM_VALUES = 128;''')
old = 'required: value.required !== false,'
assert s.count(old) == 1
s = s.replace(old, 'required: value.required !== false && value.optional !== true,')
old = '  if (!Object.keys(value).every((key) => PUBLIC_SCHEMA_KEYS.has(key))) return undefined;'
assert s.count(old) == 1
s = s.replace(old, '''  if (!Object.entries(value).every(([key, entry]) =>
    PUBLIC_SCHEMA_KEYS.has(key) || (SCHEMA_TEXT_ANNOTATIONS.has(key) && typeof entry === "string")
  )) return undefined;''')
p.write_text(s)

C = 'identifier_main'
raws = {
 'switch': {'on': {'arguments': []}, 'off': {'arguments': []}},
 'switchLevel': {'setLevel': {'arguments': [
  {'name': 'level', 'optional': False, 'schema': {'type': 'integer', 'minimum': 0, 'maximum': 100}},
  {'name': 'rate', 'optional': True, 'schema': {'title': 'PositiveInteger', 'type': 'integer', 'minimum': 0}}
 ]}},
 'colorTemperature': {'setColorTemperature': {'arguments': [
  {'name': 'temperature', 'optional': False, 'schema': {'type': 'integer', 'minimum': 1, 'maximum': 30000}}
 ]}},
 'colorControl': {
  'setHue': {'arguments': [{'name': 'hue', 'optional': False, 'schema': {'title': 'PositiveNumber', 'type': 'number', 'minimum': 0}}]},
  'setSaturation': {'arguments': [{'name': 'saturation', 'optional': False, 'schema': {'title': 'PositiveNumber', 'type': 'number', 'minimum': 0}}]},
  'setColor': {'arguments': [{'name': 'color', 'optional': False, 'schema': {'title': 'ColorMap', 'type': 'object', 'properties': {'hue': {'type': 'number'}, 'saturation': {'type': 'number'}}, 'additionalProperties': False}}]}
 }
}
caps = {'switch': 'identifier_power', 'switchLevel': 'identifier_level', 'colorTemperature': 'identifier_temperature', 'colorControl': 'identifier_color'}
defs = [{'id': k, 'version': 1, 'attributes': {}, 'commands': v} for k, v in raws.items()]
bindings = [{'deviceId': 'dev_001', 'component': C, 'componentRole': 'main', 'capability': caps[k], 'rawCapability': k, 'version': 1} for k in raws]
commands = []
for k, raw in raws.items():
 for name, cmd in raw.items():
  if name == 'setColor':
   continue
  commands.append({'component': C, 'componentRole': 'main', 'capability': caps[k], 'capabilityVersion': 1, 'command': name, 'arguments': [
   {'name': arg['name'], 'required': not arg.get('optional', False), 'sensitive': False, 'schema': {key: v for key, v in arg['schema'].items() if key not in ('title', 'description')}} for arg in cmd['arguments']],
   'transport': 'advanced', 'confirmation': 'state', 'label': name, 'labelSource': 'capability'})
commands.sort(key=lambda x: f"{x['component']}:{x['capability']}:{x['command']}")
fixture = {'note': 'Synthetic schema regression, not a user device capture. Shared Node catalog / Python light contract.',
 'definitions': defs, 'bindings': bindings, 'expectedCatalog': {'schemaVersion': 1, 'deviceId': 'dev_001', 'commands': commands, 'omissions': {'schema_invalid': 1}},
 'expectedOmissions': [{'component': C, 'capability': 'identifier_color', 'command': 'setColor', 'reason': 'schema_invalid'}]}
f = root / 'custom_components/smartthings_web/tests/fixtures/light-schema-annotations.json'
f.parent.mkdir(parents=True, exist_ok=True)
f.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + '\n')

p = root / 'custom_components/smartthings_web/tests/test_light_capabilities.py'
s = p.read_text()
needle = '        def test_hue_supports_color_temperature_and_color_without_web_sliders(self):'
new = '''        async def test_raw_schema_catalog_contract_restores_brightness_and_color(self):
            # The Node test produces exactly this catalog from title-bearing raw schemas.
            import json
            from smartthings_web.bridge_client import parse_command_catalog
            fixture = json.loads((root / "tests/fixtures/light-schema-annotations.json").read_text())
            catalog = parse_command_catalog(fixture["expectedCatalog"], self.device.device_id)
            self.device.commands = tuple(d for d in catalog.commands if d.command == "setColorTemperature")
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.ONOFF})
            original = (self.entity.entity_id, self.entity._attr_unique_id)
            await self.entity.async_added_to_hass()
            latest = deepcopy(self.runtime.inventory)
            latest.sequence += 1
            latest.devices[self.device.device_id].commands = catalog.commands
            latest.devices[self.device.device_id].command_omissions = (
                BridgeCommandOmission(C, capabilities["hue"], "setColor", "schema_invalid"),
            )
            self.runtime.apply_inventory(latest)
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.HS, ColorMode.COLOR_TEMP})
            self.assertEqual((self.entity.entity_id, self.entity._attr_unique_id), original)
            self.assertEqual(self.entity.writes, 1)
            self.assertEqual(self.entity.brightness, 153)
            self.assertEqual(self.entity.hs_color, (90, 80))
            await self.entity.async_turn_on(brightness=128, hs_color=(180, 70))
            calls = [call.kwargs for call in self.client.async_execute_command.await_args_list]
            self.assertEqual([call["command"] for call in calls], ["on", "setLevel", "setHue", "setSaturation"])
            self.assertEqual([call["arguments"] for call in calls], [[], [50], [50], [70]])
            self.assertTrue(all(call["require_advanced"] and call["confirm"] for call in calls[1:]))
            self.client.async_execute_command.reset_mock()
            await self.entity.async_turn_on(color_temp_kelvin=3000)
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["command"], "setColorTemperature")
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["arguments"], [3000])
            self.assertEqual(self.entity.hs_color, (90, 80))

'''
assert s.count(needle) == 1
p.write_text(s.replace(needle, new + needle))

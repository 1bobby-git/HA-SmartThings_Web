from pathlib import Path
p = Path('custom_components/smartthings_web/tests/test_light.py')
s = p.read_text()
s = s.replace('import asyncio\n', 'import asyncio\nfrom copy import deepcopy\n', 1)
start = s.index('    def test_light_preserves_raw_values_and_targets_exact_controls')
end = s.index('\n    def test_light_becomes_unavailable', start)
old = s[start:end]
new = old.replace('                self.calls: list[dict[str, object]] = []', '                self.calls: list[dict[str, object]] = []\n                self.inventory_reads = 0')
new = new.replace('''        client = Client()
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={device.device_id: device}),
        )''', '''            async def async_get_inventory(self) -> BridgeInventory:
                self.inventory_reads += 1
                return deepcopy(runtime.inventory)

        client = Client()
        runtime = SmartThingsWebRuntime(
            client, "loc_001",
            BridgeInventory(1, True, "1.8.19", "5:test", {"loc_001": "Home"}, {},
                            {device.device_id: device}),
        )''')
new += '''
        self.assertEqual(client.inventory_reads, 1)
        self.assertEqual(entity.brightness, 102)
        self.assertEqual(entity.color_temp_kelvin, 3000)
'''
assert new != old and 'runtime = SimpleNamespace' not in new
p.write_text(s[:start]+new+s[end:])

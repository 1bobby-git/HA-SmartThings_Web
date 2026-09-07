from pathlib import Path
p = Path('bridge/tests/command/command-service.test.ts')
s = p.read_text()
start = s.index('  ])("does not let %s use the stateless refresh snapshot policy"')
end = s.index('\n  test.each([', start)
old = s[start:end]
new = old.replace('    const store = setup(readyDeviceStore());', '    vi.useFakeTimers();\n    const store = setup(readyDeviceStore());')
new = new.replace('''    await expect(service.execute(request())).rejects.toMatchObject({
      code: "command_confirmation_timeout"
    });
    expect(resync).toHaveBeenCalledTimes(1);''', '''    try {
      const failed = expect(service.execute(request())).rejects.toMatchObject({
        code: "command_confirmation_timeout"
      });
      await vi.advanceTimersByTimeAsync(11);
      await failed;
      // Early + final bounded read; neither metadata-only response confirms control.
      expect(resync).toHaveBeenCalledTimes(2);
    } finally { store.close(); vi.useRealTimers(); }''')
assert new != old and 'toHaveBeenCalledTimes(1)' not in new
p.write_text(s[:start] + new + s[end:])

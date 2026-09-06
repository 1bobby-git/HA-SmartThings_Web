#!/usr/bin/env bash
set -euo pipefail
driver="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python "$driver/apply.py" "$PWD"
python "$driver/document.py" "$PWD"
cp -a "$driver/files/." .
# Stage only the reviewed source/docs/tests, never build products or credentials.
git add -- CHANGELOG.md README.md addon/smartthings_web_bridge/CHANGELOG.md addon/smartthings_web_bridge/DOCS.md addon/smartthings_web_bridge/README.md addon/smartthings_web_bridge/config.yaml bridge/src/advanced/capability-cache.ts bridge/src/browser/keeper-page.ts bridge/src/runtime.ts bridge/src/security/alias-store.ts bridge/src/state/capture-store.ts bridge/tests/advanced/capability-cache-lifecycle.test.ts bridge/tests/browser/keeper-lifecycle.test.ts bridge/tests/security/alias-store-cache.test.ts bridge/tests/state/capture-statement-reuse.test.ts docs/BRIDGE_1.8.7.md docs/OPTIMIZATION_2026-09-06.md package-lock.json package.json protocol/version.json tests/addon-config.test.ts tests/protocol-version-contract.test.ts tools/ci-bridge-lifecycle-smoke.mjs
git diff --cached --check
git diff --exit-code
git diff --cached --exit-code -- custom_components bridge/src/command bridge/src/browser/persistent-context.ts addon/smartthings_web_bridge/Dockerfile addon/smartthings_web_bridge/rootfs
python - <<'PY'
import json, subprocess
from pathlib import Path
base=json.loads(subprocess.check_output(['git','show','HEAD:package-lock.json']))
current=json.loads(Path('package-lock.json').read_text())
base['version']='1.8.7'; base['packages']['']['version']='1.8.7'
assert base == current, 'dependency lock changed'
assert json.loads(Path('custom_components/smartthings_web/manifest.json').read_text())['version']=='1.8.7'
PY

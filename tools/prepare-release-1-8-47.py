from pathlib import Path
import json

version = "1.8.47"
previous = "1.8.46"

p = Path("package.json")
data = json.loads(p.read_text(encoding="utf-8"))
assert data["version"] == previous
data["version"] = version
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

p = Path("package-lock.json")
data = json.loads(p.read_text(encoding="utf-8"))
assert data["version"] == previous
assert data["packages"][""]["version"] == previous
data["version"] = version
data["packages"][""]["version"] = version
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

p = Path("custom_components/smartthings_web/manifest.json")
data = json.loads(p.read_text(encoding="utf-8"))
assert data["version"] == previous
data["version"] = version
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

p = Path("protocol/version.json")
data = json.loads(p.read_text(encoding="utf-8"))
assert data["bridge_version"] == previous
data["bridge_version"] = version
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

p = Path("addon/smartthings_web_bridge/config.yaml")
text = p.read_text(encoding="utf-8")
assert f"version: {previous}" in text
p.write_text(text.replace(f"version: {previous}", f"version: {version}", 1), encoding="utf-8")

for name in [
    "bridge/src/runtime.ts",
    "bridge/tests/runtime.test.ts",
    "tests/addon-config.test.ts",
    "tests/protocol-version-contract.test.ts",
]:
    p = Path(name)
    text = p.read_text(encoding="utf-8")
    assert previous in text, name
    p.write_text(text.replace(previous, version), encoding="utf-8")

notes = """## 1.8.47

- `현재 브릿지 상태` 영역을 짙은 남색 배경에서 다른 정보 카드와 동일한 흰색 surface 카드로 변경해 페이지 전체의 시각적 일관성과 가독성을 높였습니다.
- 서비스 상태, HA 준비 상태, 브라우저 세션에 공통으로 사용할 수 있는 `정상 · 주의 · 오류` 상태 에셋을 준비했습니다. 정상 상태는 초록색 체크, 준비/확인 중은 경고색 상태 아이콘, 오류·로그인 필요 상태는 빨간 경고 아이콘으로 텍스트와 함께 표시합니다.
- 기존 런타임의 안전한 `authenticated` boolean을 HealthReport에 추가해 실제 브라우저 로그인 세션 유지 여부를 상태 페이지에서 정확히 구분합니다.
- 브라우저 세션이 유지 중이면 우측 상단에 `브라우저 로그인됨 / 세션 유지 중 · 다시 열기`로 표시해 불필요한 로그인 유도 인상을 제거했습니다.
- 로그인 또는 재인증이 실제 필요한 경우에만 `브라우저 로그인 필요`, 브라우저 오류 상태에서는 `브라우저 확인 필요`, 판정 전에는 `로그인 상태 확인 중`으로 표시합니다.
- Home Assistant 연결 영역의 보조 브라우저 버튼도 현재 세션 상태에 맞춰 `브라우저 다시 열기 · 브라우저 로그인 · 브라우저 확인 · 브라우저 상태 확인`으로 자동 변경됩니다.
- Bridge 시작/대기 화면도 남색 상태 카드 대신 흰색 surface와 경고 상태 아이콘을 사용하고, 무조건적인 로그인 유도 문구를 `브라우저 상태 확인` 중심으로 변경했습니다.
- 기존 로고, 상대 noVNC 경로, 8자리·10분 페어링, Protocol Changed 시 readiness/Phase 2 차단, HTML 이스케이프 및 안전한 진단 정책은 그대로 유지합니다.
- PR #85에서 Node 테스트·typecheck·build·실제 Chromium UI·Advanced transport·persistent session continuity·Python·HACS·Hassfest·HAOS runtime smoke·Home Assistant 통합·Security checks를 모두 통과한 변경을 배포합니다.
- 새 UI를 적용하려면 SmartThings Web Bridge 앱을 1.8.47로 업데이트해야 합니다.

"""
for name in ["CHANGELOG.md", "addon/smartthings_web_bridge/CHANGELOG.md"]:
    p = Path(name)
    p.write_text(notes + p.read_text(encoding="utf-8"), encoding="utf-8")

Path("release-notes/1.8.47.md").write_text(notes.split("\n\n", 1)[1], encoding="utf-8")

Path("tools/prepare-release-1-8-47.py").unlink()
Path(".github/workflows/prepare-release-1-8-47.yml").unlink()

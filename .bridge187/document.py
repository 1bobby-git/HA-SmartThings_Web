from pathlib import Path
import sys
r = Path(sys.argv[1]).resolve()
notes = '''# SmartThings Web Bridge 1.8.7

2026-09-06 · 브리지 앱/Node 패키지의 실제 최적화 후속 배포

## 변경 내용

- keeper 복구·생성 및 복원 탭 정리를 진행 중인 작업 단위로 공유합니다. 겹치는 heartbeat/복구 호출이 여러 탭을 만들거나 같은 복원 탭을 반복 종료하지 않도록 합니다. 완료·실패 후에는 작업을 제거하여 다음 복구가 정상 재시도됩니다.
- Advanced 탭의 관찰기 초기화 또는 페이지 이동 실패 시, 호출자에게 반환되지 못한 임시 탭을 정리합니다. 새 keeper의 최초 이동 실패도 동일하게 정리하며 원래 오류를 유지합니다.
- 기기·위치 별칭의 SQLite 조회를 최대 2,048개 HMAC 키 캐시와 재사용 SQL 문으로 최적화합니다. 원본 식별자·쿠키는 캐시하지 않으며 기존 별칭과 데이터베이스 스키마는 그대로 유지합니다. 일회성 이벤트 식별자는 계속 비영속 처리합니다.
- 캡처 저장·최근 조회·heartbeat·보존 기간 정리의 SQL 문을 한 번 준비하여 재사용합니다. 기존 중복 억제, 순서, 보존 개수와 SQLite 잠금 처리 정책은 유지합니다.
- capability 캐시에서 이전 요청이 늦게 실패해도 같은 키의 최신 요청/성공 결과를 삭제하지 않도록 합니다. 캐시 크기, 명령 schema 검증과 재시도 정책은 변경하지 않습니다.
- 위 경합·탭 정리·SQL 재사용·별칭 안정성을 검증하는 자동 회귀 테스트 18개를 추가했습니다.

## 세션·호환성

브리지 앱, package.json/lock, 런타임과 protocol/version.json의 bridge_version은 1.8.7입니다. HA 통합은 기존 1.8.7, wire protocol은 5, Chromium/Playwright 및 나머지 의존성 버전은 그대로입니다.

Chromium 프로필, 쿠키, 로그인 페이지, 사용자 MFA/CAPTCHA, 기존 세션 확인·SSO 복구 간격은 바꾸지 않습니다. 서버가 만료시킨 쿠키를 되살리거나 만료 정책을 우회하지 않습니다. 이번 개선은 세션 복구 경합과 불필요한 자원 사용을 줄이는 것이며 쿠키의 서버 측 유효기간을 연장한다는 뜻이 아닙니다.

기기 명령, Home Monitor, Scene, TTS, SSE 순서, 엔티티 ID, 기존 설정은 변경하지 않습니다. 사용자 계정·운영 HA의 장시간 로그인과 물리 제어는 자동 CI로 검증한 범위가 아닙니다. 기존 개발 중/설치 자제 경고도 유지합니다.

## 배포 파일과 소스

이미 공개된 통합 `v1.8.7` 태그와 통합 설치 파일은 덮어쓰지 않습니다. 브리지 소스는 별도의 `bridge-v1.8.7` 태그로 식별하고, 기존 `v1.8.7` 릴리스에 다음 새 파일을 추가합니다.

- `smartthings-web-bridge-1.8.7.tgz`
- `SHA256SUMS-bridge-1.8.7.txt`
- `bridge-1.8.7-provenance.json`

이 방식은 기존 HA 앱 Dockerfile의 버전별 다운로드 주소를 유지합니다. 과거 `smartthings-web-bridge-1.8.6.tgz` 파일과 통합 `v1.8.7` 소스 태그가 가리키는 과거 브리지 코드는 그대로 보존됩니다. 브리지 1.8.7 소스를 확인할 때는 `bridge-v1.8.7` 태그 또는 provenance의 커밋을 사용합니다.

## 업데이트·되돌리기

복구 가능한 HA 백업과 디스크 여유 공간을 확인한 후 앱 스토어를 새로고침하고 SmartThings Web Bridge를 1.8.7로 업데이트합니다. 업데이트 완료 후 앱이 정상 실행 중인지 확인합니다. 기존 통합 1.8.7을 다시 설치할 필요는 없습니다. `/data/chromium-profile` 및 앱 데이터를 삭제하거나 앱을 제거·재설치하지 않습니다.

문제가 생기면 업데이트 전 HA 앱 백업을 복원하거나 이전 1.8.6 패키지로 되돌립니다. 이 저장소 배포는 사용자 HA에 직접 설치·재시작하거나 실제 기기를 동작시키지 않습니다.
'''
(r / 'docs/BRIDGE_1.8.7.md').write_text(notes, encoding='utf-8')
p = r / 'addon/smartthings_web_bridge/CHANGELOG.md'
p.write_text('''## 1.8.7

- 동시 keeper 생성·복구 및 복원 탭 정리를 병합하고, 실패한 Advanced/신규 keeper 탭을 정리합니다. 기존 로그인 프로필·세션 확인·SSO 복구 간격은 유지합니다.
- 기기·위치 별칭의 HMAC 키 캐시(최대 2,048개)와 SQL 문 재사용으로 반복 SQLite 접근을 줄입니다. 캡처 저장·조회·heartbeat·정리도 준비된 SQL 문을 재사용합니다.
- 오래된 capability 조회 실패가 최신 캐시 항목을 삭제하던 경합을 수정했습니다.
- 자동 회귀 테스트 18개를 추가했습니다. 원격 CI와 Chromium/컨테이너 합성 검증은 운영 HA 계정·실기기 검증과 구분합니다.
- 앱/Node/런타임 1.8.7, 기존 HA 통합 1.8.7, protocol 5입니다. 의존성·명령·Scene·Home Monitor·SSE·엔티티 ID는 그대로이며 서버 측 쿠키 만료를 우회하지 않습니다.
- 공개된 통합 v1.8.7 태그/파일은 보존하고 브리지 소스 태그 bridge-v1.8.7 및 새 브리지 패키지·체크섬·provenance를 추가합니다. 업데이트 전 백업을 확보하고 앱 데이터/프로필을 삭제하지 마세요.

''' + p.read_text(encoding='utf-8'), encoding='utf-8')
p = r / 'README.md'
s = p.read_text(encoding='utf-8')
old = '> **현재 상태: `1.8.6` · 실환경 부분 검증**'
assert s.count(old) == 1
s = s.replace(old, '> **현재 버전: Bridge `1.8.7` / HA 통합 `1.8.7` · 기존 실환경 부분 검증, 새 개선분은 CI 검증**')
anchor = '## Scene·Advanced Commands·Galaxy Home Mini TTS'
assert s.count(anchor) == 1
s = s.replace(anchor, '''## Bridge 1.8.7 후속 최적화

이번 후속 배포는 통합 버전만 올리는 작업이 아니라 브리지 자체의 변경입니다. 중복 keeper 복구·탭 누수·SQLite 반복 조회·capability 캐시 경합을 개선하고 회귀 테스트 18개를 추가했습니다. Chromium 쿠키/프로필과 세션 확인·SSO 복구 주기, 기기 제어 및 wire protocol 5는 유지합니다. 실제 사용자 계정의 장시간 세션 유지나 지연 감소를 CI 결과만으로 보장하지 않습니다.

기존 통합 `v1.8.7` 태그와 설치 파일은 보존합니다. 브리지 소스는 `bridge-v1.8.7` 태그, 설치 파일은 기존 `v1.8.7` 릴리스에 추가된 `smartthings-web-bridge-1.8.7.tgz`를 사용합니다. [브리지 변경·검증 범위·업데이트 및 롤백 안내](docs/BRIDGE_1.8.7.md)를 확인하세요.

''' + anchor)
p.write_text(s, encoding='utf-8')
for path in ['addon/smartthings_web_bridge/README.md', 'addon/smartthings_web_bridge/DOCS.md']:
    p = r / path
    p.write_text(p.read_text(encoding='utf-8').rstrip() + '''

## 1.8.7 브리지 최적화

keeper 동시 복구와 실패 탭 정리, 최대 2,048개 HMAC 별칭 캐시, 캡처 SQL 문 재사용 및 capability 캐시 경합 수정이 포함됩니다. 기존 쿠키/Chromium 프로필·로그인/SSO 복구 간격·명령 동작은 그대로입니다. 서버 측 세션 만료를 연장하거나 우회하지 않습니다.

HA 앱 스토어 새로고침 후 1.8.7로 업데이트하고 앱의 실행 상태를 확인하세요. 기존 HACS 통합 1.8.7 재설치는 필요하지 않습니다. 업데이트 전 앱 백업과 디스크 여유 공간을 확보하고 앱 데이터/프로필은 삭제하지 마세요. 문제가 생기면 업데이트 전 앱 백업을 복원하세요.

브리지 소스 태그는 `bridge-v1.8.7`이며 `v1.8.7` 릴리스의 새 `smartthings-web-bridge-1.8.7.tgz`와 전용 체크섬/provenance를 사용합니다. 자동 회귀 검증과 운영 계정의 장시간 세션·실기기 검증은 별개입니다.
''', encoding='utf-8')
p = r / 'CHANGELOG.md'
p.write_text('''## Bridge 1.8.7 후속 배포 — 2026-09-06

실제 브리지 코드 최적화, 회귀 테스트 18개 및 앱/런타임 버전 정합성을 반영했습니다. 기존 통합 v1.8.7 태그·파일·엔티티는 보존합니다. 상세 내용과 검증 한계는 [브리지 변경 문서](docs/BRIDGE_1.8.7.md)를 참조하세요.

''' + p.read_text(encoding='utf-8'), encoding='utf-8')
p = r / 'docs/OPTIMIZATION_2026-09-06.md'
p.write_text('''> 후속 업데이트: 아래의 브리지 1.8.6 유지 설명은 통합 단독 배포 당시의 기록입니다. 이후 브리지 자체 개선은 [Bridge 1.8.7](BRIDGE_1.8.7.md)에 별도로 기록합니다. 기존 통합 태그는 덮어쓰지 않습니다.

''' + p.read_text(encoding='utf-8'), encoding='utf-8')

# SmartThings Web component transaction·가용성 복구 0.1.148 검증 보고서

## 변경 목적

0.1.148은 실제 온라인 기기가 timestamp 없는 Advanced `OFFLINE` 때문에 `unavailable`이 되는 문제와, 화장실 조명처럼 대표 switch 하나 뒤의 여러 switch component가 main 명령 하나로는 동작하지 않는 문제를 함께 수정한다.

## 승인된 동작

- Home Assistant에는 장치당 대표 switch 하나를 유지한다.
- 둘 이상의 Advanced switch component와 모든 capability version이 확인된 비위험 장치만 component transaction을 사용한다.
- 명령은 `main`, 숫자 `switchN`, 나머지 역할 순으로 직렬 실행한다.
- Advanced `/status` 재조회 후 모든 component 값이 요청 값과 일치해야 성공한다.
- dispatch 일부 실패나 status 불일치는 원래 component 벡터로 rollback하며 rollback도 Advanced status로 확인한다.
- 단일 component 장치는 기존 Web native 경로를 유지한다.
- timestamp 없는 Advanced `OFFLINE`은 무시하고, 더 새로운 Location state 또는 성공한 Advanced status를 online 증거로 사용한다.
- 더 새로운 timestamp의 명시적 health `OFFLINE`은 계속 authoritative하다.

공식 SmartThings API, PAT/OAuth/SmartApp/webhook, cookie replay, DOM 상태 스크래핑, optimistic HA mutation은 사용하지 않는다.

## 로컬 후보 검증

2026-09-01 KST 전용 worktree 후보 검증 결과:

- full Vitest: 68 files, 877 tests passed
- Home Assistant Python unittest discovery: 235 tests passed
- `npm run typecheck`: passed
- `npm run build`: passed
- `npm run package:addon`: passed
- add-on package manifest SHA-256: `a6f523d1312724cd45d9ff686bf293950f37cbba50a22413c35174439167c94e`
- `npm run audit:secrets`: passed
- `npm run audit:api-free`: passed
- `npm run audit:fixtures`: passed
- `git diff --check`: passed

이 단계는 로컬 후보 증거이며 HAOS 실기기 동작이나 배포 완료를 뜻하지 않는다.

## HAOS 실기기 검증

아래 항목은 main merge와 `v0.1.148` 발행, HAOS 백업·배포·재부팅 후 기록한다.

- main merge SHA와 GitHub Latest release
- add-on/integration/runtime asset SHA-256
- 배포 전 백업 경로
- Bridge `CONNECTED`, `ready=true`, runtime version
- false-offline 복구 표본과 더 최신 명시적 health-offline 유지 표본
- 화장실 조명 component 원본/반대/rollback 벡터
- 거실 간접등 회귀 명령과 원래 상태 복구
- HA 대표 entity 상태와 secondary entity 비노출

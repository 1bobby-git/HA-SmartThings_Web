# SmartThings Web composite repeat control 0.1.153

## live 원인

0.1.152의 첫 aggregate `turn_on`은 세 child의 Location-native Web 실행과 parent+child Advanced status 확인을 통과했다. 그러나 targeted Advanced `/status` 응답은 전체 device topology를 포함하지 않는데도 DeviceStore가 기존 `advanced` 메타데이터를 대체해 parent의 `childDeviceIds`를 삭제했다. 다음 `turn_off`은 child mapping을 보지 못하고 실패하던 parent Advanced component path로 되돌아가 HTTP 500이 됐다.

실패 직후 세 child를 검증된 개별 HA switch로 꺼서 parent/child all-off를 복구했다.

## 0.1.153 계약

- status-only Advanced refresh는 기존 topology/relationship 메타데이터를 보존한다.
- timestamp correlation이 exact unique일 때 component-child mapping을 학습한다.
- 학습한 alias-only mapping은 별도 SQLite table에 저장하고 Bridge 재시작 뒤 복원한다.
- 새 exact correlation이 있으면 저장된 mapping을 갱신하고, 그렇지 않으면 현재 child topology와 일대일로 일치하는 저장 mapping만 사용한다.
- composite child 실행은 계속 Location-native-only이고 DOM/parent Advanced fallback을 허용하지 않는다.
- 성공은 parent와 모든 child의 Advanced status vector로만 확정한다.

## 로컬 검증

- Vitest: 68 files, 900 tests passed
- Python unittest discovery: 235 tests passed
- TypeScript typecheck, production build, add-on package build passed
- secret/API-free/fixture audits passed
- package manifest SHA-256: `cd4298870cbb7da89c178bb1a8406d1079f5cd765c13108ad83c70bffd029b84`
- independent architecture review: `CLEAR`
- independent code review: `APPROVE`

## HAOS 검증

- 명령 전 parent/child all-off
- parent HA `turn_on` → 세 child Location-native receipt → parent+child all-on
- 같은 runtime에서 parent HA `turn_off` → 세 child Location-native receipt → parent+child all-off
- Bridge 재시작 후 저장 mapping 복원과 parent `turn_on`/`turn_off` 반복 성공
- 최종 상태는 명령 전 all-off와 동일

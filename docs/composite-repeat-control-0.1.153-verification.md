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

릴리스·배포 identity:

- release target: `da4b5180f4893d901d2285db7f067b15586f41b9`
- bridge asset SHA-256: `798ea3b68e18ac24baf8eb632e1cb401404bc71208b10e0e59e578d2249e0215`
- integration asset SHA-256: `1ca2600258b8e2aaed875878f73e67d95de225aef48eb6d9e7bd9226cf33d15a`
- deployed package manifest SHA-256: `cd4298870cbb7da89c178bb1a8406d1079f5cd765c13108ad83c70bffd029b84`
- pre-0.1.153 backup: `/mnt/data/ha-smartthings-web-backups/da4b5180f489-pre-0.1.153`
- backup SHA-256: add-on `7e8fc927f0dabd8263e7859053db70190f68366a3d9b3d85cba21dca5a03be32`, integration `2c5c98ce09b1ded3720a0e3b4abfaa5941f22b6c7dfbe227c6e92cc896bd660a`, registries `c7f76a79fad78062979c5415ab0d72842d6657668dbdfd881d6266b1ade8514f`, SQLite `bcdf2d25affe33ddf7bf47d472583f8244a5f74d6959f146d4543646b19e3353`
- Core config check passed; Core start changed to `2026-09-01T02:44:09.66609883Z`; external root/API returned 200/401.

live command proof:

- 명령 전 parent/child와 HA 네 switch 모두 all-off였다.
- 0.1.152 실패 후 개별 off 복구 timestamp는 exact correlation이 두 개라 첫 0.1.153 command가 실행 전 fail closed했다. `command_route`/`command_component` dispatch는 없었다.
- 이전 reversible physical child probe로 확인한 alias-only `switch2→dev_145`, `switch3→dev_116`, `switch4→dev_117` 매핑을 새 SQLite table에 seed하고 Bridge를 재시작했다.
- 재시작 후 저장 row가 복원된 상태에서 parent HA `turn_on`은 HTTP 200, 세 child와 parent 전체가 on이었다.
- targeted parent+child status 확인 뒤에도 parent `childDeviceIds`가 유지됐다.
- 같은 runtime의 parent HA `turn_off`도 HTTP 200, 세 child와 parent 전체가 off였다.
- 로그에는 `location_native` attempt/accepted 6쌍만 있었고 DOM 또는 parent component dispatch는 없었다.
- 최종 health는 `CONNECTED`, ready true, active connections 2, adapter/protocol/detail failure 0, DOM fallback 0, transport `location_native`, confirmation `CONFIRMED_BY_STATUS`였다.
- 최종 상태는 명령 전 all-off와 동일하며, parent용 switch는 `switch.hwajangsil_jomyeong` 하나만 유지됐다.
- liveness 회귀도 유지됐다: `dev_324` online 및 라탄 색온도 `2732`; `dev_165`, `dev_169`, `dev_321`은 기존 명시적 offline 증거에 따라 offline이다.

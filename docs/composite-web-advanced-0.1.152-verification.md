# SmartThings Web composite Web execution·Advanced verification 0.1.152

## live 근거

0.1.150 parent direct `/commands`와 0.1.151 첫 mapped child direct `/commands`는 모두 sanitized capture에서 HTTP 404 `Not Found`였다. 반면 같은 child의 HA switch는 관찰된 Location-native control로 HTTP 200과 Location event 확인을 통과했다.

확인된 관계:

- parent `switch2` ↔ child `dev_145` main
- parent `switch3` ↔ child `dev_116` main
- parent `switch4` ↔ child `dev_117` main
- parent `main`은 child aggregate state

## 0.1.152 계약

- exact unique 900ms 매핑을 통과한 child만 stable role 순서로 실행한다.
- 실행 transport는 각 child의 observed Location-native Web control이다.
- composite child 실행에서는 DOM fallback을 허용하지 않는다.
- 일부 실행 실패는 완료된 child를 원래 값으로 역순 rollback한다.
- parent와 모든 child Advanced `/status`가 desired vector와 일치해야 성공한다.
- timeout 후 rollback도 parent와 모든 child Advanced `/status`로 original vector를 확인한다.
- mapping/control 누락은 parent fallback 없이 `unsupported_command`로 닫는다.

## 로컬 검증

- Vitest: 68 files, 898 tests passed
- Python unittest discovery: 235 tests passed
- TypeScript typecheck, production build, add-on package build passed
- secret/API-free/fixture audits passed
- package manifest SHA-256: `7dc715ac613227a5436da7fa6be1d4ab5edfcba10683deebc0dc226459cef31f`
- independent architecture review: `CLEAR`
- independent code review: `APPROVE`

## HAOS 검증

- 명령 전 parent/child all-off
- parent HA `turn_on` → child Web receipt → parent+child Advanced status all-on → HA parent on
- parent HA `turn_off` → parent+child Advanced status all-off → HA parent off
- 최종 상태는 명령 전 all-off와 동일해야 한다.

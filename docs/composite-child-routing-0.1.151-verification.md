# SmartThings Web composite child routing 0.1.151 검증 보고서

## 확인된 live 원인

0.1.150 화장실 aggregate `turn_on`은 `dispatch ordinal 1 / response_invalid`였다. sanitized capture는 parent `/commands`가 HTTP 404 `Not Found`임을 증명했다.

`dev_144`는 parent aggregate이고 세 실제 writable child를 가진다.

- parent `switch2` ↔ child `dev_145` main
- parent `switch3` ↔ child `dev_116` main
- parent `switch4` ↔ child `dev_117` main
- parent `main`은 child 중 하나라도 on이면 on이 되는 aggregate state이며 직접 command target이 아니다.

매핑은 raw ID나 이름에 의존하지 않고 parent secondary와 child main state의 동일 값·900ms 이내 timestamp를 사용한다. 전체 일대일 조합을 열거해 완전한 매핑이 정확히 하나일 때만 활성화하며, 점수가 더 좋은 후보가 있어도 두 번째 완전 매핑이 존재하면 거부한다.

## 제어·검증 계약

- stable role order `switch2`, `switch3`, `switch4`로 child Advanced command를 직렬 실행한다.
- 각 child와 parent의 Advanced `/status`를 모두 읽는다.
- child main desired vector와 parent main/secondary desired vector가 모두 일치해야 성공한다.
- dispatch/status 실패는 child 원래 값으로 rollback하고 parent 원래 vector까지 확인한다.
- 누락·모호·offline·위험 child 또는 capability version 부재는 parent fallback 없이 `unsupported_command`로 fail closed한다.

## 로컬 검증

- full Vitest: 68 files, 896 tests passed
- Home Assistant Python unittest discovery: 235 tests passed
- `npm run typecheck`: passed
- `npm run build`: passed
- `npm run package:addon`: passed
- add-on package manifest SHA-256: `b1f70447877e5c5af2327776521c86b3f1d6a00ca73b9225ddd8e9236a8f8eb8`
- `npm run audit:secrets`: passed
- `npm run audit:api-free`: passed
- `npm run audit:fixtures`: passed
- `git diff --check`: passed

## HAOS 검증

- 명령 전 원본: parent/child 모두 off
- child 관계 probe는 각 child on→off 후 원래 all-off 복구 완료
- 0.1.151 배포 후 parent HA switch `turn_on` → child status와 parent vector 모두 on → `turn_off` → 모두 off를 요구한다.

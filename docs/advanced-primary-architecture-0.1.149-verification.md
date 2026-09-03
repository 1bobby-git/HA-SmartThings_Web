# SmartThings Web restored liveness 0.1.149 검증 보고서

## 변경 목적

0.1.148 live 배포 후 Bridge restart 전에 저장된 최신 정상 Location state가 health offline보다 새로워도 복원 단계에서 재평가되지 않아 `dev_324` 같은 장치가 계속 offline으로 남는 것을 확인했다.

0.1.149는 offline으로 저장된 장치만 대상으로 persisted `LOCATION_EVENT`와 `COMMAND_STATUS_RECHECK` timestamp를 health evidence와 다시 비교한다. 더 최신의 정상 evidence가 있으면 online과 liveness timestamp를 함께 복구하고 즉시 normalized inventory에 다시 저장한다.

값 자체가 `offline`, `unavailable`, `disconnected`, `not connected`인 state는 positive evidence로 사용하지 않는다. 따라서 `dev_165/169`의 명시적 offline 상태나 더 최신 health offline 표본을 online으로 위장하지 않는다.

0.1.148의 Advanced component transaction, bounded device-status verification, idempotent original-vector rollback, dangerous-device exclusion과 공식 API 무사용 경계는 유지한다.

## 로컬 검증

- full Vitest: 68 files, 887 tests passed
- Home Assistant Python unittest discovery: 235 tests passed
- `npm run typecheck`: passed
- `npm run build`: passed
- `npm run package:addon`: passed
- add-on package manifest SHA-256: `185d37a72404b5d6ccf6cbe79b259bacd4cde3afd1e32142a0b1600b631569de`
- `npm run audit:secrets`: passed
- `npm run audit:api-free`: passed
- `npm run audit:fixtures`: passed
- `git diff --check`: passed
- final cleanup/review 결과는 merge 전 기록한다.

## HAOS 검증

- Supervisor pre-deploy backup: `cf5c1525`
- manual backup: `/mnt/data/ha-smartthings-web-backups/ed9f49253116-4e6ac9c1359f`
- 0.1.148 배포 후 발견된 live 표본: `dev_324` health `2026-08-29T12:16:26.043Z`, 정상 Location colorTemperature `2026-08-31T16:41:26.902Z`, 그러나 restart 후 offline 유지
- 0.1.149 배포 후 `dev_324` online 복구, `dev_165/169` explicit offline 유지, `dev_321` newer health offline 유지 여부를 기록한다.
- 화장실 조명 원본 벡터 `main=off, switch2=off, switch3=on, switch4=on`에서 반대 aggregate 상태와 원래 벡터 복구를 Advanced status와 HA 대표 switch로 검증한다.

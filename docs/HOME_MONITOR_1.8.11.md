## 1.8.11

- 사용자 제공 실제 `section.homecard.security` / `.status-container .actions button` 구조로 Home Monitor를 제어합니다. `data-armstate`와 실제 버튼 의미를 검증하고, 문구·방패 로고·위치 Home 메뉴는 클릭하지 않습니다. 경비 중 Disarm 버튼 하나도 즉시 처리해 기존 5초 반복 탐색을 제거합니다.
- 외출↔실내 전환 요청은 같은 위치·같은 페이지·하나의 잠금 안에서 Disarm → 새 해제 상태 확인 → 요청 경비 버튼 → 최종 상태 확인 순서로 실행합니다. 중간 해제는 성공 응답이 아니며, 각 단계는 최대 한 번 클릭합니다.
- 중요: 모드 간 전환에는 짧은 경비 해제 구간이 있으며, 다음 단계가 실패하면 해제 상태에 남을 수 있습니다. 단계별 오류와 실제 상태를 전달하고 임의 재전송·자동 복원·낙관적 상태 변경은 하지 않습니다. 알려지지 않은 상태/레이아웃에서는 자동 해제하지 않습니다.
- 중간 해제 전에 수신된 최종 모드 증거는 폐기하고, 해제 확인 후 새로 구독합니다. 두 단계는 기존 명령 확인 제한을 공유하며, 다른 위치·오래된 캐시·해제 확인 실패로 다음 단계를 진행하지 않습니다.
- 실제 버튼의 보임·활성·가림·중복을 검사합니다. 포인터를 보내지 않는 trial 검사만 재확인할 수 있고, 실제 클릭의 결과가 불확실하면 같은 명령을 다시 클릭하지 않습니다.
- 기존 Scene/Advanced commands/speak, 로그인 프로필, 영역 연결, 개별 스위치, 엔티티 ID 및 protocol 5는 유지합니다. 새 네이티브 카드 회귀와 전체 CI는 합성 검증이며 실제 Samsung 계정의 성공률·지연은 별도 확인 대상입니다.

### Evidence and validation scope

The user supplied the actual native card DOM, a DISARMED action button, and successful manual Disarm → Arm (stay). Armed away/stay cards contain only Disarm. The historical log shows a 5-second single-action probe delay and later missing-selector failures. No new live account command was executed during development. Fixtures contain no user camera images, location IDs, cookies or tokens.

The status captions and button layout are verified separately. Enum action attributes are checked at runtime; arming buttons may also use the exact localized labels in an identified native card. Unsupported/contradictory layouts, overlays, duplicates, disabled controls and route changes fail without speculative clicks.

The existing final confirmation remains authoritative. Each intermediate stage subscribes before dispatch and only accepts fresh exact-location evidence. A matching cache or a changed DOM alone cannot authorize rearming. Stage error paths refresh HA from the real Bridge inventory once and leave the actual state visible. No control is sent twice.

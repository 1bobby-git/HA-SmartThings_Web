# SmartThings Web 서비스 UI 사용법

이 문서는 Home Assistant 화면에서 `smartthings_web` 서비스를 실행하는 방법을 설명합니다. 모든 명령은 로그인된 SmartThings Web Bridge를 통해 실행되며, Advanced catalog에 안전하게 노출된 command만 사용할 수 있습니다.

## 화면 경로

```text
Home Assistant
  -> 개발자 도구
  -> 작업
  -> 작업 선택: smartthings_web.<service>
  -> 필드 입력
  -> 작업 수행
```

일반적으로 `device_id`는 화면의 장치 선택기를 사용합니다. Bridge alias인 `dev_N` 값을 알고 있다면 작업 화면의 YAML 모드에서 직접 입력할 수 있습니다.

## 먼저 명령 목록 확인

`smartthings_web.list_commands`는 한 장치에서 실행 가능한 Advanced command catalog를 반환합니다. 실제 command를 실행하기 전에 먼저 필터 없이 호출해서 `component`, `capability`, `command`, `arguments`를 확인합니다. 일부 장치는 raw SmartThings 값 대신 `identifier_*` alias로 표시되므로, 응답에 나온 값을 그대로 복사해야 합니다.

| 필드 | 필수 | 값 |
| --- | --- | --- |
| `device_id` | 예 | Home Assistant 장치 선택 또는 `dev_N` |
| `component` | 아니오 | 예: `main` |
| `capability` | 아니오 | 예: `speechSynthesis` |

YAML 예시:

```yaml
action: smartthings_web.list_commands
data:
  device_id: dev_204
```

필터는 첫 응답에서 정확한 값을 확인한 뒤 사용합니다.

```yaml
action: smartthings_web.list_commands
data:
  device_id: dev_204
  component: identifier_component_main
  capability: identifier_74292182f118
```

응답에서 봐야 할 항목:

| 응답 항목 | 의미 |
| --- | --- |
| `commands[].component` | Advanced command를 보낼 component |
| `commands[].capability` | Advanced capability |
| `commands[].command` | 실행할 command 이름 |
| `commands[].arguments` | 필요한 입력값 이름과 schema |
| `omissions` | 안전 정책이나 schema 문제로 제외된 command 수 |

## 일반 command 실행

`smartthings_web.execute_command`는 catalog에 있는 정확한 command를 실행합니다. 이 서비스는 Advanced-only로 동작하며, catalog에 없는 command나 위험 command로 fallback하지 않습니다.

| 필드 | 필수 | 값 |
| --- | --- | --- |
| `device_id` | 예 | Home Assistant 장치 선택 또는 `dev_N` |
| `component` | 예 | 기본값 `main` |
| `capability` | 예 | `list_commands` 응답의 capability |
| `command` | 예 | `list_commands` 응답의 command |
| `arguments` | 아니오 | command 인자 배열 |
| `confirm` | 아니오 | 상태 확인 필요 여부, 기본 `true` |
| `timeout` | 아니오 | 확인 대기 시간, 1-120초 |

예시:

```yaml
action: smartthings_web.execute_command
data:
  device_id: dev_204
  component: identifier_component_main
  capability: identifier_74292182f118
  command: speak
  arguments:
    - 안녕하세요
  confirm: true
  timeout: 30
```

## Galaxy Home Mini TTS

Galaxy Home Mini처럼 `speechSynthesis.speak`를 제공하는 장치는 전용 `smartthings_web.speak` 서비스를 쓰는 것이 가장 간단합니다. 이 서비스는 raw capability ID를 입력하지 않아도 되고, 안전한 `speechSynthesis.speak` descriptor가 정확히 하나일 때만 실행합니다.

| 필드 | 필수 | 값 |
| --- | --- | --- |
| `device_id` | 예 | Galaxy Home Mini 장치 선택 또는 `dev_N` |
| `phrase` | 예 | 말할 문구, 1-1024자 |
| `timeout` | 아니오 | 확인 대기 시간, 1-120초 |

예시:

```yaml
action: smartthings_web.speak
data:
  device_id: dev_204
  phrase: 안녕하세요
  timeout: 30
```

문구에 제어 문자, 줄바꿈 문자, 1024자를 넘는 텍스트가 있으면 Home Assistant 서비스 schema에서 거부됩니다. Galaxy Home Mini의 live Advanced schema는 `maxLength: 1000`으로 관찰되었고, Bridge catalog의 `maxLength`가 더 짧으면 그 값도 실행 시 적용됩니다.

## 운영 서비스

상태가 오래되었거나 realtime 연결을 다시 잡아야 할 때 아래 서비스를 사용할 수 있습니다.

| 서비스 | 용도 | 주요 필드 |
| --- | --- | --- |
| `smartthings_web.reload_inventory` | Advanced inventory 전체 재동기화 | 없음 |
| `smartthings_web.refresh_device` | 장치의 관찰된 refresh command 실행 | `device_id` |
| `smartthings_web.reconnect_realtime` | Location realtime keeper 재연결 후 재동기화 | 없음 |

예시:

```yaml
action: smartthings_web.reload_inventory
data: {}
```

```yaml
action: smartthings_web.refresh_device
data:
  device_id: dev_204
```

```yaml
action: smartthings_web.reconnect_realtime
data: {}
```

## 읽기 전용 모드와 안전 차단

통합 옵션이 read-only이면 쓰기 서비스는 장치를 바꾸지 않습니다. `list_commands`처럼 catalog를 읽는 작업은 확인용으로 사용할 수 있습니다.

다음 command 계열은 catalog에 보여도 실행 대상에서 제외되거나 실패합니다.

- door lock, garage, valve, security, alarm, siren처럼 안전 위험이 있는 command
- PIN, token, secret 등 민감 인자를 요구하는 command
- raw UUID, cookie, CSRF, session 값을 노출하는 schema
- `pattern`, `items`, `properties` 같은 복잡한 raw JSON schema
- Advanced catalog에 없는 임의 command

## 자주 보는 오류

| 오류 | 의미 | 확인할 것 |
| --- | --- | --- |
| `command_control_not_found` | matching command가 없음 | `list_commands`에서 component/capability/command 확인 |
| `command_control_ambiguous` | 같은 목적 command가 2개 이상임 | `execute_command`로 정확한 component/capability 지정 |
| `invalid_arguments` | 인자 타입, 길이, enum이 맞지 않음 | `commands[].arguments[].schema` 확인 |
| `unsupported_command` | 안전 정책 또는 catalog 계약에서 차단됨 | 위험 command, 민감 인자, schema omission 확인 |
| `bridge_not_connected` | Bridge가 연결되지 않음 | Add-on UI에서 `CONNECTED`와 `ready=true` 확인 |

## 권장 순서

1. `list_commands`로 장치별 command catalog를 확인합니다.
2. TTS는 raw capability 값을 직접 넣지 않아도 되는 `speak`를 먼저 사용합니다.
3. `speak`로 표현할 수 없는 command는 `execute_command`에 catalog 값을 그대로 넣습니다.
4. 실행 실패 시 `reload_inventory` 후 다시 `list_commands`를 확인합니다.
5. realtime 상태가 끊긴 것 같으면 `reconnect_realtime`을 실행하고 상태 갱신을 확인합니다.

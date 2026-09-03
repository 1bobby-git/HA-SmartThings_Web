# 로컬 SmartThings Web Bridge 업데이트

## 업데이트가 표시되지 않는 이유

Home Assistant에 설치된 앱 ID가 `local_smartthings_web_bridge`라면 GitHub 앱 저장소에서 설치한 앱이 아니라 `/addons`의 파일을 사용하는 **로컬 앱**입니다.

로컬 앱의 **업데이트 확인**과 **업데이트**는 GitHub 릴리스 파일을 자동으로 내려받지 않습니다. `/addons`에 남아 있는 `config.yaml`이 이전 버전이면 앱 화면에도 계속 이전 버전만 표시됩니다.

`http://local-smartthings-web-bridge:8100` 주소를 유지하려면 로컬 앱 설치를 유지해야 하므로, 새 릴리스 패키지를 `/addons`에 먼저 동기화한 뒤 Supervisor 업데이트를 실행해야 합니다.

## 0.1.168로 업데이트

Home Assistant의 **Terminal & SSH** 앱에서 다음 명령을 한 줄로 실행합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/1bobby-git/HA-SmartThings_Web/main/tools/update-local-addon.sh -o /tmp/update-smartthings-web-bridge.sh && bash /tmp/update-smartthings-web-bridge.sh 0.1.168
```

스크립트는 다음 작업을 수행합니다.

1. `/addons`에서 `slug: smartthings_web_bridge`인 실제 로컬 앱 폴더를 찾습니다.
2. GitHub의 `smartthings-web-bridge-0.1.168.tgz`를 내려받습니다.
3. 릴리스 SHA-256 `a1d6aadfc6dbe17105f527b9c25c7795aebb5c2885a0b701b6bd0144750375d5`를 검증합니다.
4. 기존 소스를 `/share/smartthings-web-bridge-backups`에 백업합니다.
5. 로컬 앱 소스를 0.1.168 패키지로 교체합니다.
6. `ha addons reload`와 `ha addons update local_smartthings_web_bridge`를 실행합니다.

완료 후 다음 명령으로 설치 버전을 확인합니다.

```bash
ha addons info local_smartthings_web_bridge
```

출력의 `version`과 `version_latest`가 `0.1.168`인지 확인한 다음 Bridge 앱을 시작하고 Home Assistant를 재시작합니다.

## 주의사항

- 백업 폴더를 `/addons` 아래에 만들면 같은 slug가 중복 검색될 수 있으므로 스크립트는 `/share`에 백업합니다.
- 기존 Samsung 로그인 프로필과 앱 옵션은 Supervisor의 앱 데이터 영역에 있으므로 `/addons` 소스 교체 대상에 포함되지 않습니다.
- 앱 ID가 `d55cafb9_smartthings_web_bridge`이면 저장소 설치 앱이므로 이 스크립트를 사용하지 말고 앱 스토어의 업데이트 기능을 사용합니다.

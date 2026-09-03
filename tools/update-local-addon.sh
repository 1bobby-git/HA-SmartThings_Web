#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="1bobby-git/HA-SmartThings_Web"
TARGET_VERSION="${1:-0.1.168}"
ADDON_SLUG="${SMARTTHINGS_WEB_ADDON_SLUG:-local_smartthings_web_bridge}"
ADDONS_ROOT="${SMARTTHINGS_WEB_ADDONS_ROOT:-/addons}"
BACKUP_ROOT="${SMARTTHINGS_WEB_BACKUP_ROOT:-/share/smartthings-web-bridge-backups}"
HA_BIN="${SMARTTHINGS_WEB_HA_BIN:-ha}"
TAG="v${TARGET_VERSION}"
ASSET_NAME="smartthings-web-bridge-${TARGET_VERSION}.tgz"
ASSET_URL="${SMARTTHINGS_WEB_BRIDGE_ASSET_URL:-https://github.com/${REPOSITORY}/releases/download/${TAG}/${ASSET_NAME}}"
EXPECTED_SHA256="${SMARTTHINGS_WEB_BRIDGE_SHA256:-}"

case "${TARGET_VERSION}" in
  0.1.168)
    EXPECTED_SHA256="${EXPECTED_SHA256:-a1d6aadfc6dbe17105f527b9c25c7795aebb5c2885a0b701b6bd0144750375d5}"
    ;;
esac

for command_name in curl tar sha256sum find grep cp; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "필수 명령을 찾을 수 없습니다: ${command_name}" >&2
    exit 1
  }
done
command -v "${HA_BIN}" >/dev/null 2>&1 || {
  echo "Home Assistant CLI를 찾을 수 없습니다: ${HA_BIN}" >&2
  exit 1
}

[[ -d "${ADDONS_ROOT}" ]] || {
  echo "이 스크립트는 Home Assistant OS/Supervised의 Terminal & SSH 앱에서 실행해야 합니다: ${ADDONS_ROOT} 없음" >&2
  exit 1
}

addon_dirs=()
while IFS= read -r -d '' config_path; do
  if grep -Eq '^[[:space:]]*slug:[[:space:]]*smartthings_web_bridge[[:space:]]*(#.*)?$' "${config_path}"; then
    addon_dir="$(dirname "${config_path}")"
    duplicate=false
    for existing in "${addon_dirs[@]:-}"; do
      if [[ "${existing}" == "${addon_dir}" ]]; then
        duplicate=true
        break
      fi
    done
    [[ "${duplicate}" == true ]] || addon_dirs+=("${addon_dir}")
  fi
done < <(find "${ADDONS_ROOT}" -mindepth 2 -maxdepth 4 -type f \( -name config.yaml -o -name config.yml \) -print0)

if [[ ${#addon_dirs[@]} -eq 0 ]]; then
  echo "slug가 smartthings_web_bridge인 로컬 앱 소스를 ${ADDONS_ROOT}에서 찾지 못했습니다." >&2
  exit 1
fi
if [[ ${#addon_dirs[@]} -ne 1 ]]; then
  echo "동일한 slug를 가진 로컬 앱 폴더가 여러 개입니다. /addons 밖으로 백업 폴더를 옮긴 뒤 다시 실행하세요." >&2
  printf ' - %s\n' "${addon_dirs[@]}" >&2
  exit 1
fi

ADDON_DIR="${addon_dirs[0]}"
CURRENT_VERSION="$(awk -F: '/^[[:space:]]*version:/ {gsub(/[[:space:]\"]/, "", $2); print $2; exit}' "${ADDON_DIR}/config.yaml")"
TMP_DIR="$(mktemp -d /tmp/smartthings-web-bridge-update.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT
ARCHIVE="${TMP_DIR}/${ASSET_NAME}"
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"

echo "로컬 앱 소스: ${ADDON_DIR}"
echo "현재 소스 버전: ${CURRENT_VERSION:-unknown}"
echo "설치할 버전: ${TARGET_VERSION}"

curl -fL --retry 3 --connect-timeout 20 --max-time 300 \
  "${ASSET_URL}" -o "${ARCHIVE}"

if [[ -z "${EXPECTED_SHA256}" ]] && command -v jq >/dev/null 2>&1; then
  release_json="${TMP_DIR}/release.json"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 60 \
    "https://api.github.com/repos/${REPOSITORY}/releases/tags/${TAG}" \
    -o "${release_json}"
  EXPECTED_SHA256="$(jq -r --arg name "${ASSET_NAME}" '.assets[] | select(.name == $name) | (.digest // "")' "${release_json}" | sed 's/^sha256://')"
fi

[[ -n "${EXPECTED_SHA256}" ]] || {
  echo "릴리스 SHA-256을 확인할 수 없습니다. SMARTTHINGS_WEB_BRIDGE_SHA256 환경변수로 전달하세요." >&2
  exit 1
}

echo "${EXPECTED_SHA256}  ${ARCHIVE}" | sha256sum -c -
tar -tzf "${ARCHIVE}" >/dev/null
tar -xzf "${ARCHIVE}" -C "${EXTRACT_DIR}"
PACKAGE_DIR="${EXTRACT_DIR}/smartthings_web_bridge"
[[ -f "${PACKAGE_DIR}/config.yaml" ]] || {
  echo "릴리스 패키지 구조가 올바르지 않습니다." >&2
  exit 1
}
if find "${PACKAGE_DIR}" -type l -print -quit | grep -q .; then
  echo "심볼릭 링크가 포함된 패키지는 설치하지 않습니다." >&2
  exit 1
fi

grep -Eq "^[[:space:]]*version:[[:space:]]*${TARGET_VERSION}[[:space:]]*$" "${PACKAGE_DIR}/config.yaml" || {
  echo "패키지 config.yaml 버전이 ${TARGET_VERSION}과 일치하지 않습니다." >&2
  exit 1
}

mkdir -p "${BACKUP_ROOT}"
BACKUP_FILE="${BACKUP_ROOT}/$(basename "${ADDON_DIR}")-${CURRENT_VERSION:-unknown}-$(date +%Y%m%d-%H%M%S).tgz"
tar -C "$(dirname "${ADDON_DIR}")" -czf "${BACKUP_FILE}" "$(basename "${ADDON_DIR}")"
echo "기존 소스 백업: ${BACKUP_FILE}"

find "${ADDON_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "${PACKAGE_DIR}/." "${ADDON_DIR}/"

"${HA_BIN}" addons reload
"${HA_BIN}" addons update "${ADDON_SLUG}"

echo "SmartThings Web Bridge 로컬 앱을 ${TARGET_VERSION}으로 업데이트했습니다."
"${HA_BIN}" addons info "${ADDON_SLUG}" || true

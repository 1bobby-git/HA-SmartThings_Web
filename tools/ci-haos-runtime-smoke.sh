#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="$(python - <<'PY'
from pathlib import Path
for line in Path('addon/smartthings_web_bridge/config.yaml').read_text(encoding='utf-8').splitlines():
    if line.startswith('version: '):
        print(line.split(':', 1)[1].strip())
        break
else:
    raise SystemExit('missing add-on version')
PY
)"
image="smartthings-web:${version}-runtime-smoke"
work_root="${RUNNER_TEMP:-/tmp}/stw-runtime-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
containers=()

cleanup() {
  for container_name in "${containers[@]:-}"; do
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  done
  sudo rm -rf "$work_root" >/dev/null 2>&1 || rm -rf "$work_root" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$work_root"
if [[ ! -x node_modules/.bin/tsx ]]; then
  npm ci
fi
npm run package:addon

docker build --progress=plain \
  --build-arg BUILD_ARCH=amd64 \
  --build-arg BUILD_VERSION="$version" \
  -f dist-addon/smartthings_web_bridge/Dockerfile \
  -t "$image" \
  dist-addon/smartthings_web_bridge

wait_for_runtime() {
  local container_name="$1"
  local attempt
  for attempt in $(seq 1 240); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != "true" ]]; then
      return 1
    fi
    if docker exec "$container_name" sh -c \
      'curl -fsS --max-time 2 http://127.0.0.1:8098/ >/dev/null && ps -eo args | grep -E "[/]ms-playwright/.*/chrome .*--user-data-dir=/data/chromium-profile" >/dev/null && DISPLAY=:99 xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -Eq "0x[0-9a-fA-F]+"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

run_case() {
  local case_name="$1"
  local data_dir="$work_root/$case_name"
  local container_name="stw-runtime-${case_name//[^a-zA-Z0-9_.-]/-}-${GITHUB_RUN_ID:-$$}"
  local log_file="$work_root/$case_name.log"

  containers+=("$container_name")
  mkdir -p "$data_dir/chromium-profile/Default" "$data_dir/downloads" "$data_dir/camera-images"
  printf '%s\n' '{"log_level":"info","dom_fallback_enabled":true,"command_confirmation_timeout":30,"status_recheck_enabled":true,"inventory_reconciliation_interval":21600,"debug_protocol_logging":false}' > "$data_dir/options.json"

  case "$case_name" in
    clean)
      ;;
    root-owned-profile)
      mkdir -p "$data_dir/chromium-profile/Default/Service Worker/CacheStorage/nested"
      printf x > "$data_dir/chromium-profile/Default/Service Worker/CacheStorage/nested/cache"
      ;;
    invalid-sqlite-directory)
      mkdir -p "$data_dir/bridge.sqlite/unexpected"
      printf x > "$data_dir/bridge.sqlite/unexpected/file"
      ;;
    invalid-sqlite-header)
      printf 'not-a-sqlite-database' > "$data_dir/bridge.sqlite"
      ;;
    empty-secret)
      : > "$data_dir/bridge-secret"
      ;;
    *)
      echo "Unknown runtime smoke case: $case_name" >&2
      return 2
      ;;
  esac

  chmod 0700 "$data_dir" "$data_dir/chromium-profile" "$data_dir/downloads" "$data_dir/camera-images"
  chmod 0600 "$data_dir/options.json"
  if [[ "$case_name" == "root-owned-profile" ]]; then
    sudo chown -R 0:0 "$data_dir/chromium-profile"
  fi

  docker run -d \
    --name "$container_name" \
    --cap-drop=FOWNER \
    --shm-size=1g \
    -v "$data_dir:/data" \
    "$image" >/dev/null

  if ! wait_for_runtime "$container_name"; then
    docker logs "$container_name" > "$log_file" 2>&1 || true
    cat "$log_file" >&2
    docker exec "$container_name" sh -c 'ps -eo user,pid,ppid,stat,comm,args --sort=pid; echo ====; find /data -maxdepth 3 -printf "%M %u:%g %p -> %l\n" | sort' >&2 || true
    return 1
  fi

  docker logs "$container_name" > "$log_file" 2>&1 || true
  grep -q 'data_prep:ready' "$log_file"
  grep -q 'bridge_init:http_server_ready:8098' "$log_file"
  if grep -q 'data_prep:failed:' "$log_file"; then
    cat "$log_file" >&2
    return 1
  fi
  if grep -q 'browser_launch_failed:' "$log_file"; then
    cat "$log_file" >&2
    return 1
  fi

  case "$case_name" in
    invalid-sqlite-directory|invalid-sqlite-header)
      sudo test -f "$data_dir/bridge.sqlite"
      sudo test ! -d "$data_dir/bridge.sqlite"
      test -n "$(sudo find "$data_dir/recovery" -mindepth 1 -maxdepth 1 -name '*bridge.sqlite*' -print -quit 2>/dev/null)"
      ;;
    empty-secret)
      sudo python - "$data_dir/bridge-secret" <<'PY'
from pathlib import Path
import sys
secret = Path(sys.argv[1]).read_text(encoding='utf-8').strip()
if not 32 <= len(secret) <= 512:
    raise SystemExit('bridge secret was not repaired')
PY
      ;;
  esac

  docker rm -f "$container_name" >/dev/null
}

for case_name in clean root-owned-profile invalid-sqlite-directory invalid-sqlite-header empty-secret; do
  echo "===== runtime smoke: $case_name ====="
  run_case "$case_name"
done

echo "HAOS runtime smoke passed for version $version"

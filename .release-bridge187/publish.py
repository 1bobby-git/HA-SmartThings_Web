"""Publish only validated Bridge 1.8.7; preserve integration assets and tag."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import subprocess
import tarfile
import urllib.request

REPO = '1bobby-git/HA-SmartThings_Web'
BASE = 'aa7000eec7b0d095b6baf669c20784e045f2eba2'
DRIVER = 'b44fa65165354b3acc3a1bd490b1a6a3d02e98e5'
RUN = 34006540110
RID = 383412694
TAG = 'bridge-v1.8.7'
ASSET = 'smartthings-web-bridge-1.8.7.tgz'
ROOT = Path(os.environ['RUNNER_TEMP']) / 'bridge187-publish'
ROOT.mkdir(exist_ok=True)
OLD = {
    'smartthings_web.zip': 'fc1bd365fd9c77ba4e2e3b663caa13158710fa697c7bdce7042e84d61fdfcb81',
    'smartthings-web-integration-1.8.7.tgz': '89655a746335fb6ce35f2205f399fb0a92285b3841646ebaabc67635d08a4e43',
    'smartthings-web-bridge-1.8.6.tgz': '30afbe41ed23e982965843713afbdf0b458c2b4233746257e859e88a08ad9b31',
    'SHA256SUMS.txt': '766e2f5fce596f63513c07b01f4139a30761222e2790ff5828efff7041a8a420',
}

def sh(*args):
    return subprocess.check_output(args, text=True).strip()

def api(path, value=None):
    args = ['gh', 'api', path]
    if value is not None:
        payload = ROOT / 'request.json'
        payload.write_text(json.dumps(value), encoding='utf-8')
        args += ['--method', 'PATCH', '--input', str(payload)]
    return json.loads(sh(*args))

def check(condition, message):
    if not condition:
        raise RuntimeError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def released():
    obj = api(f'repos/{REPO}/releases/{RID}')
    check(obj['tag_name'] == 'v1.8.7' and not obj['draft'] and not obj['prerelease'], 'unexpected integration release')
    check(not obj.get('immutable'), 'release is immutable; do not replace it')
    return obj

def main_ref():
    branch = api(f'repos/{REPO}/branches/main')
    check(not branch['protected'], 'branch became protected; use normal review process')
    return branch['commit']['sha']

def verify_old(obj):
    by_name = {a['name']: a for a in obj['assets']}
    for name, expected in OLD.items():
        check(by_name.get(name, {}).get('digest') == 'sha256:' + expected, f'old asset changed: {name}')
    return {name: by_name[name]['id'] for name in OLD}

run = api(f'repos/{REPO}/actions/runs/{RUN}')
check(run['head_sha'] == DRIVER and run['status'] == 'completed' and run['conclusion'] == 'success', 'validation run not passed or wrong source')
jobs = api(f'repos/{REPO}/actions/runs/{RUN}/jobs')['jobs']
check({j['name'] for j in jobs} == {'native', 'runtime'}, 'unexpected validation jobs')
check(all(j['conclusion'] == 'success' for j in jobs), 'required validation failed')
check(main_ref() == BASE, 'main changed; rebase and revalidate, never force')
check(not any(r['enforcement'] == 'active' for r in api(f'repos/{REPO}/rulesets?includes_parents=true')), 'active rules require reviewed publication')
original_release = released()
old_ids = verify_old(original_release)
original_tag = api(f'repos/{REPO}/git/ref/tags/v1.8.7')['object']
check(original_tag['type'] == 'commit' and original_tag['sha'] == BASE, 'integration tag unexpectedly changed')
check(sh('git', 'rev-parse', 'HEAD') == BASE, 'wrong checkout')
subprocess.run(['gh', 'run', 'download', str(RUN), '--repo', REPO, '--name', 'bridge187-native-evidence', '--dir', str(ROOT / 'evidence')], check=True)
ev = ROOT / 'evidence'
validation = json.loads((ev / 'validation.json').read_text())
check(validation['base'] == BASE and validation['driver'] == DRIVER and str(validation['run']) == str(RUN), 'artifact provenance mismatch')
for name, expected in validation['files'].items():
    check(PurePosixPath(name).name == name, 'invalid evidence path')
    check(digest((ev / name).read_bytes()) == expected, f'evidence digest mismatch: {name}')
check(validation['baseline_tests'] == 1108 and validation['patched_tests'] == 1126, 'missing regression cases')
check(digest((ev/'changes.patch').read_bytes()) == '8be64af00c4bdc6b74c286075b94fcc22a570616c545d07abcaf3b9154f4c755', 'patch differs from independently reviewed bytes')
check(digest((ev/ASSET).read_bytes()) == '7f4b389c964352239f6dc802625f4da52f27af970a934fab9117be1b96aaf0b6', 'package differs from reviewed artifact')
subprocess.run(['git', 'apply', '--index', '--check', str(ev / 'changes.patch')], check=True)
subprocess.run(['git', 'apply', '--index', str(ev / 'changes.patch')], check=True)
tree = sh('git', 'write-tree')
check(tree == (ev / 'TREE_SHA.txt').read_text().strip() == '8c899ae904237ec6df5ec23ea49871cf6f8e88d2', 'candidate tree differs from tested tree')
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
subprocess.run(['git', 'diff', '--cached', '--exit-code', '--', 'custom_components', '.github', 'bridge/src/command', 'bridge/src/browser/persistent-context.ts', 'addon/smartthings_web_bridge/rootfs', 'addon/smartthings_web_bridge/Dockerfile'], check=True)
check(sh('git', 'diff', '--cached', '--name-only').count('\n') + 1 == 23, 'unexpected modified path count')
check(json.loads(Path('package.json').read_text())['version'] == '1.8.7', 'package version mismatch')
check('version: 1.8.7' in Path('addon/smartthings_web_bridge/config.yaml').read_text().splitlines(), 'app version mismatch')
check(json.loads(Path('protocol/version.json').read_text())['protocol_version'] == 5, 'protocol changed')
archive = ev / ASSET
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    for member in members:
        path = PurePosixPath(member.name)
        check(not path.is_absolute() and '..' not in path.parts and path.parts[0] == 'smartthings_web_bridge', 'unsafe package path')
        check(member.isdir() or member.isfile(), 'non-regular package entry')
    def read(name):
        stream = tar.extractfile('smartthings_web_bridge/' + name)
        check(stream is not None, f'missing packaged file: {name}')
        return stream.read()
    manifest = json.loads(read('addon-package-manifest.json'))
    check(manifest['schema_version'] == 1, 'unsupported package manifest')
    expected_names = {'smartthings_web_bridge/addon-package-manifest.json'}
    for item in manifest['files']:
        name = item['path']
        data = read(name)
        expected_names.add('smartthings_web_bridge/' + name)
        check(digest(data) == item['sha256'], f'package manifest mismatch: {name}')
        direct = name in {'package.json','package-lock.json','tsconfig.json','tsconfig.build.json'} or name.startswith(('bridge/src/','tools/'))
        source = Path(name) if direct else Path('addon/smartthings_web_bridge') / name
        check(source.is_file() and source.read_bytes() == data, f'package differs from tested source: {name}')
    check({m.name for m in members if m.isfile()} == expected_names, 'unlisted packaged files')
# Pin the commit timestamp to the validated run for an idempotent retry.
os.environ.update(GIT_AUTHOR_NAME='github-actions[bot]', GIT_COMMITTER_NAME='github-actions[bot]', GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com', GIT_AUTHOR_DATE=run['created_at'], GIT_COMMITTER_DATE=run['created_at'])
message = f'fix(bridge): optimize lifecycle and SQLite hot paths for 1.8.7\n\nValidated by GitHub Actions run {RUN}; integration v1.8.7 unchanged.'
commit = sh('git', 'commit-tree', tree, '-p', BASE, '-m', message)
subprocess.run(['git', 'push', 'origin', f'{commit}:refs/heads/release/bridge-1.8.7-validated'], check=True)
subprocess.run(['git', 'push', 'origin', f'{commit}:refs/tags/{TAG}'], check=True)
provenance = {
    'bridge_version':'1.8.7', 'integration_version':'1.8.7', 'protocol_version':5,
    'source_commit':commit, 'source_tag':TAG, 'base_commit':BASE,
    'validation_run':f'https://github.com/{REPO}/actions/runs/{RUN}', 'validation_driver':DRIVER,
    'native_tests_before':validation['baseline_tests'], 'native_tests_after':validation['patched_tests'],
    'new_native_regressions':18, 'packaged_startup_job':'success',
    'synthetic_chromium_cookie_test':json.loads((ev/'chromium.json').read_text()),
    'user_ha_installed':False, 'real_account_or_physical_devices_tested':False,
    'archive':ASSET, 'sha256':digest(archive.read_bytes()), 'tested_tree':tree,
    'integration_tag_preserved':original_tag, 'existing_assets_preserved':OLD,
}
prov = ev/'bridge-1.8.7-provenance.json'
prov.write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
checksum = ev/'SHA256SUMS-bridge-1.8.7.txt'
checksum.write_text(''.join(f'{digest(p.read_bytes())}  {p.name}\n' for p in [archive, prov]),encoding='utf-8')
for path in [archive,prov,checksum]:
    assets = released()['assets']
    matches = [a for a in assets if a['name'] == path.name]
    if matches:
        check(len(matches)==1 and matches[0]['digest']=='sha256:'+digest(path.read_bytes()), 'existing new asset differs; do not overwrite')
    else:
        subprocess.run(['gh','release','upload','v1.8.7',str(path),'--repo',REPO],check=True)
    item = next(a for a in released()['assets'] if a['name']==path.name)
    check(item['state']=='uploaded' and item['digest']=='sha256:'+digest(path.read_bytes()),'uploaded bytes mismatch')
    with urllib.request.urlopen(item['browser_download_url'],timeout=60) as response:
        downloaded = response.read(4*1024*1024)
    check(downloaded==path.read_bytes(),'public download differs')
check(verify_old(released()) == old_ids, 'old asset IDs changed')
check(api(f'repos/{REPO}/git/ref/tags/v1.8.7')['object'] == original_tag, 'integration tag changed')
section = '\n\n## Bridge 1.8.7 후속 최적화 배포\n\n'
section += '기존 통합 단독 배포 이후 브리지 자체를 1.8.7로 개선했습니다. 위의 브리지 1.8.6 유지 설명은 최초 통합 배포 시점의 기록입니다.\n\n'
section += '- keeper 동시 생성·복구 병합과 실패한 임시 탭 정리\n- 최대 2,048개 HMAC 별칭 캐시와 캡처 SQLite SQL 문 재사용\n- 이전 capability 요청 실패가 최신 캐시를 삭제하는 경합 수정\n\n'
section += f'Node 회귀 테스트 {validation["baseline_tests"]} → {validation["patched_tests"]}개, 타입 검사·빌드·보안 감사·기존 HA 테스트·Chromium 합성 세션 보존·패키지 기동·HACS/Hassfest 검증을 통과했습니다. 검증 기록: https://github.com/{REPO}/actions/runs/{RUN}\n\n'
section += f'브리지 소스: `{commit}` (`{TAG}`). 새 파일: `{ASSET}`, `{checksum.name}`, `{prov.name}`. 기존 통합 v1.8.7 태그·설치 파일과 브리지 1.8.6 파일은 보존합니다.\n\n'
section += 'HA 앱 스토어에서 브리지 1.8.7을 업데이트하세요. 기존 HACS 통합 1.8.7 재설치는 필요하지 않습니다. 백업과 디스크 여유 공간을 확인하고 앱 데이터·Chromium 프로필을 삭제하지 마세요. 운영 HA 직접 설치, 실제 계정의 장시간 세션 및 물리 기기 검증은 수행하지 않았습니다. 기존 개발 중·설치 자제 경고는 유지합니다.\n'
current = released()
marker='## Bridge 1.8.7 후속 최적화 배포'
if marker not in (current.get('body') or ''):
    api(f'repos/{REPO}/releases/{RID}', {'body':(current.get('body') or '').rstrip()+section})
check(main_ref()==BASE, 'main advanced before publication; do not overwrite')
# Publish verified assets before main exposes the new HA app version.
subprocess.run(['git','push','origin',f'{commit}:refs/heads/main'],check=True)
check(main_ref()==commit,'main update not visible')
check(api(f'repos/{REPO}/git/ref/tags/{TAG}')['object']['sha']==commit,'bridge tag mismatch')
check(verify_old(released()) == old_ids, 'old assets changed during publication')
(ROOT/'result.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'published':True,'commit':commit,'bridge_version':'1.8.7','source_tag':TAG,'integration_tag_preserved':True,'user_ha_installed':False},indent=2))

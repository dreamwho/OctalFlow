#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ((BASH_VERSINFO[0] < 4)); then
    docker run --rm -v "$ROOT:/workspace:ro" --entrypoint bash dreamyo-app:offline /workspace/scripts/deploy-gptapi-fix.test.sh
    exit $?
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/package"
PROJECT="$TMP/project"
mkdir -p "$PKG/scripts" "$PKG/tools" "$PKG/services/chatgpt-api/api" "$PKG/services/chatgpt-api/services" "$PROJECT" "$TMP/bin"
cp "$ROOT/scripts/deploy-gptapi-fix.sh" "$PKG/scripts/"
cp "$ROOT/services/chatgpt-api/api/app.py" "$ROOT/services/chatgpt-api/api/accounts.py" "$PKG/services/chatgpt-api/api/"
cp "$ROOT/services/chatgpt-api/services/account_service.py" "$PKG/services/chatgpt-api/services/"
cp -aL "$ROOT/web/node_modules/yaml" "$PKG/tools/yaml"
printf '%s\n' services/chatgpt-api/api/app.py services/chatgpt-api/api/accounts.py services/chatgpt-api/services/account_service.py > "$PKG/python-runtime-files.txt"
python3 - "$PKG" <<'PY'
import json,sys
p=sys.argv[1]
paths=[x.strip() for x in open(p+"/python-runtime-files.txt") if x.strip()]
json.dump({x:"0"*64 for x in paths},open(p+"/expected-python-files.json","w"),sort_keys=True)
PY
cat > "$PROJECT/compose.yml" <<'YAML'
services:
  app:
    image: app-image
    environment: {KEEP_APP: yes}
    volumes: [app-data:/app/web/.data]
  generation-worker:
    image: worker-image
    environment: {KEEP_WORKER: yes}
  chatgpt-api:
    image: gpt-image
    network_mode: host
    environment: {KEEP_GPTAPI: yes}
    volumes:
      - gpt-data:/app/web/.data
      - ./preserved:/preserved:ro
  unrelated:
    image: unrelated-image
    volumes: [unrelated-data:/data]
volumes:
  app-data:
  gpt-data:
  unrelated-data:
YAML
cp "$PROJECT/compose.yml" "$TMP/compose.original.yml"
printf 'DREAMYO_CHATGPT_API_KEY=fixture-secret-not-printed\n' > "$PROJECT/.env"
printf old > "$PROJECT/mock-phase"
printf 'original=%s\n' "$(sha256sum "$PROJECT/compose.yml" | awk '{print $1}')" > "$PROJECT/mock-state"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == compose ]]; then
  case "$*" in
    *" compose version"*) exit 0 ;;
    *" ps --all -q chatgpt-api"*) echo gptapi-id; exit 0 ;;
    *" config -q"*) exit 0 ;;
    *" up -d --no-deps --pull never --force-recreate --wait chatgpt-api"*)
      echo chatgpt-api >> "$PROJECT/up-services.log"
      original="$(sed -n 's/^original=//p' "$PROJECT/mock-state")"
      current="$(sha256sum "$PROJECT/compose.yml" | awk '{print $1}')"
      if [[ "$current" == "$original" ]]; then echo old > "$PROJECT/mock-phase"; else echo new > "$PROJECT/mock-phase"; fi
      if [[ "${SIGNAL_FIRST_UP:-0}" == 1 && "$current" != "$original" && ! -f "$PROJECT/signaled-up-once" ]]; then
        touch "$PROJECT/signaled-up-once"
        kill -TERM "$PPID"
        exit 0
      fi
      if [[ "${FAIL_FIRST_UP:-0}" == 1 && ! -f "$PROJECT/failed-up-once" ]]; then touch "$PROJECT/failed-up-once"; exit 1; fi
      exit 0 ;;
    *) exit 0 ;;
  esac
fi
if [[ "$1" == inspect ]]; then
  fmt="$3"; id="$4"
  case "$fmt" in
    *com.docker.compose.project\"*) echo fixture-project ;;
    *com.docker.compose.service\"*) echo chatgpt-api ;;
    *config_files\"*) echo "$PROJECT/compose.yml" ;;
    *working_dir\"*) echo "$PROJECT" ;;
    *HostConfig.NetworkMode*) echo host ;;
    *State.Running*) echo true ;;
    *Image*) echo gpt-image ;;
  esac
  exit 0
fi
if [[ "$1" == exec ]]; then
  shift
  interactive=0
  if [[ "$1" == -i ]]; then interactive=1; shift; fi
  shift
  command_text="$*"
  if [[ "$command_text" == *"hashlib"* ]]; then
    expected_map="$(cat)"
    python3 - "$PKG" "$(cat "$PROJECT/mock-phase")" "$expected_map" <<'PY'
import hashlib,json,pathlib,sys
pkg=pathlib.Path(sys.argv[1]); phase=sys.argv[2]; expected=json.loads(sys.argv[3])
paths=[x.strip() for x in (pkg/"python-runtime-files.txt").read_text().splitlines() if x.strip()]
for path in paths:
    actual=hashlib.sha256((pkg/path).read_bytes()).hexdigest() if phase=="new" else "0"*64
    if actual not in expected[path]: raise SystemExit("mock live hash mismatch")
print(json.dumps({path:(hashlib.sha256((pkg/path).read_bytes()).hexdigest() if phase=="new" else "0"*64) for path in expected},sort_keys=True))
PY
    exit $?
  fi
  if [[ "$command_text" == *"cleanup-abnormal"* ]]; then
    [[ "$command_text" != *"POST"* && "$command_text" != *"method="* ]] || { echo 'forbidden non-GET verification' >&2; exit 91; }
    echo GET >> "$PROJECT/cleanup-methods.log"
    echo 'cleanup preview GET verified; count=0'
    exit 0
  fi
  exit 0
fi
if [[ "$1" == run ]]; then
  helper=''; compose_dir=''; python_list=''; release_dir=''; package_dir=''; entrypoint=''
  while (($#)); do
    case "$1" in
      -v)
        case "$2" in
          *:/tmp/gptapi-fix.mjs:ro) helper="${2%:/tmp/gptapi-fix.mjs:ro}" ;;
          *:/tmp/python-runtime-files.txt:ro) python_list="${2%:/tmp/python-runtime-files.txt:ro}" ;;
          *:/package:ro) package_dir="${2%:/package:ro}" ;;
          *:/yaml:ro) : ;;
          *:/compose:rw) compose_dir="${2%:/compose:rw}" ;;
        esac
        shift 2 ;;
      -e)
        case "$2" in RELEASE_DIR=*) release_dir="${2#RELEASE_DIR=}" ;; esac
        shift 2 ;;
      --entrypoint) entrypoint="$2"; shift 2 ;;
      -*) shift ;;
      *)
        if [[ "$1" == gpt-image ]]; then shift; break; fi
        shift ;;
    esac
  done
  if [[ "$entrypoint" == /app/services/chatgpt-api/.venv/bin/python ]]; then
    [[ -f "$package_dir/python-runtime-files.txt" ]] || exit 93
    python3 - "$package_dir" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1])
for relative in (root/"python-runtime-files.txt").read_text().splitlines():
    compile((root/relative).read_bytes(),relative,"exec")
PY
    exit $?
  fi
  [[ "$1" == /tmp/gptapi-fix.mjs ]] || { echo 'could not locate YAML helper' >&2; exit 92; }
  shift
  input_name="${1#/compose/}"; output_name="${2#/compose/}"
  adapted="$TMP/yaml-helper.mjs"
  sed "s#require('/yaml')#require('$PKG/tools/yaml')#" "$helper" > "$adapted"
  GPTAPI_SERVICE=chatgpt-api RELEASE_DIR="$release_dir" PYTHON_LIST="$python_list" node "$adapted" "$compose_dir/$input_name" "$compose_dir/$output_name"
  exit $?
fi
exit 0
MOCK
chmod +x "$TMP/bin/docker"
(cd "$PKG" && find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum) > "$PKG/SHA256SUMS"
export PATH="$TMP/bin:$PATH" PROJECT PKG TMP
export DREAMYO_GPTAPI_VERIFY_ORIGIN=http://127.0.0.1:18146
if SIGNAL_FIRST_UP=1 "$PKG/scripts/deploy-gptapi-fix.sh" --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/interrupted-apply.log" 2>&1; then
  echo 'test expected the injected SIGTERM to interrupt the updater' >&2
  exit 1
fi
cmp -s "$PROJECT/compose.yml" "$TMP/compose.original.yml"
[[ ! -e "$PROJECT/.source-update/gptapi-fixes/pending-apply" ]]
grep -q '已自动恢复原 Compose' "$TMP/interrupted-apply.log" || { cat "$TMP/interrupted-apply.log" >&2; exit 1; }
if FAIL_FIRST_UP=1 "$PKG/scripts/deploy-gptapi-fix.sh" --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/failing-apply.log" 2>&1; then
  echo 'test expected the injected service restart failure' >&2
  exit 1
fi
cmp -s "$PROJECT/compose.yml" "$TMP/compose.original.yml"
[[ ! -e "$PROJECT/.source-update/gptapi-fixes/pending-apply" ]]
grep -q '已自动恢复原 Compose' "$TMP/failing-apply.log" || { cat "$TMP/failing-apply.log" >&2; exit 1; }
"$PKG/scripts/deploy-gptapi-fix.sh" --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/apply.log"
node - "$PKG/tools/yaml" "$TMP/compose.original.yml" "$PROJECT/compose.yml" <<'NODE'
const assert=require('node:assert/strict');
const yaml=require(process.argv[2]);
const before=yaml.parse(require('node:fs').readFileSync(process.argv[3],'utf8'));
const after=yaml.parse(require('node:fs').readFileSync(process.argv[4],'utf8'));
assert.deepEqual(after.services.app,before.services.app);
assert.deepEqual(after.services['generation-worker'],before.services['generation-worker']);
assert.deepEqual(after.services.unrelated,before.services.unrelated);
const oldGpt=before.services['chatgpt-api']; const newGpt=after.services['chatgpt-api'];
assert.equal(newGpt.image,oldGpt.image); assert.equal(newGpt.network_mode,oldGpt.network_mode);
assert.deepEqual(newGpt.environment,oldGpt.environment);
const targets=newGpt.volumes.filter(v=>String(v.target||v.split(':')[1]).startsWith('/app/services/chatgpt-api/'));
assert.equal(targets.length,3); assert.ok(targets.every(v=>v.read_only===true && v.source.includes('/.source-update/gptapi-fixes/releases/')));
assert.ok(newGpt.volumes.some(v=>v==='./preserved:/preserved:ro'));
NODE
[[ "$(cat "$PROJECT/up-services.log" | sort -u)" == chatgpt-api ]]
[[ "$(cat "$PROJECT/cleanup-methods.log")" == GET ]]
UP_COUNT_BEFORE_IDEMPOTENT="$(wc -l < "$PROJECT/up-services.log" | tr -d ' ')"
"$PKG/scripts/deploy-gptapi-fix.sh" --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/idempotent.log"
[[ "$(wc -l < "$PROJECT/up-services.log" | tr -d ' ')" == "$UP_COUNT_BEFORE_IDEMPOTENT" ]]
[[ "$(cat "$PROJECT/cleanup-methods.log")" == $'GET\nGET' ]]
"$PKG/scripts/deploy-gptapi-fix.sh" --rollback --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/rollback.log"
cmp -s "$PROJECT/compose.yml" "$TMP/compose.original.yml"
[[ "$(cat "$PROJECT/up-services.log" | sort -u)" == chatgpt-api ]]
[[ "$(cat "$PROJECT/cleanup-methods.log")" == $'GET\nGET' ]]
"$PKG/scripts/deploy-gptapi-fix.sh" --rollback --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/repeated-rollback.log"
cmp -s "$PROJECT/compose.yml" "$TMP/compose.original.yml"
if grep -q 'fixture-secret-not-printed' "$TMP"/*.log; then echo 'secret leaked to deployment output' >&2; exit 1; fi
printf 'gptapi fix apply/rollback mock: passed\n'

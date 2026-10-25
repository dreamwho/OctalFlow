#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap '[[ "${KEEP_DEPLOY_TEST_TMP:-0}" == 1 ]] || rm -rf -- "$TMP"' EXIT
PKG="$TMP/package"
PROJECT="$TMP/project"
mkdir -p "$PKG/scripts" "$PKG/runtime/web/.next" "$PROJECT" "$TMP/bin"
cp "$ROOT/scripts/deploy-gptapi-tests-update.sh" "$PKG/scripts/"
chmod +x "$PKG/scripts/deploy-gptapi-tests-update.sh"
cat > "$PKG/scripts/deploy-source-update.sh" <<'MOCK_SOURCE'
#!/usr/bin/env bash
set -Eeuo pipefail
action="$1"; shift
project=""
compose=""
while (($#)); do
  case "$1" in
    --project-dir) project="$2"; shift 2 ;;
    --compose) compose="$2"; shift 2 ;;
    *) shift ;;
  esac
done
state="$project/.source-update"
if [[ "$action" == --stage-runtime ]]; then
  release=fixture-release
  mkdir -p "$state/releases/$release"
  printf 'package_mode=runtime\nproject=fixture\n' > "$state/releases/$release/metadata"
  mkdir -p "$state/backups"
  cp "$compose" "$state/backups/source-before-update.bak"
  printf '%s\n' "$release" > "$state/staged-release"
  exit 0
fi
if [[ "$action" == --apply ]]; then
  printf 'updated compose\n' > "$compose"
  marker="${DREAMYO_SOURCE_UPDATE_COMPOSE_HASH_MARKER:?}"
  sha256sum "$compose" | awk '{print $1}' > "$marker"
  backup="$state/backups/source-before-update.bak"
  printf 'backup=%s\nbackup_sha256=%s\napplied_sha256=%s\nrelease=%s\nproject=fixture\ncompose=%s\napp_service=app\nworker_service=generation-worker\ngptapi_service=chatgpt-api\n' \
    "$backup" "$(sha256sum "$backup" | awk '{print $1}')" "$(sha256sum "$compose" | awk '{print $1}')" "$state/releases/fixture-release" "$compose" > "$state/last-apply"
  if [[ "${MOCK_FAIL_AFTER_SWITCH:-0}" == 1 ]]; then exit 1; fi
  if [[ "${MOCK_SIGNAL_AFTER_SWITCH:-0}" == 1 ]]; then
    kill -TERM "$PPID"
    exit 0
  fi
  exit 0
fi
if [[ "$action" == --rollback ]]; then
  backup="$(sed -n 's/^backup=//p' "$state/last-apply")"
  cp "$backup" "$compose"
  if [[ "${MOCK_SIGNAL_AFTER_ROLLBACK_SWITCH:-0}" == 1 ]]; then kill -TERM "$PPID"; exit 0; fi
  exit 0
fi
exit 2
MOCK_SOURCE
chmod +x "$PKG/scripts/deploy-source-update.sh"
printf 'catalog-build\n' > "$PKG/runtime/web/.next/BUILD_ID"
printf 'm3jm9QvxONtidslN7NEL2\n' > "$PKG/expected-build-id.txt"
printf '{"schemaVersion":1,"buildId":"m3jm9QvxONtidslN7NEL2","imageId":"sha256:640c3f1482573ec994e96a4d18d0fc8eeab7a7fadcef6ed0e305448e6d5783ff","files":{"server.js":"%064d"}}\n' 0 > "$PKG/expected-runtime-files.json"
python3 - "$PKG" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
paths=[
"services/chatgpt-api/api/app.py",
"services/chatgpt-api/api/accounts.py",
"services/chatgpt-api/contracts/account_test.py",
"services/chatgpt-api/services/account_test_service.py",
"services/chatgpt-api/services/protocol/conversation.py",
"services/chatgpt-api/services/model_catalog_service.py",
]
allowed=[
 ["34043bf2430398d79441f02c41cc8122e7cef267a53eb797c6c06ecfdf50f55d"],
 ["c2fb4f56ef3b09516b0c9ebad1d400213e8bd44082699cfe0895dd9d4e96394f"],
 ["6a7cc72edfa8b998ff95fc4f415bf115bc36fdadc63254b1103a5484bef5fc04"],
 ["b61201059b78484206185e812d1b51ca7672e7a0b08984db8d04c6d0391b6714"],
 ["6a0e23680a999f87da0434fb114fe0dc8fdbba1fb6eec7a6933eab77d36b1148"],
 ["a8ec243d5412b0a392b8873b7ff50307acc3cf120002b2f8b02a9db6e1cbc429","dd5d9a67df97e72649e0cf0ba46be8f1b14d2c19df90847a7d2cd7d6f0238611"],
]
(root/"python-runtime-files.txt").write_text("\n".join(paths)+"\n")
(root/"expected-python-files.json").write_text(json.dumps({p:allowed[i] for i,p in enumerate(paths)},sort_keys=True)+"\n")
PY
printf 'services:\n  app: {}\n' > "$PROJECT/compose.yml"
printf 'DREAMYO_DATABASE_PROVIDER=postgres\nDATABASE_URL=postgresql://fixture\n' > "$PROJECT/.env"
cat > "$TMP/bin/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$PROJECT/docker-calls.log"
if [[ "$1" == compose ]]; then
  case "$*" in
    *"compose version"*) exit 0 ;;
    *" config -q"*) exit 0 ;;
    *" up -d --no-deps --pull never --force-recreate --wait "*)
      echo "$*" >> "$PROJECT/docker-up.log"
      if [[ "${MOCK_SIGNAL_DURING_RECOVERY:-0}" == 1 && ! -e "$PROJECT/recovery-signal-sent" ]]; then
        touch "$PROJECT/recovery-signal-sent"
        kill -TERM "$PPID"
      fi
      exit 0 ;;
  esac
fi
exit 0
MOCK_DOCKER
chmod +x "$TMP/bin/docker"
cat > "$TMP/bin/flock" <<'MOCK_FLOCK'
#!/usr/bin/env bash
exit 0
MOCK_FLOCK
chmod +x "$TMP/bin/flock"
export PATH="$TMP/bin:$PATH" PROJECT
cp "$PROJECT/compose.yml" "$TMP/compose.baseline.yml"
if MOCK_FAIL_AFTER_SWITCH=1 "$PKG/scripts/deploy-gptapi-tests-update.sh" --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/failed-apply.log" 2>&1; then
  echo 'expected injected update failure' >&2; exit 1
fi
cmp -s "$PROJECT/compose.yml" "$TMP/compose.baseline.yml"
[[ ! -e "$PROJECT/.source-update/gptapi-tests-update/pending" ]]
if MOCK_SIGNAL_AFTER_SWITCH=1 MOCK_SIGNAL_DURING_RECOVERY=1 "$PKG/scripts/deploy-gptapi-tests-update.sh" --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/interrupted.log" 2>&1; then
  echo 'expected interruption after the Compose switch' >&2
  exit 1
fi
cmp -s "$PROJECT/compose.yml" "$TMP/compose.baseline.yml"
[[ -e "$PROJECT/.source-update/gptapi-tests-update/pending" ]]
grep -q '^phase=restoring$' "$PROJECT/.source-update/gptapi-tests-update/pending"
printf 'unrelated external edit\n' > "$PROJECT/compose.yml"
if "$PKG/scripts/deploy-gptapi-tests-update.sh" --resume --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/unknown-compose.log" 2>&1; then
  echo 'expected refusal to overwrite unknown Compose content' >&2; exit 1
fi
[[ "$(cat "$PROJECT/compose.yml")" == 'unrelated external edit' ]]
cp "$TMP/compose.baseline.yml" "$PROJECT/compose.yml"
"$PKG/scripts/deploy-gptapi-tests-update.sh" --resume --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/resumed.log"
cmp -s "$PROJECT/compose.yml" <(printf 'updated compose\n')
[[ ! -e "$PROJECT/.source-update/gptapi-tests-update/pending" ]]
[[ ! -e "$(dirname "$PROJECT/compose.yml")/.catalog-update-expected-hash" ]]
[[ "$(wc -l < "$PROJECT/docker-up.log" | tr -d ' ')" -ge 2 ]]
cp "$PROJECT/compose.yml" "$TMP/compose.updated.yml"
if MOCK_SIGNAL_AFTER_ROLLBACK_SWITCH=1 "$PKG/scripts/deploy-gptapi-tests-update.sh" --rollback --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/interrupted-rollback.log" 2>&1; then
  echo 'expected interruption after the rollback Compose switch' >&2
  exit 1
fi
cmp -s "$PROJECT/compose.yml" "$TMP/compose.updated.yml"
[[ ! -e "$PROJECT/.source-update/gptapi-tests-update/pending" ]]
"$PKG/scripts/deploy-gptapi-tests-update.sh" --rollback --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/success-rollback.log"
cmp -s "$PROJECT/compose.yml" "$TMP/compose.baseline.yml" || { echo 'rollback did not restore the pre-update Compose' >&2; exit 1; }
[[ ! -e "$PROJECT/.source-update/gptapi-tests-update/pending" ]]
printf 'GPTAPI account-tests runtime journal mock: passed\n'

#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ((BASH_VERSINFO[0] < 4)); then
    docker run --rm -v "$ROOT:/workspace:ro" --entrypoint bash dreamyo-app:offline /workspace/scripts/deploy-runtime-update.test.sh
    exit $?
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/package"
PROJECT="$TMP/project"
mkdir -p "$PKG/scripts" "$PKG/runtime/web/.next" "$PKG/runtime/web/node_modules/yaml" "$PKG/runtime/python" "$PROJECT" "$TMP/bin"
cp "$ROOT/scripts/deploy-source-update.sh" "$ROOT/scripts/verify-source-update-baseline.cjs" "$PKG/scripts/"
cp "$ROOT/scripts/deploy-runtime-update.sh" "$PKG/scripts/"
printf 'build123\n' > "$PKG/expected-build-id.txt"
printf '{"schemaVersion":1,"buildId":"build123","imageId":"image123","files":{"server.js":"%064d"}}\n' 0 > "$PKG/expected-runtime-files.json"
: > "$PKG/python-runtime-files.txt"
printf '{"platform":"linux","arch":"x64","nodeMajor":22,"modules":"127","libc":"glibc","buildId":"runtime456"}\n' > "$PKG/runtime/node-runtime.json"
printf '{}\n' > "$PKG/runtime/SYMLINKS.json"
printf 'console.log("runtime")\n' > "$PKG/runtime/web/server.js"
printf 'runtime456\n' > "$PKG/runtime/web/.next/BUILD_ID"
printf '{"name":"yaml"}\n' > "$PKG/runtime/web/node_modules/yaml/package.json"
(cd "$PKG/runtime" && find web python -type f -print0 | sort -z | xargs -0 sha256sum) > "$PKG/runtime/SHA256SUMS"
printf 'services:\n  app:\n    image: image123\n' > "$PROJECT/compose.yml"
printf 'DREAMYO_DATABASE_PROVIDER=postgres\nDATABASE_URL=postgresql://example\n' > "$PROJECT/.env"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -e
if [[ "$1" == compose ]]; then
    case "$*" in
        *" compose version"*) exit 0 ;;
        *" ps --all -q "*) case "${@: -1}" in app) echo appid ;; generation-worker) echo workerid ;; chatgpt-api) echo gptid ;; esac; exit 0 ;;
        *" config -q"*) exit 0 ;;
    esac
fi
if [[ "$1" == inspect ]]; then
    fmt="$3"; id="$4"
    case "$fmt" in
        *com.docker.compose.project\"* ) echo projectx ;;
        *com.docker.compose.service\"* ) case "$id" in appid) echo app ;; workerid) echo generation-worker ;; *) echo chatgpt-api ;; esac ;;
        *config_files\"* ) echo "$PROJECT/compose.yml" ;;
        *working_dir\"* ) echo "$PROJECT" ;;
        *HostConfig.NetworkMode* ) echo host ;;
        *State.Running* ) echo true ;;
        *Image* ) echo image123 ;;
    esac
    exit 0
fi
if [[ "$1" == exec ]]; then
    shift
    [[ "$1" == -i ]] && shift
    id="$1"; shift
    if [[ "$*" == *"cat /app/web/.next/BUILD_ID"* ]]; then echo build123; exit 0; fi
    if [[ "$*" == *"node --input-type=commonjs"* ]]; then cat >/dev/null; exit 0; fi
    if [[ "$*" == *"node -p process.platform"* ]]; then echo 'linux x64 22 127 glibc'; exit 0; fi
    if [[ "$*" == *"sys.version_info"* ]]; then echo 3.12.0; exit 0; fi
    if [[ "$*" == *"id -u"* ]]; then echo 1000; exit 0; fi
    if [[ "$*" == *"id -g"* ]]; then echo 1000; exit 0; fi
    exit 0
fi
if [[ "$1" == run ]]; then echo "unexpected docker run $*" >&2; exit 90; fi
exit 0
MOCK
chmod +x "$TMP/bin/docker"
(cd "$PKG" && find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum) > "$PKG/SHA256SUMS"
export PATH="$TMP/bin:$PATH" PROJECT
"$PKG/scripts/deploy-source-update.sh" --stage-runtime --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/output"
release="$(cat "$PROJECT/.source-update/staged-release")"
[[ "$(sed -n 's/^package_mode=//p' "$PROJECT/.source-update/releases/$release/metadata")" == runtime ]]
[[ -f "$PROJECT/.source-update/releases/$release/web/server.js" ]]
grep -q '已暂存 Linux standalone release' "$TMP/output"
! grep -q 'unexpected docker run' "$TMP/output"
release_count="$(find "$PROJECT/.source-update/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
printf '\n//tamper\n' >> "$PKG/runtime/web/server.js"
(cd "$PKG" && find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum) > "$PKG/SHA256SUMS"
if "$PKG/scripts/deploy-source-update.sh" --stage-runtime --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/tamper-output" 2>&1; then
    echo 'runtime stage accepted content with a stale runtime SHA256SUMS' >&2
    exit 1
fi
grep -q 'runtime 文件 SHA-256 校验失败' "$TMP/tamper-output"
[[ "$(find "$PROJECT/.source-update/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == "$release_count" ]]
printf 'console.log("runtime")\n' > "$PKG/runtime/web/server.js"
(cd "$PKG/runtime" && find web python -type f -print0 | sort -z | xargs -0 sha256sum) > "$PKG/runtime/SHA256SUMS"
printf '{"platform":"linux","arch":"arm64","nodeMajor":22,"modules":"128","libc":"glibc","buildId":"runtime456"}\n' > "$PKG/runtime/node-runtime.json"
(cd "$PKG" && find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum) > "$PKG/SHA256SUMS"
if "$PKG/scripts/deploy-source-update.sh" --stage-runtime --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/abi-output" 2>&1; then
    echo 'runtime stage accepted unsupported Node architecture/ABI metadata' >&2
    exit 1
fi
grep -q 'runtime Node 元数据必须' "$TMP/abi-output"
[[ "$(find "$PROJECT/.source-update/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == "$release_count" ]]
printf '{"platform":"linux","arch":"x64","nodeMajor":22,"modules":"127","libc":"glibc","buildId":"runtime456"}\n' > "$PKG/runtime/node-runtime.json"
ln -s ../../outside "$PKG/runtime/web/escape"
printf 'outside\n' > "$PKG/outside"
printf '{"web/escape":"../../outside"}\n' > "$PKG/runtime/SYMLINKS.json"
(cd "$PKG" && find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum) > "$PKG/SHA256SUMS"
if "$PKG/scripts/deploy-source-update.sh" --stage-runtime --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/symlink-output" 2>&1; then
    echo 'runtime stage accepted a symlink traversal outside runtime' >&2
    exit 1
fi
grep -q '符号链接字面目标逃逸 runtime 目录' "$TMP/symlink-output"
[[ "$(find "$PROJECT/.source-update/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == "$release_count" ]]
rm "$PKG/runtime/web/escape" "$PKG/outside"
printf '{}\n' > "$PKG/runtime/SYMLINKS.json"
printf '{"platform":"linux","arch":"x64","nodeMajor":22,"modules":"127","libc":"glibc","buildId":"runtime456"}\n' > "$PKG/runtime/node-runtime.json"
printf 'build123\n' > "$PKG/expected-build-id.txt"
(cd "$PKG" && find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum) > "$PKG/SHA256SUMS"
printf 'wrongbase\n' > "$PKG/expected-build-id.txt"
(cd "$PKG" && find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum) > "$PKG/SHA256SUMS"
if "$PKG/scripts/deploy-source-update.sh" --stage-runtime --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/guard-output" 2>&1; then
    echo 'runtime stage accepted a mismatched deployment baseline' >&2
    exit 1
fi
grep -q '部署基线不匹配' "$TMP/guard-output"
[[ "$(find "$PROJECT/.source-update/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == "$release_count" ]]
mkdir -p "$PROJECT/.source-update/backups"
backup="$PROJECT/.source-update/backups/compose.before.yml"
printf 'services:\n  app:\n    image: image123\n' > "$backup"
printf 'services:\n  app:\n    image: newimage\n' > "$PROJECT/compose.yml"
{
    printf 'backup=%s\n' "$backup"
    printf 'backup_sha256=%s\n' "$(sha256sum "$backup" | awk '{print $1}')"
    printf 'applied_sha256=%s\n' "$(sha256sum "$PROJECT/compose.yml" | awk '{print $1}')"
    printf 'release=mock-release\nproject=projectx\ncompose=%s\napp_service=app\nworker_service=generation-worker\ngptapi_service=chatgpt-api\n' "$PROJECT/compose.yml"
} > "$PROJECT/.source-update/last-apply"
"$PKG/scripts/deploy-runtime-update.sh" --rollback --compose "$PROJECT/compose.yml" --project-dir "$PROJECT" > "$TMP/rollback-output"
cmp -s "$PROJECT/compose.yml" "$backup"
grep -q '已回滚 Compose 配置' "$TMP/rollback-output"
printf 'deploy runtime stage mock: passed\n'

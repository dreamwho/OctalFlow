#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ACTION=apply
COMPOSE_FILE=""
PROJECT_DIR=""
GPTAPI_SERVICE=chatgpt-api
RELEASE_ID=""
EDIT_STARTED=0
RECOVERING=0

fail() { printf '图片模型目录恢复失败：%s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'USAGE'
用法：./scripts/deploy-image-catalog-fix.sh [--apply|--rollback] --compose /path/compose.yml --project-dir /path/project
默认恢复图片模型目录，只重建 chatgpt-api；--rollback 恢复最近一次更新前的 Compose。
USAGE
}
while (($#)); do
    case "$1" in
        --apply) ACTION=apply; shift ;;
        --rollback) ACTION=rollback; shift ;;
        --compose) (($# >= 2)) || fail "--compose 缺少路径"; COMPOSE_FILE="$2"; shift 2 ;;
        --project-dir) (($# >= 2)) || fail "--project-dir 缺少路径"; PROJECT_DIR="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "未知参数：$1" ;;
    esac
done
[[ -n "$PROJECT_DIR" && "$PROJECT_DIR" == /* && -d "$PROJECT_DIR" && ! -L "$PROJECT_DIR" ]] || fail "请提供现存、非符号链接的项目绝对路径"
[[ -n "$COMPOSE_FILE" && "$COMPOSE_FILE" == /* && -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || fail "请提供现存、非符号链接的 Compose 绝对路径"
PROJECT_DIR="$(cd -- "$PROJECT_DIR" && pwd)"
COMPOSE_FILE="$(cd -- "$(dirname -- "$COMPOSE_FILE")" && pwd)/$(basename -- "$COMPOSE_FILE")"
[[ -f "$PROJECT_DIR/.env" && ! -L "$PROJECT_DIR/.env" ]] || fail "项目目录必须包含普通 .env 文件"
for tool in docker sha256sum python3 realpath flock; do command -v "$tool" >/dev/null 2>&1 || fail "缺少主机命令：$tool"; done
[[ ! -L "$PROJECT_DIR/.runtime-update.lock" ]] || fail "runtime 更新锁不能是符号链接"
exec 9>"$PROJECT_DIR/.runtime-update.lock"
flock -n 9 || fail "另一个 runtime 更新或回滚正在执行"
docker compose version >/dev/null 2>&1 || fail "需要 Docker Compose v2"

STATE_DIR="$PROJECT_DIR/.source-update/image-catalog-fixes"
RELEASES_DIR="$STATE_DIR/releases"
BACKUPS_DIR="$STATE_DIR/backups"
[[ ! -L "$PROJECT_DIR/.source-update" && ! -L "$STATE_DIR" ]] || fail "热修复状态目录不能是符号链接"
mkdir -p "$RELEASES_DIR" "$BACKUPS_DIR"
[[ ! -L "$PROJECT_DIR/.source-update" && ! -L "$STATE_DIR" && ! -L "$RELEASES_DIR" && ! -L "$BACKUPS_DIR" ]] || fail "热修复状态目录不能是符号链接"

die_on_exit() {
    local status="$1" current_hash
    if ((status == 0 || EDIT_STARTED == 0 || RECOVERING == 1)); then return; fi
    RECOVERING=1
    trap - EXIT HUP INT TERM
    if [[ -f "$BACKUP_FILE" && -f "$COMPOSE_FILE" ]]; then
        current_hash="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
        if [[ "$current_hash" == "$APPLIED_HASH" || "$current_hash" == "$BEFORE_HASH" ]]; then
            restore_compose "$BACKUP_FILE" || { printf '自动恢复 Compose 失败；备份仍保留：%s\n' "$BACKUP_FILE" >&2; exit "$status"; }
            if docker compose "${COMPOSE_ARGS[@]}" config -q && docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --pull never --force-recreate --wait "$GPTAPI_SERVICE"; then
                rm -f "$STATE_DIR/pending-apply"
                printf '已自动恢复原 Compose 并重建 %s。\n' "$GPTAPI_SERVICE" >&2
            else
                printf 'Compose 已恢复，但 %s 重建或健康检查失败；备份保留：%s\n' "$GPTAPI_SERVICE" "$BACKUP_FILE" >&2
            fi
        else
            printf 'Compose 出现非本次更新内容，未覆盖；备份保留：%s\n' "$BACKUP_FILE" >&2
        fi
    fi
    exit "$status"
}
restore_compose() {
    local backup="$1" temporary
    temporary="$(mktemp "$(dirname "$COMPOSE_FILE")/.compose-gptapi-restore.XXXXXX")"
    cp -p "$backup" "$temporary"
    mv -f "$temporary" "$COMPOSE_FILE"
}
write_pending_apply() {
    local backup="$1" backup_hash="$2" before_hash="$3" applied_hash="$4" release="$5" temporary
    temporary="$(mktemp "$STATE_DIR/.pending-apply.XXXXXX")"
    printf 'backup=%s\nbackup_sha256=%s\nbefore_sha256=%s\napplied_sha256=%s\nproject=%s\ncompose=%s\nrelease=%s\n' \
        "$backup" "$backup_hash" "$before_hash" "$applied_hash" "$COMPOSE_PROJECT" "$COMPOSE_FILE" "$release" > "$temporary"
    chmod 0600 "$temporary"
    mv -f "$temporary" "$STATE_DIR/pending-apply"
}
recover_pending_apply() {
    local pending="$STATE_DIR/pending-apply" backup backup_hash before_hash applied_hash current_hash
    [[ -f "$pending" ]] || return 0
    [[ ! -L "$pending" ]] || fail "待恢复事务记录不能是符号链接"
    backup="$(sed -n 's/^backup=//p' "$pending")"
    backup_hash="$(sed -n 's/^backup_sha256=//p' "$pending")"
    before_hash="$(sed -n 's/^before_sha256=//p' "$pending")"
    applied_hash="$(sed -n 's/^applied_sha256=//p' "$pending")"
    [[ "$backup" == "$BACKUPS_DIR/"* && -f "$backup" && ! -L "$backup" ]] || fail "待恢复事务缺少受管理的 Compose 备份"
    [[ "$backup_hash" =~ ^[0-9a-f]{64}$ && "$before_hash" =~ ^[0-9a-f]{64}$ && "$applied_hash" =~ ^[0-9a-f]{64}$ ]] || fail "待恢复事务哈希字段无效"
    [[ "$(sha256sum "$backup" | awk '{print $1}')" == "$backup_hash" && "$backup_hash" == "$before_hash" ]] || fail "待恢复事务备份校验失败"
    [[ "$(sed -n 's/^project=//p' "$pending")" == "$COMPOSE_PROJECT" && "$(sed -n 's/^compose=//p' "$pending")" == "$COMPOSE_FILE" ]] || fail "待恢复事务不属于当前 Compose 项目"
    current_hash="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
    [[ "$current_hash" == "$before_hash" || "$current_hash" == "$applied_hash" ]] || fail "Compose 已出现事务外修改；拒绝自动覆盖"
    restore_compose "$backup"
    docker compose "${COMPOSE_ARGS[@]}" config -q || fail "已恢复原 Compose，但配置校验失败；备份保留：$backup"
    docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --pull never --force-recreate --wait "$GPTAPI_SERVICE" || fail "已恢复原 Compose，但 GPTAPI 重建或健康检查失败；备份保留：$backup"
    rm -f "$pending"
    printf '已恢复中断事务前的 Compose 并重建 %s。\n' "$GPTAPI_SERVICE" >&2
}
trap 'die_on_exit $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

inspect_gptapi() {
    local id project service_label config_files working_dir network running
    id="$(docker compose --project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" -f "$COMPOSE_FILE" ps --all -q "$GPTAPI_SERVICE" 2>/dev/null)"
    [[ -n "$id" && "$id" != *$'\n'* ]] || fail "Compose 服务不是唯一的容器：$GPTAPI_SERVICE"
    project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")"
    service_label="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")"
    config_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$id")"
    working_dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id")"
    network="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$id")"
    running="$(docker inspect -f '{{.State.Running}}' "$id")"
    [[ -n "$project" && "$service_label" == "$GPTAPI_SERVICE" ]] || fail "容器 Compose 标签与指定服务不匹配"
    [[ "$config_files" == "$COMPOSE_FILE" ]] || fail "GPTAPI 由其他或多份 Compose 文件管理；拒绝修改"
    [[ "$working_dir" == "$PROJECT_DIR" ]] || fail "Compose 项目目录与容器标签不一致"
    [[ "$network" == host ]] || fail "此热修复只接受 host network GPTAPI 部署"
    if [[ "$ACTION" == apply && "$running" != true ]]; then [[ -f "$STATE_DIR/pending-apply" && ! -L "$STATE_DIR/pending-apply" ]] || fail "GPTAPI 容器未运行且没有待恢复事务"; fi
    COMPOSE_PROJECT="$project"
    GPTAPI_CONTAINER="$id"
    GPTAPI_IMAGE="$(docker inspect -f '{{.Image}}' "$id")"
    [[ "$GPTAPI_IMAGE" == sha256:640c3f1482573ec994e96a4d18d0fc8eeab7a7fadcef6ed0e305448e6d5783ff ]] || fail "GPTAPI 镜像不是已确认的部署基线"
}

verify_package() {
    local line hash relative
    declare -A listed=()
    [[ -f "$PACKAGE_DIR/SHA256SUMS" && ! -L "$PACKAGE_DIR/SHA256SUMS" ]] || fail "上传包缺少普通 SHA256SUMS"
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || fail "SHA256SUMS 格式无效"
        hash="${BASH_REMATCH[1]}"; relative="${BASH_REMATCH[2]}"
        [[ -n "$relative" && "$relative" != /* && "$relative" != *\\* && "$relative" != *$'\n'* && "$relative" != *$'\r'* ]] || fail "SHA256SUMS 包含不安全路径"
        local path_part; IFS=/ read -r -a package_parts <<< "$relative"
        for path_part in "${package_parts[@]}"; do [[ -n "$path_part" && "$path_part" != . && "$path_part" != .. ]] || fail "SHA256SUMS 包含不安全路径"; done
        [[ -f "$PACKAGE_DIR/$relative" && ! -L "$PACKAGE_DIR/$relative" ]] || fail "校验清单包含非普通文件：$relative"
        [[ -z "${listed[$relative]:-}" ]] || fail "SHA256SUMS 重复路径：$relative"
        listed[$relative]=1
    done < "$PACKAGE_DIR/SHA256SUMS"
    (cd "$PACKAGE_DIR" && sha256sum -c SHA256SUMS >/dev/null) || fail "上传包 SHA-256 校验失败"
    while IFS= read -r -d '' relative; do [[ -n "${listed[$relative]:-}" ]] || fail "SHA256SUMS 未覆盖文件：$relative"; done < <(cd "$PACKAGE_DIR" && find . -type f ! -path './SHA256SUMS' -printf '%P\0')
    [[ -z "$(find "$PACKAGE_DIR" -type l -print -quit)" ]] || fail "热修复包不允许符号链接"
    [[ -z "$(find "$PACKAGE_DIR" -type f \( -name '.env*' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print -quit)" ]] || fail "热修复包包含环境或业务数据文件"
    [[ -d "$PACKAGE_DIR/tools/yaml" && -f "$PACKAGE_DIR/tools/yaml/package.json" ]] || fail "上传包缺少 YAML 解析器 tools/yaml"
    [[ -f "$PACKAGE_DIR/python-runtime-files.txt" && -f "$PACKAGE_DIR/expected-python-files.json" ]] || fail "上传包缺少 Python 文件清单或旧文件哈希"
    [[ -f "$PACKAGE_DIR/services/chatgpt-api/services/model_catalog_service.py" ]] || fail "上传包缺少图片模型目录服务文件"
    expected_paths="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in d.items()); print("\n".join(sorted(d)))' "$PACKAGE_DIR/expected-python-files.json" 2>/dev/null)" || fail "expected-python-files.json 格式无效"
    listed_paths="$(LC_ALL=C sort "$PACKAGE_DIR/python-runtime-files.txt")"
    [[ "$listed_paths" == services/chatgpt-api/services/model_catalog_service.py ]] || fail "python-runtime-files.txt 必须恰好列出 model_catalog_service.py"
    [[ "$expected_paths" == "$listed_paths" ]] || fail "旧文件哈希清单必须恰好对应 model_catalog_service.py"
    python3 - "$PACKAGE_DIR/expected-python-files.json" <<'PYHASH' || fail "model_catalog_service.py 旧版基线哈希不匹配"
import json,sys
expected={"services/chatgpt-api/services/model_catalog_service.py":"a8ec243d5412b0a392b8873b7ff50307acc3cf120002b2f8b02a9db6e1cbc429"}
assert json.load(open(sys.argv[1],encoding="utf-8")) == expected
PYHASH
}

read_expected_old_hashes() {
    python3 - "$PACKAGE_DIR/expected-python-files.json" <<'PY'
import json, re, sys
values = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(values, dict) or any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in values.values()):
    raise SystemExit("invalid old hashes")
print(json.dumps(values, sort_keys=True))
PY
}

remote_hash_check() {
    local hash_map="$1"
    docker exec -i "$GPTAPI_CONTAINER" /app/services/chatgpt-api/.venv/bin/python -c '
import hashlib, json, pathlib, sys
base = pathlib.Path("/app")
items = json.load(sys.stdin)
invalid = []
for path, hashes in items.items():
    try:
        digest = hashlib.sha256((base / path).read_bytes()).hexdigest()
    except OSError:
        invalid.append(path + ":missing")
        continue
    if digest not in hashes:
        invalid.append(path + ":mismatch")
if invalid:
    print("\n".join(invalid), file=sys.stderr)
    raise SystemExit(1)
print(json.dumps({path: hashlib.sha256((base / path).read_bytes()).hexdigest() for path in items}, sort_keys=True))
' < "$hash_map"
}

verify_catalog_get() {
    local origin="${DREAMYO_GPTAPI_VERIFY_ORIGIN:-http://127.0.0.1:8046}"
    python3 - "$origin" <<'PY' >/dev/null || fail "DREAMYO_GPTAPI_VERIFY_ORIGIN 只能指向本机 HTTP GPTAPI fixture"
import sys
from urllib.parse import urlsplit
u=urlsplit(sys.argv[1])
assert u.scheme == "http" and u.hostname in {"127.0.0.1", "localhost", "::1"} and not u.username and not u.password and u.path in {"", "/"} and not u.query and not u.fragment
PY
    docker exec -e "DREAMYO_GPTAPI_VERIFY_ORIGIN=$origin" "$GPTAPI_CONTAINER" /app/services/chatgpt-api/.venv/bin/python -c '
import json, os, urllib.request
key = os.environ["DREAMYO_CHATGPT_API_KEY"]
origin = os.environ["DREAMYO_GPTAPI_VERIFY_ORIGIN"].rstrip("/")
request = urllib.request.Request(origin + "/api/model-catalog", headers={"Authorization": "Bearer " + key, "x-dreamyo-runtime-key": key})
with urllib.request.urlopen(request) as response:
    payload = json.load(response)
if not isinstance(payload, dict) or not isinstance(payload.get("image_models"), list) or not payload["image_models"]:
    raise SystemExit("model catalog returned no image models")
source = payload.get("source")
if not isinstance(source, dict) or source.get("image") not in {"upstream", "accounts", "config", "fallback"}:
    raise SystemExit("model catalog image source is invalid")
warnings = payload.get("warnings")
if warnings and source["image"] == "upstream":
    raise SystemExit("compatibility image catalog incorrectly reports upstream source")
print("authenticated model catalog GET verified; image models=" + str(len(payload["image_models"])))
'
}

if [[ "$ACTION" == rollback ]]; then
    inspect_gptapi
    COMPOSE_ARGS=(--project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT" --env-file "$PROJECT_DIR/.env" -f "$COMPOSE_FILE")
    had_pending=0; [[ -f "$STATE_DIR/pending-apply" ]] && had_pending=1
    recover_pending_apply
    if ((had_pending)); then
        inspect_gptapi
        COMPOSE_ARGS=(--project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT" --env-file "$PROJECT_DIR/.env" -f "$COMPOSE_FILE")
    fi
    LAST_APPLY="$STATE_DIR/last-apply"
    [[ -f "$LAST_APPLY" && ! -L "$LAST_APPLY" ]] || fail "没有可回滚的 GPTAPI 热修复记录"
    TARGET_BACKUP="$(sed -n 's/^backup=//p' "$LAST_APPLY")"
    BACKUP_HASH="$(sed -n 's/^backup_sha256=//p' "$LAST_APPLY")"
    APPLIED_HASH="$(sed -n 's/^applied_sha256=//p' "$LAST_APPLY")"
    [[ "$TARGET_BACKUP" == "$BACKUPS_DIR/"* && -f "$TARGET_BACKUP" && ! -L "$TARGET_BACKUP" ]] || fail "找不到受管理的 Compose 备份"
    [[ "$(sed -n 's/^project=//p' "$LAST_APPLY")" == "$COMPOSE_PROJECT" && "$(sed -n 's/^compose=//p' "$LAST_APPLY")" == "$COMPOSE_FILE" ]] || fail "热修复记录不属于当前 Compose 项目或文件"
    [[ "$(sha256sum "$TARGET_BACKUP" | awk '{print $1}')" == "$BACKUP_HASH" ]] || fail "Compose 备份校验失败"
    CURRENT_HASH="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
    [[ "$CURRENT_HASH" == "$APPLIED_HASH" || "$CURRENT_HASH" == "$BACKUP_HASH" ]] || fail "Compose 已被其他流程修改，拒绝回滚覆盖"
    ROLLBACK_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \\n')-rollback"
    BACKUP_FILE="$BACKUPS_DIR/$(basename "$COMPOSE_FILE").$ROLLBACK_ID.bak"
    cp -p "$COMPOSE_FILE" "$BACKUP_FILE"
    BEFORE_HASH="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
    [[ "$BEFORE_HASH" == "$CURRENT_HASH" ]] || fail "无法创建回滚前 Compose 备份"
    TARGET_HASH="$(sha256sum "$TARGET_BACKUP" | awk '{print $1}')"
    APPLIED_HASH="$TARGET_HASH"
    write_pending_apply "$BACKUP_FILE" "$BEFORE_HASH" "$BEFORE_HASH" "$TARGET_HASH" "$(sed -n 's/^release=//p' "$LAST_APPLY")"
    EDIT_STARTED=1
    restore_compose "$TARGET_BACKUP"
    docker compose "${COMPOSE_ARGS[@]}" config -q || fail "恢复后的 Compose 校验失败"
    docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --pull never --force-recreate --wait "$GPTAPI_SERVICE" || fail "旧 Compose 已恢复，但 GPTAPI 重建或健康检查失败"
    GPTAPI_CONTAINER="$(docker compose "${COMPOSE_ARGS[@]}" ps --all -q "$GPTAPI_SERVICE")"
    rollback_release="$(sed -n 's/^release=//p' "$LAST_APPLY")"
    [[ "$rollback_release" =~ ^[A-Za-z0-9._-]+$ ]] || fail "回滚记录 release ID 无效"
    OLD_HASH_MAP="$RELEASES_DIR/$rollback_release/expected-python-files.json"
    PREVIOUS_HASHES="$RELEASES_DIR/$rollback_release/previous-python-files.json"
    [[ -f "$OLD_HASH_MAP" && ! -L "$OLD_HASH_MAP" && -f "$PREVIOUS_HASHES" && ! -L "$PREVIOUS_HASHES" ]] || fail "热修复 Python 哈希记录缺失"
    ROLLBACK_HASH_MAP="$(mktemp "$STATE_DIR/rollback-hashes.XXXXXX")"
    python3 - "$PREVIOUS_HASHES" > "$ROLLBACK_HASH_MAP" <<'PY'
import json,sys
previous=json.load(open(sys.argv[1],encoding="utf-8"))
print(json.dumps({k:[v] for k,v in previous.items()},sort_keys=True))
PY
    ACTUAL_HASHES="$(remote_hash_check "$ROLLBACK_HASH_MAP")" || fail "回滚后 GPTAPI Python 文件哈希与修复前版本不一致"
    rm -f "$ROLLBACK_HASH_MAP"
    [[ "$ACTUAL_HASHES" == "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])),sort_keys=True))' "$PREVIOUS_HASHES")" ]] || fail "回滚后 GPTAPI Python 文件哈希与修复前版本不一致"
    rm -f "$STATE_DIR/pending-apply"
    EDIT_STARTED=0
    printf '已回滚 GPTAPI Compose 并只重建 %s。\n' "$GPTAPI_SERVICE"
    exit 0
fi

inspect_gptapi
COMPOSE_ARGS=(--project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT" --env-file "$PROJECT_DIR/.env" -f "$COMPOSE_FILE")
had_pending=0; [[ -f "$STATE_DIR/pending-apply" ]] && had_pending=1
recover_pending_apply
if ((had_pending)); then
    inspect_gptapi
    COMPOSE_ARGS=(--project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT" --env-file "$PROJECT_DIR/.env" -f "$COMPOSE_FILE")
fi
verify_package
read_expected_old_hashes >/dev/null
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail "release ID 格式无效"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
mkdir "$RELEASE_DIR"
while IFS= read -r relative || [[ -n "$relative" ]]; do
    [[ -n "$relative" ]] || continue
    mkdir -p "$RELEASE_DIR/services/$(dirname "$relative")"
    cp -p "$PACKAGE_DIR/$relative" "$RELEASE_DIR/services/$relative"
done < "$PACKAGE_DIR/python-runtime-files.txt"
cp -p "$PACKAGE_DIR/expected-python-files.json" "$RELEASE_DIR/expected-python-files.json"
NEW_HASHES="$(python3 - "$PACKAGE_DIR" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); paths=[x.strip() for x in (root/"python-runtime-files.txt").read_text().splitlines() if x.strip()]
print(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths},sort_keys=True))
PY
)"
HASH_MAP="$RELEASE_DIR/hash-check.json"
python3 - "$PACKAGE_DIR/expected-python-files.json" "$NEW_HASHES" > "$HASH_MAP" <<'PY'
import json,sys
old=json.load(open(sys.argv[1],encoding="utf-8")); new=json.loads(sys.argv[2])
print(json.dumps({k:[old[k],new[k]] for k in old},sort_keys=True))
PY
ACTUAL_HASHES="$(remote_hash_check "$HASH_MAP")" || fail "GPTAPI 当前文件不匹配旧版哈希或本次热修复版；未修改 Compose"
if [[ "$ACTUAL_HASHES" == "$NEW_HASHES" ]]; then
    verify_catalog_get || fail "已安装版本的图片模型目录 GET 验证失败"
    printf 'GPTAPI 热修复已安装并通过 GET 验证；未创建新 Compose 变更。\n'
    exit 0
fi
printf '%s\n' "$ACTUAL_HASHES" > "$RELEASE_DIR/previous-python-files.json"

# Compile the exact packaged files with the Python runtime from the target GPTAPI image.
docker run --rm --pull never --network none --entrypoint /app/services/chatgpt-api/.venv/bin/python \
    -v "$PACKAGE_DIR:/package:ro" "$GPTAPI_IMAGE" -c '
import pathlib, sys
root=pathlib.Path("/package")
for relative in (root/"python-runtime-files.txt").read_text(encoding="utf-8").splitlines():
    source=(root/relative).read_bytes()
    compile(source, relative, "exec")
' || fail "GPTAPI Python 运行时无法编译上传包中的 Python 文件；未修改 Compose"

BACKUP_FILE="$BACKUPS_DIR/$(basename "$COMPOSE_FILE").$RELEASE_ID.bak"
cp -p "$COMPOSE_FILE" "$BACKUP_FILE"
BACKUP_HASH="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
BEFORE_HASH="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
COMPOSE_TEMP="$(mktemp "$(dirname "$COMPOSE_FILE")/.compose-gptapi-fix.XXXXXX")"
YAML_SCRIPT="$(mktemp "$STATE_DIR/yaml-fix.XXXXXX.mjs")"
cleanup_temp() { rm -f -- "${COMPOSE_TEMP:-}" "${YAML_SCRIPT:-}"; }
on_exit() { local status=$?; cleanup_temp; die_on_exit "$status"; }
trap on_exit EXIT

cat > "$YAML_SCRIPT" <<'JS'
import { readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseDocument } = require('/yaml');
const [composePath, outputPath] = process.argv.slice(2);
const document = parseDocument(readFileSync(composePath, 'utf8'));
if (document.errors.length) throw new Error('Compose YAML 无法解析');
const serviceName = process.env.GPTAPI_SERVICE;
const service = document.getIn(['services', serviceName], true);
if (!service) throw new Error(`Compose 中缺少服务 ${serviceName}`);
let volumes = service.get('volumes', true);
if (!volumes) { service.set('volumes', document.createNode([])); volumes = service.get('volumes', true); }
if (!Array.isArray(volumes.items)) throw new Error('GPTAPI volumes 不是列表');
const files = readFileSync(process.env.PYTHON_LIST, 'utf8').split(/\r?\n/).filter(Boolean);
function nodeValue(item) { return item && typeof item.toJSON === 'function' ? item.toJSON() : item; }
function sourceOf(item) { const v=nodeValue(item); return typeof v==='string' ? v.split(':')[0] : v?.source || ''; }
function targetOf(item) { const v=nodeValue(item); return typeof v==='string' ? v.split(':')[1] || '' : v?.target || ''; }
for (const relative of files) {
  if (!/^services\/chatgpt-api\/[A-Za-z0-9._/-]+\.py$/.test(relative) || relative.includes('..')) throw new Error('Python 文件清单路径无效');
  const target = `/app/${relative}`;
  const matches = volumes.items.filter(item => targetOf(item) === target);
  for (const item of matches) if (!sourceOf(item).includes('/.source-update/')) throw new Error(`拒绝覆盖非本工具管理的 mount: ${target}`);
  volumes.items = volumes.items.filter(item => targetOf(item) !== target);
  volumes.add({ type: 'bind', source: `${process.env.RELEASE_DIR}/${relative}`, target, read_only: true });
}
const mode = statSync(composePath).mode & 0o777;
writeFileSync(outputPath, document.toString(), { mode });
chmodSync(outputPath, mode);
JS

docker run --rm --pull never --network none --user 0 --entrypoint node \
    -v "$(dirname "$COMPOSE_FILE"):/compose:rw" \
    -v "$YAML_SCRIPT:/tmp/gptapi-fix.mjs:ro" \
    -v "$PACKAGE_DIR/tools/yaml:/yaml:ro" \
    -v "$PACKAGE_DIR/python-runtime-files.txt:/tmp/python-runtime-files.txt:ro" \
    -e GPTAPI_SERVICE="$GPTAPI_SERVICE" -e RELEASE_DIR="$RELEASE_DIR/services" -e PYTHON_LIST=/tmp/python-runtime-files.txt \
    "$GPTAPI_IMAGE" /tmp/gptapi-fix.mjs "/compose/$(basename "$COMPOSE_FILE")" "/compose/$(basename "$COMPOSE_TEMP")" \
    || fail "无法安全生成只修改 GPTAPI Python mounts 的 Compose 文件"
APPLIED_HASH="$(sha256sum "$COMPOSE_TEMP" | awk '{print $1}')"
[[ "$APPLIED_HASH" != "$BEFORE_HASH" ]] || fail "Compose 中已经存在相同的 GPTAPI Python mounts；拒绝创建重复热修复记录"
write_pending_apply "$BACKUP_FILE" "$BACKUP_HASH" "$BEFORE_HASH" "$APPLIED_HASH" "$RELEASE_ID"
EDIT_STARTED=1
mv -f "$COMPOSE_TEMP" "$COMPOSE_FILE"
COMPOSE_TEMP=""
docker compose "${COMPOSE_ARGS[@]}" config -q || fail "Compose 合并校验失败"
docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --pull never --force-recreate --wait "$GPTAPI_SERVICE" || fail "GPTAPI 重建或健康检查失败"
GPTAPI_CONTAINER="$(docker compose "${COMPOSE_ARGS[@]}" ps --all -q "$GPTAPI_SERVICE")"
POST_HASH_MAP="$(mktemp "$STATE_DIR/post-hashes.XXXXXX")"
python3 - "$NEW_HASHES" > "$POST_HASH_MAP" <<'PY'
import json,sys
print(json.dumps({k:[v] for k,v in json.loads(sys.argv[1]).items()},sort_keys=True))
PY
POST_ACTUAL_HASHES="$(remote_hash_check "$POST_HASH_MAP")" || fail "新 GPTAPI 容器没有加载图片模型目录文件"
rm -f "$POST_HASH_MAP"
[[ "$POST_ACTUAL_HASHES" == "$NEW_HASHES" ]] || fail "新 GPTAPI 容器没有加载图片模型目录文件"
verify_catalog_get || fail "图片模型目录 GET 验证失败"
printf 'backup=%s\nbackup_sha256=%s\napplied_sha256=%s\nproject=%s\ncompose=%s\nrelease=%s\n' \
    "$BACKUP_FILE" "$BACKUP_HASH" "$APPLIED_HASH" "$COMPOSE_PROJECT" "$COMPOSE_FILE" "$RELEASE_ID" > "$STATE_DIR/last-apply"
rm -f "$STATE_DIR/pending-apply"
EDIT_STARTED=0
trap - EXIT HUP INT TERM
cleanup_temp
printf '图片模型目录恢复已完成并通过认证 GET 验证。\nCompose 备份：%s\n只重建服务：%s\n' "$BACKUP_FILE" "$GPTAPI_SERVICE"

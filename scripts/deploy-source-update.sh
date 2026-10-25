#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ACTION=stage
PACKAGE_MODE=source
COMPOSE_FILE=""
PROJECT_DIR=""
APP_SERVICE=app
WORKER_SERVICE=generation-worker
GPTAPI_SERVICE=chatgpt-api
RELEASE_ID=""
CATALOG_RUNTIME=0

die() { printf '增量更新失败：%s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'EOF'
用法：./scripts/deploy-source-update.sh [--stage|--stage-runtime|--apply|--rollback]
  --compose /绝对路径/docker-compose.yml   当前运行栈唯一 Compose 文件
  --project-dir /绝对路径                  Compose 项目目录（包含 .env）
  --app-service app                       App 服务名
  --worker-service generation-worker     Worker 服务名
  --gptapi-service chatgpt-api            GPTAPI 服务名
  --release-id ID                         --apply 时指定已 stage 版本，默认最近版本

默认执行 --stage。stage 只构建并暂存；只有显式 --apply 才会备份和修改 Compose、重建三个目标服务。
EOF
}

while (($#)); do
    case "$1" in
        --stage|--stage-runtime|--apply|--rollback) ACTION="${1#--}"; shift ;;
        --compose) (($# >= 2)) || die "--compose 缺少路径"; COMPOSE_FILE="$2"; shift 2 ;;
        --project-dir) (($# >= 2)) || die "--project-dir 缺少路径"; PROJECT_DIR="$2"; shift 2 ;;
        --app-service) (($# >= 2)) || die "--app-service 缺少值"; APP_SERVICE="$2"; shift 2 ;;
        --worker-service) (($# >= 2)) || die "--worker-service 缺少值"; WORKER_SERVICE="$2"; shift 2 ;;
        --gptapi-service) (($# >= 2)) || die "--gptapi-service 缺少值"; GPTAPI_SERVICE="$2"; shift 2 ;;
        --catalog-runtime) CATALOG_RUNTIME=1; shift ;;
        --release-id) (($# >= 2)) || die "--release-id 缺少值"; RELEASE_ID="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "未知参数：$1" ;;
    esac
done

[[ -n "$COMPOSE_FILE" && "$COMPOSE_FILE" == /* && -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || die "请提供现存、非符号链接的 Compose 绝对路径"
[[ -n "$PROJECT_DIR" && "$PROJECT_DIR" == /* && -d "$PROJECT_DIR" && ! -L "$PROJECT_DIR" ]] || die "请提供现存、非符号链接的项目目录绝对路径"
COMPOSE_FILE="$(cd -- "$(dirname -- "$COMPOSE_FILE")" && pwd)/$(basename -- "$COMPOSE_FILE")"
PROJECT_DIR="$(cd -- "$PROJECT_DIR" && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "项目目录中没有普通 .env 文件；脚本不会创建或覆盖密钥文件"
for command_name in docker sha256sum; do command -v "$command_name" >/dev/null 2>&1 || die "缺少命令：$command_name"; done
docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2"
if [[ "$ACTION" == stage-runtime ]]; then ACTION=stage; PACKAGE_MODE=runtime; fi
if [[ "$PACKAGE_MODE" == runtime ]]; then
    for command_name in python3 realpath; do command -v "$command_name" >/dev/null 2>&1 || die "runtime 更新缺少主机命令：$command_name"; done
fi
STATE_DIR="$PROJECT_DIR/.source-update"
if [[ "$ACTION" == apply ]]; then
    staged_id="$RELEASE_ID"
    [[ -n "$staged_id" ]] || staged_id="$(cat "$STATE_DIR/staged-release" 2>/dev/null || true)"
    [[ "$staged_id" =~ ^[A-Za-z0-9._-]+$ && -f "$STATE_DIR/releases/$staged_id/metadata" ]] || die "没有有效的 staged release；先运行 stage"
    [[ "$(sed -n 's/^package_mode=//p' "$STATE_DIR/releases/$staged_id/metadata")" != runtime ]] || PACKAGE_MODE=runtime
fi
if [[ "$ACTION" != rollback ]]; then
    if [[ "$PACKAGE_MODE" == runtime ]]; then
        [[ -d "$PACKAGE_DIR/runtime/web" && -d "$PACKAGE_DIR/runtime/python" && -f "$PACKAGE_DIR/runtime/node-runtime.json" && -f "$PACKAGE_DIR/runtime/SHA256SUMS" && -f "$PACKAGE_DIR/runtime/SYMLINKS.json" ]] || die "上传包缺少 runtime/web、runtime/python 或 runtime 元数据、哈希及符号链接清单"
    else
    [[ -f "$PACKAGE_DIR/web/package.json" && -f "$PACKAGE_DIR/web/pnpm-lock.yaml" && -f "$PACKAGE_DIR/VERSION" && -f "$PACKAGE_DIR/CHANGELOG.md" ]] || die "上传包缺少完整 WEB 源码构建输入（web、VERSION、CHANGELOG.md）"
    fi
    [[ -f "$PACKAGE_DIR/SHA256SUMS" && -f "$PACKAGE_DIR/python-runtime-files.txt" && -f "$PACKAGE_DIR/expected-build-id.txt" && -f "$PACKAGE_DIR/expected-runtime-files.json" && -f "$PACKAGE_DIR/scripts/verify-source-update-baseline.cjs" ]] || die "上传包缺少校验清单、Python 覆盖清单或运行基线文件"
fi
if [[ "$CATALOG_RUNTIME" == 1 ]]; then
    [[ "$PACKAGE_MODE" == runtime && "$ACTION" != rollback ]] || die "--catalog-runtime 只能用于 runtime stage/apply"
    [[ -f "$PACKAGE_DIR/expected-python-files.json" && ! -L "$PACKAGE_DIR/expected-python-files.json" ]] || die "catalog runtime 包缺少 expected-python-files.json"
fi
safe_relative() {
    local path_part
    [[ -n "$1" && "$1" != /* && "$1" != *\\* && "$1" != *$'\n'* && "$1" != *$'\r'* ]] || return 1
    local -a path_parts
    IFS=/ read -r -a path_parts <<< "$1"
    for path_part in "${path_parts[@]}"; do
        [[ -n "$path_part" && "$path_part" != . && "$path_part" != .. ]] || return 1
    done
}
verify_upload_manifest() {
    local line digest relative actual
    declare -A listed=()
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || die "SHA256SUMS 格式无效"
        digest="${BASH_REMATCH[1]}"; relative="${BASH_REMATCH[2]}"
        safe_relative "$relative" || die "校验清单包含不安全路径"
        [[ -f "$PACKAGE_DIR/$relative" && ! -L "$PACKAGE_DIR/$relative" ]] || die "上传包缺少普通文件：$relative"
        [[ -z "${listed[$relative]:-}" ]] || die "校验清单重复路径：$relative"
        actual="$(sha256sum "$PACKAGE_DIR/$relative" | awk '{print $1}')"
        [[ "$actual" == "$digest" ]] || die "上传文件 SHA-256 不匹配：$relative"
        listed[$relative]=1
    done < "$PACKAGE_DIR/SHA256SUMS"
    [[ -n "${listed[python-runtime-files.txt]:-}" ]] || die "SHA256SUMS 未覆盖 python-runtime-files.txt"
    [[ -n "${listed[expected-build-id.txt]:-}" ]] || die "SHA256SUMS 未覆盖 expected-build-id.txt"
    [[ -n "${listed[web/package.json]:-}" && -n "${listed[web/pnpm-lock.yaml]:-}" ]] || die "SHA256SUMS 未覆盖 WEB 构建清单"
    while IFS= read -r -d '' relative; do
        [[ -n "${listed[$relative]:-}" ]] || die "SHA256SUMS 未覆盖上传文件：$relative"
    done < <(find "$PACKAGE_DIR" -type f ! -path "$PACKAGE_DIR/SHA256SUMS" -printf '%P\0')
}

verify_runtime_root_manifest() {
    local line digest relative actual
    declare -A listed=()
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || die "顶层 SHA256SUMS 格式无效"
        digest="${BASH_REMATCH[1]}"; relative="${BASH_REMATCH[2]}"
        safe_relative "$relative" || die "顶层 SHA256SUMS 包含不安全路径"
        [[ -f "$PACKAGE_DIR/$relative" && ! -L "$PACKAGE_DIR/$relative" ]] || die "顶层校验清单缺少普通文件：$relative"
        [[ -z "${listed[$relative]:-}" ]] || die "顶层 SHA256SUMS 重复路径：$relative"
        listed[$relative]=1
    done < "$PACKAGE_DIR/SHA256SUMS"
    (cd "$PACKAGE_DIR" && sha256sum -c SHA256SUMS >/dev/null) || die "顶层上传包 SHA-256 校验失败"
    while IFS= read -r -d '' relative; do
        [[ -n "${listed[$relative]:-}" ]] || die "顶层 SHA256SUMS 未覆盖上传文件：${relative#"$PACKAGE_DIR/"}"
    done < <(cd "$PACKAGE_DIR" && find . -type f ! -path './SHA256SUMS' -printf '%P\0')
}

verify_runtime_package() {
    local line digest relative actual target resolved lexical forbidden
    declare -A listed=()
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || die "runtime/SHA256SUMS 格式无效"
        digest="${BASH_REMATCH[1]}"; relative="${BASH_REMATCH[2]}"
        safe_relative "$relative" || die "runtime/SHA256SUMS 包含不安全路径"
        [[ "$relative" == web/* || "$relative" == python/* ]] || die "runtime/SHA256SUMS 只能包含 web/ 或 python/ 文件"
        [[ -f "$PACKAGE_DIR/runtime/$relative" && ! -L "$PACKAGE_DIR/runtime/$relative" ]] || die "runtime 清单缺少普通文件：$relative"
        [[ -z "${listed[$relative]:-}" ]] || die "runtime/SHA256SUMS 重复路径：$relative"
        listed[$relative]=1
    done < "$PACKAGE_DIR/runtime/SHA256SUMS"
    (cd "$PACKAGE_DIR/runtime" && sha256sum -c SHA256SUMS >/dev/null) || die "runtime 文件 SHA-256 校验失败"
    [[ -n "${listed[web/server.js]:-}" && -n "${listed[web/.next/BUILD_ID]:-}" && -n "${listed[web/node_modules/yaml/package.json]:-}" ]] || die "runtime 清单必须覆盖 standalone server.js、BUILD_ID 和 yaml/package.json"
    while IFS= read -r -d '' relative; do
        [[ -n "${listed[$relative]:-}" ]] || die "runtime/SHA256SUMS 未覆盖普通文件：${relative#"$PACKAGE_DIR/runtime/"}"
    done < <(cd "$PACKAGE_DIR/runtime" && find web python -type f -print0)
    forbidden="$(find "$PACKAGE_DIR/runtime" -type f \( -name '.env*' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print -quit)"
    [[ -z "$forbidden" ]] || die "runtime 包包含环境或业务数据：${forbidden#"$PACKAGE_DIR/"}"
    forbidden="$(find "$PACKAGE_DIR/runtime/web" \( -path '*/.data/*' -o -path '*/.magic-proxy-runtime/*' -o -path '*/.next/cache/*' \) -type f -print -quit)"
    [[ -z "$forbidden" ]] || die "runtime 包含持久化数据或缓存内容：${forbidden#"$PACKAGE_DIR/"}"
    while IFS= read -r -d '' relative; do
        target="$(readlink "$relative")"
        [[ "$target" != /* && "$target" != *$'\n'* && "$target" != *$'\r'* && "$target" != *$'\t'* && "$relative" != *$'\t'* ]] || die "runtime 符号链接必须使用可校验的内部相对目标：$relative"
        lexical="$(realpath -m -s "$(dirname "$relative")/$target")"
        [[ "$lexical" == "$PACKAGE_DIR/runtime/"* ]] || die "runtime 符号链接字面目标逃逸 runtime 目录：$relative"
        resolved="$(realpath -m "$relative")"
        [[ "$resolved" == "$PACKAGE_DIR/runtime/"* ]] || die "runtime 符号链接目标逃逸 runtime 目录：$relative"
        [[ -e "$resolved" ]] || die "runtime 符号链接目标不存在：$relative"
    done < <(find "$PACKAGE_DIR/runtime" -type l -print0)
    actual_links="$(find "$PACKAGE_DIR/runtime" -type l -print0 | while IFS= read -r -d '' relative; do printf '%s\t%s\n' "${relative#"$PACKAGE_DIR/runtime/"}" "$(readlink "$relative")"; done | LC_ALL=C sort)"
    expected_links="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,dict); [print(k+"\t"+v) for k,v in sorted(d.items())]' "$PACKAGE_DIR/runtime/SYMLINKS.json" 2>/dev/null)" || die "runtime/SYMLINKS.json 必须是路径到相对目标的 JSON 对象"
    [[ "$actual_links" == "$expected_links" ]] || die "runtime 符号链接清单与实际链接不一致"
    while IFS= read -r relative || [[ -n "$relative" ]]; do
        [[ -z "$relative" ]] && continue
        [[ "$relative" == services/chatgpt-api/*.py && -f "$PACKAGE_DIR/runtime/python/$relative" ]] || die "runtime/python 缺少清单中的 Python 文件：$relative"
    done < "$PACKAGE_DIR/python-runtime-files.txt"
    node_runtime_json="$PACKAGE_DIR/runtime/node-runtime.json"
    [[ -f "$node_runtime_json" && ! -L "$node_runtime_json" ]] || die "runtime/node-runtime.json 必须是普通文件"
    node_runtime_values="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(str(d.get(k,"")) for k in ("platform","arch","nodeMajor","modules","libc","buildId")))' "$node_runtime_json" 2>/dev/null)" || die "runtime/node-runtime.json 无效"
    mapfile -t node_runtime_values <<< "$node_runtime_values"
    [[ "${node_runtime_values[0]:-}" == linux && "${node_runtime_values[1]:-}" == x64 && "${node_runtime_values[2]:-}" == 22 && "${node_runtime_values[3]:-}" == 127 && "${node_runtime_values[4]:-}" == glibc && "${node_runtime_values[5]:-}" =~ ^[A-Za-z0-9_-]+$ ]] || die "runtime Node 元数据必须为 linux/x64、Node22、modules127、glibc，并包含合法 buildId"
    [[ "${node_runtime_values[5]}" == "$(cat "$PACKAGE_DIR/runtime/web/.next/BUILD_ID")" ]] || die "runtime/node-runtime.json 的 buildId 与 standalone BUILD_ID 不匹配"
}

reject_private_build_inputs() {
    local forbidden
    forbidden="$(find "$PACKAGE_DIR/web" \( -name node_modules -o -name '.next*' -o -name .data -o -name '.env*' \) -print -quit)"
    [[ -z "$forbidden" ]] || die "WEB 上传源码包含禁止的本地构建、数据或环境文件：${forbidden#"$PACKAGE_DIR/"}"
    [[ -z "$(find "$PACKAGE_DIR" -path "$PACKAGE_DIR/web/.next*" -prune -o -type l -print -quit)" ]] || die "上传包包含符号链接，无法对完整源码路径校验 SHA-256"
    forbidden="$(find "$PACKAGE_DIR" -type f \( -name '.env*' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print -quit)"
    [[ -z "$forbidden" ]] || die "上传包包含环境或业务数据文件：${forbidden#"$PACKAGE_DIR/"}"
    while IFS= read -r relative || [[ -n "$relative" ]]; do
        [[ "$relative" != *$'\r'* ]] || die "python-runtime-files.txt 必须使用 LF 换行"
        [[ -z "$relative" ]] && continue
        safe_relative "$relative" || die "Python 文件清单路径无效"
        [[ "$relative" == services/chatgpt-api/*.py && -f "$PACKAGE_DIR/$relative" && ! -L "$PACKAGE_DIR/$relative" ]] || die "Python 文件必须是 services/chatgpt-api 下的普通 .py 文件：$relative"
    done < "$PACKAGE_DIR/python-runtime-files.txt"
}

inspect_topology() {
    local service id project config_files service_label allow_stopped="${ALLOW_STOPPED_TOPOLOGY:-0}"
    declare -g COMPOSE_PROJECT=""
    declare -g APP_CONTAINER=""
    declare -g WORKER_CONTAINER=""
    declare -g GPTAPI_CONTAINER=""
    for service in "$APP_SERVICE" "$WORKER_SERVICE" "$GPTAPI_SERVICE"; do
        id="$(docker compose --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --all -q "$service" 2>/dev/null)"
        [[ -n "$id" && "$id" != *$'\n'* ]] || die "Compose 服务不是唯一的运行容器：$service"
        project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")"
        service_label="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")"
        config_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$id")"
        working_dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id")"
        [[ -n "$project" && "$service_label" == "$service" ]] || die "容器 Compose 标签与指定服务不匹配：$service"
        [[ "$config_files" == "$COMPOSE_FILE" ]] || die "该服务由多份或其他 Compose 文件管理；为保证重建持久性，本脚本拒绝改写"
        [[ "$working_dir" == "$PROJECT_DIR" ]] || die "Compose 项目目录与运行容器标签不一致：$service"
        [[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$id")" == host ]] || die "此增量流程只接受 host network 部署：$service"
        if [[ -z "$COMPOSE_PROJECT" ]]; then COMPOSE_PROJECT="$project"; else [[ "$COMPOSE_PROJECT" == "$project" ]] || die "目标服务不属于同一个 Compose 项目"; fi
        if [[ "$allow_stopped" != 1 ]]; then
            [[ "$(docker inspect -f '{{.State.Running}}' "$id")" == true ]] || die "目标容器未运行：$service"
        fi
        if [[ "$service" == "$APP_SERVICE" ]]; then APP_CONTAINER="$id"; fi
        if [[ "$service" == "$WORKER_SERVICE" ]]; then WORKER_CONTAINER="$id"; fi
        if [[ "$service" == "$GPTAPI_SERVICE" ]]; then GPTAPI_CONTAINER="$id"; fi
    done
    [[ -n "$APP_CONTAINER" ]] || die "无法解析 App 容器"
    [[ -n "$WORKER_CONTAINER" ]] || die "无法解析 generation-worker 容器"
    [[ -n "$GPTAPI_CONTAINER" ]] || die "无法解析 GPTAPI 容器"
}

verify_deployment_baseline() {
    local app_image worker_image actual_build_id python_version
    local -a expected_build_ids=()
    mapfile -t expected_build_ids < "$PACKAGE_DIR/expected-build-id.txt"
    [[ "${#expected_build_ids[@]}" == 1 ]] || die "expected-build-id.txt 必须恰好包含一行 Build ID"
    EXPECTED_BUILD_ID="${expected_build_ids[0]}"
    [[ "$EXPECTED_BUILD_ID" =~ ^[A-Za-z0-9_-]+$ ]] || die "expected-build-id.txt 必须只包含一个有效 Build ID"
    actual_build_id="$(docker exec "$APP_CONTAINER" cat /app/web/.next/BUILD_ID 2>/dev/null)" || die "无法读取 App 当前 Next.js Build ID"
    [[ "$actual_build_id" == "$EXPECTED_BUILD_ID" ]] || die "部署基线不匹配：上传包期望 $EXPECTED_BUILD_ID，服务器当前为 $actual_build_id；请按当前服务器版本重新整理上传包后再运行，不会猜测或覆盖"
    app_image="$(docker inspect -f '{{.Image}}' "$APP_CONTAINER")"
    worker_image="$(docker inspect -f '{{.Image}}' "$WORKER_CONTAINER")"
    GPTAPI_IMAGE="$(docker inspect -f '{{.Image}}' "$GPTAPI_CONTAINER")"
    [[ -n "$app_image" && "$worker_image" == "$app_image" && -n "$GPTAPI_IMAGE" ]] || die "App 和 Worker 必须来自同一个镜像构建，且 GPTAPI 镜像必须可确认"
    local target_container
    for target_container in "$APP_CONTAINER" "$WORKER_CONTAINER"; do
        docker exec -i "$target_container" node --input-type=commonjs \
            -e "$(cat "$PACKAGE_DIR/scripts/verify-source-update-baseline.cjs")" /app/web "$app_image" \
            < "$PACKAGE_DIR/expected-runtime-files.json" || die "App/Worker 运行文件或镜像与已核实基线不一致；停止更新"
    done
    python_version="$(docker exec "$GPTAPI_CONTAINER" /app/services/chatgpt-api/.venv/bin/python -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')" || die "无法读取 GPTAPI venv Python 版本"
    [[ -n "$python_version" ]] || die "GPTAPI venv Python 版本为空"
    GPTAPI_PYTHON_VERSION="$python_version"
    APP_UID="$(docker exec "$APP_CONTAINER" id -u)" || die "无法读取 App 容器运行 UID"
    APP_GID="$(docker exec "$APP_CONTAINER" id -g)" || die "无法读取 App 容器运行 GID"
    [[ "$APP_UID" =~ ^[0-9]+$ && "$APP_GID" =~ ^[0-9]+$ ]] || die "App 容器 UID/GID 不是数字"
    APP_IMAGE="$app_image"
}

verify_python_targets() {
    local relative
    while IFS= read -r relative || [[ -n "$relative" ]]; do
        [[ "$relative" != *$'\r'* ]] || die "python-runtime-files.txt 必须使用 LF 换行"
        [[ -z "$relative" ]] && continue
        docker exec "$GPTAPI_CONTAINER" test -f "/app/$relative" || die "GPTAPI 镜像没有目标源码文件：/app/$relative"
    done < "$PACKAGE_DIR/python-runtime-files.txt"
}

verify_catalog_python_baseline() {
    [[ "$CATALOG_RUNTIME" == 1 ]] || return 0
    local expected_json actual_json
    expected_json="$(python3 - "$PACKAGE_DIR/python-runtime-files.txt" "$PACKAGE_DIR/expected-python-files.json" <<'PY'
import json, pathlib, re, sys
listed = [line.strip() for line in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines() if line.strip()]
if len(listed) != len(set(listed)):
    raise SystemExit("python-runtime-files.txt 含重复路径")
expected = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
if not isinstance(expected, dict) or set(expected) != set(listed):
    raise SystemExit("expected-python-files.json 必须恰好覆盖 Python runtime 文件清单")
for path, hashes in expected.items():
    if not re.fullmatch(r"services/chatgpt-api/[A-Za-z0-9._/-]+\.py", path) or ".." in path.split("/"):
        raise SystemExit("expected-python-files.json 包含无效路径")
    if not isinstance(hashes, list) or not 1 <= len(hashes) <= 2 or len(set(hashes)) != len(hashes):
        raise SystemExit("每个 GPTAPI Python 文件必须列出一个或两个明确的旧版 SHA-256")
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in hashes):
        raise SystemExit("expected-python-files.json 包含无效 SHA-256")
print(json.dumps(expected, sort_keys=True, separators=(",", ":")))
PY
)" || die "catalog Python 基线清单无效"
    actual_json="$(printf '%s' "$expected_json" | docker exec -i "$GPTAPI_CONTAINER" /app/services/chatgpt-api/.venv/bin/python -c '
import hashlib,json,pathlib,sys
allowed=json.load(sys.stdin); actual={}
for relative, hashes in allowed.items():
    path=pathlib.Path("/app")/relative
    if not path.is_file(): raise SystemExit("GPTAPI 镜像缺少 Python runtime 目标："+relative)
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    if digest not in hashes: raise SystemExit("GPTAPI Python 文件不匹配允许的旧版哈希："+relative)
    actual[relative]=digest
print(json.dumps(actual,sort_keys=True,separators=(",",":")))
')" || die "GPTAPI Python 文件不匹配 package 中明确列出的旧版或已交付 hotfix 哈希"
    [[ -n "$actual_json" ]] || die "无法核对 GPTAPI Python 基线哈希"
}

compose_apply() {
    local wait_args=()
    if [[ -n "${DREAMYO_DEPLOY_HEALTH_TIMEOUT_SECONDS:-}" ]]; then
        wait_args=(--wait-timeout "$DREAMYO_DEPLOY_HEALTH_TIMEOUT_SECONDS")
    fi
    docker compose "${compose_args[@]}" up -d --no-deps --pull never --force-recreate --wait "${wait_args[@]}" "$APP_SERVICE" "$WORKER_SERVICE" "$GPTAPI_SERVICE"
}
restore_compose_backup() {
    local backup="$1" temporary
    temporary="$(mktemp "$(dirname "$COMPOSE_FILE")/.compose-restore.XXXXXX")"
    cp -p "$backup" "$temporary"
    mv -f "$temporary" "$COMPOSE_FILE"
}

if [[ "$ACTION" == rollback ]]; then
    ALLOW_STOPPED_TOPOLOGY=1
    inspect_topology
    compose_args=(--project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
    STATE_DIR="$PROJECT_DIR/.source-update"
    [[ -f "$STATE_DIR/last-apply" ]] || die "没有可回滚的增量部署记录"
    BACKUP_FILE="$(sed -n 's/^backup=//p' "$STATE_DIR/last-apply")"
    [[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] || die "找不到原 Compose 备份；停止回滚"
    [[ "$(sed -n 's/^project=//p' "$STATE_DIR/last-apply")" == "$COMPOSE_PROJECT" ]] || die "回滚记录不属于当前 Compose 项目"
    [[ "$(sed -n 's/^compose=//p' "$STATE_DIR/last-apply")" == "$COMPOSE_FILE" ]] || die "回滚记录对应另一份 Compose 文件"
    [[ "$(sed -n 's/^app_service=//p' "$STATE_DIR/last-apply")" == "$APP_SERVICE" && "$(sed -n 's/^worker_service=//p' "$STATE_DIR/last-apply")" == "$WORKER_SERVICE" && "$(sed -n 's/^gptapi_service=//p' "$STATE_DIR/last-apply")" == "$GPTAPI_SERVICE" ]] || die "回滚记录的服务名与当前参数不一致"
    [[ "$(sha256sum "$BACKUP_FILE" | awk '{print $1}')" == "$(sed -n 's/^backup_sha256=//p' "$STATE_DIR/last-apply")" ]] || die "Compose 备份校验失败；停止回滚"
    [[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" == "$(sed -n 's/^applied_sha256=//p' "$STATE_DIR/last-apply")" ]] || die "应用后 Compose 已被其他流程修改；拒绝覆盖并回滚"
    restore_compose_backup "$BACKUP_FILE"
    if ! docker compose "${compose_args[@]}" config -q; then die "原 Compose 恢复后校验失败；备份文件仍保留：$BACKUP_FILE"; fi
    compose_apply || die "已恢复原 Compose，但服务重建或健康检查失败；请检查三个目标服务日志"
    printf '已回滚 Compose 配置并重建目标服务；源码 release 仍保留：%s\n' "$(sed -n 's/^release=//p' "$STATE_DIR/last-apply")"
    exit 0
fi

if [[ "$PACKAGE_MODE" == runtime ]]; then verify_runtime_root_manifest; verify_runtime_package; else verify_upload_manifest; reject_private_build_inputs; fi
inspect_topology
verify_deployment_baseline
verify_catalog_python_baseline
compose_args=(--project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
if [[ "$PACKAGE_MODE" != runtime || "$ACTION" == apply || "$CATALOG_RUNTIME" == 1 ]]; then verify_python_targets; fi
APP_IMAGE="$(docker inspect -f '{{.Image}}' "$APP_CONTAINER")"
[[ -n "$APP_IMAGE" ]] || die "无法确认正在运行的 App 镜像"
if [[ "$PACKAGE_MODE" == runtime ]]; then
    for target_container in "$APP_CONTAINER" "$WORKER_CONTAINER"; do
        target_node="$(docker exec "$target_container" node -p 'process.platform+" "+process.arch+" "+process.versions.node.split(".")[0]+" "+process.versions.modules+" "+(process.report.getReport().header.glibcVersionRuntime?"glibc":"musl")')" || die "无法读取 App/Worker Node 运行时元数据"
        [[ "$target_node" == "linux x64 22 127 glibc" ]] || die "App/Worker Node ABI 与 Linux x64 Node22 standalone 不匹配：$target_node"
    done
else
    APP_NODE="$(docker exec "$APP_CONTAINER" node -p 'process.version+" "+process.platform+" "+process.arch+" "+process.versions.modules')"
    BUILDER_NODE="$(docker run --rm --pull never --network none --entrypoint node "$APP_IMAGE" -p 'process.version+" "+process.platform+" "+process.arch+" "+process.versions.modules' 2>/dev/null)" || die "App 镜像不能作为临时 Node builder 使用"
    [[ "$APP_NODE" == "$BUILDER_NODE" && ( "$APP_NODE" == v22.*\ linux\ x64\ * || "$APP_NODE" == v22.*\ linux\ arm64\ * ) ]] || die "builder 与运行容器 Node/架构不一致：运行=$APP_NODE，builder=$BUILDER_NODE；需准备匹配的 Linux Node22 镜像"
    docker run --rm --pull never --network none -w /app/web --entrypoint sh "$APP_IMAGE" -c 'command -v corepack >/dev/null' >/dev/null 2>&1 || die "App 镜像缺少 Corepack，无法使用其 Node22 运行时构建 WEB"
fi

STATE_DIR="$PROJECT_DIR/.source-update"
RELEASES_DIR="$STATE_DIR/releases"
mkdir -p "$RELEASES_DIR" "$STATE_DIR/backups"
if [[ "$ACTION" == stage && -z "$RELEASE_ID" ]]; then
    RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
elif [[ "$ACTION" == apply && -z "$RELEASE_ID" ]]; then
    RELEASE_ID="$(cat "$STATE_DIR/staged-release" 2>/dev/null || true)"
fi
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "release ID 格式无效"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"

if [[ "$ACTION" == stage ]]; then
    [[ ! -e "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || die "release 已存在，拒绝覆盖：$RELEASE_ID"
    BUILD_TMP="$(mktemp -d "$RELEASES_DIR/.stage-$RELEASE_ID.XXXXXX")"
    trap 'rm -rf -- "$BUILD_TMP"' EXIT
    chmod 0755 "$BUILD_TMP"
    mkdir -p "$BUILD_TMP/input"
    if [[ "$PACKAGE_MODE" == runtime ]]; then
        cp -a "$PACKAGE_DIR/runtime/web" "$BUILD_TMP/web"
        cp -a "$PACKAGE_DIR/runtime/python" "$BUILD_TMP/python"
        cp -a "$PACKAGE_DIR/python-runtime-files.txt" "$BUILD_TMP/input/"
        [[ -f "$BUILD_TMP/web/server.js" && -f "$BUILD_TMP/web/.next/BUILD_ID" && -f "$BUILD_TMP/web/node_modules/yaml/package.json" ]] || die "runtime/web 缺少可运行的 standalone 核心文件"
    else
    cp -a "$PACKAGE_DIR/web" "$BUILD_TMP/input/web"
    cp -a "$PACKAGE_DIR/VERSION" "$PACKAGE_DIR/CHANGELOG.md" "$BUILD_TMP/input/"
    cp -a "$PACKAGE_DIR/python-runtime-files.txt" "$BUILD_TMP/input/"
    while IFS= read -r relative || [[ -n "$relative" ]]; do
        [[ -z "$relative" ]] && continue
        mkdir -p "$BUILD_TMP/input/$(dirname "$relative")"
        cp -a "$PACKAGE_DIR/$relative" "$BUILD_TMP/input/$relative"
    done < "$PACKAGE_DIR/python-runtime-files.txt"
    cat > "$BUILD_TMP/build.sh" <<'BUILDER'
set -eu
corepack prepare pnpm@11.9.0 --activate
mkdir -p /tmp/build/web /output/web /output/python
cp -a /input/web/. /tmp/build/web/
cp -a /input/VERSION /input/CHANGELOG.md /tmp/build/
cd /tmp/build/web
export NODE_OPTIONS=
export NEXT_TELEMETRY_DISABLED=1 CI=1 PNPM_HOME=/tmp/pnpm PATH="/tmp/pnpm:$PATH"
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
NEXT_SKIP_BUILD_TYPECHECK=1 corepack pnpm run build
node scripts/build-local-data-migration.mjs
cd /tmp/build/web
cp -a .next/standalone/. /output/web/
mkdir -p /output/web/public
cp -a public/. /output/web/public/
mkdir -p /output/web/.next/static /output/web/.next/cache /output/web/.data /output/web/.magic-proxy-runtime
cp -a .next/static/. /output/web/.next/static/
for file in scripts/reset-admin-password.mjs scripts/generation-runtime.mjs scripts/generation-worker-policy.mjs scripts/generation-worker.mjs scripts/disaster-recovery-core.mjs scripts/disaster-object-storage.mjs scripts/disaster-backup.mjs scripts/disaster-restore.mjs scripts/local-data-migration.mjs scripts/restore-private-files.mjs scripts/restore-private-migration.mjs; do
    mkdir -p "/output/web/$(dirname "$file")"
    cp -a "$file" "/output/web/$file"
done
mkdir -p /output/web/node_modules/.pnpm
rm -rf /output/web/node_modules/yaml
cp -aL node_modules/yaml /output/web/node_modules/yaml
test -f /output/web/node_modules/yaml/package.json
find node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-*' -exec cp -a {} /output/web/node_modules/.pnpm/ \;
test -n "$(find /output/web/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-linux-*' -print -quit)"
test -n "$(find /output/web/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-libvips-linux-*' -print -quit)"
cd /output/web
node -e 'require("sharp")'
while IFS= read -r file || [ -n "$file" ]; do
    [ -n "$file" ] || continue
    mkdir -p "/output/python/$(dirname "$file")"
    cp -a "/input/$file" "/output/python/$file"
done < /input/python-runtime-files.txt
BUILDER
    docker run --rm --pull never --user 0 --entrypoint sh \
        -v "$BUILD_TMP/input:/input:ro" -v "$BUILD_TMP:/output" -v "$BUILD_TMP/build.sh:/tmp/build.sh:ro" \
        -e HTTP_PROXY -e HTTPS_PROXY -e ALL_PROXY -e NO_PROXY -e http_proxy -e https_proxy -e all_proxy -e no_proxy \
        "$APP_IMAGE" -ec 'sh /tmp/build.sh' || die "Linux standalone 构建失败；未修改 Compose 或运行容器"
    fi
    printf '%s\n' "$RELEASE_ID" > "$BUILD_TMP/release-id"
    printf 'compose_sha256=%s\n' "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" > "$BUILD_TMP/metadata"
    printf 'project=%s\n' "$COMPOSE_PROJECT" >> "$BUILD_TMP/metadata"
    printf 'compose=%s\nexpected_build_id=%s\ngptapi_image=%s\ngptapi_python_version=%s\napp_service=%s\nworker_service=%s\ngptapi_service=%s\n' \
        "$COMPOSE_FILE" "$EXPECTED_BUILD_ID" "$GPTAPI_IMAGE" "$GPTAPI_PYTHON_VERSION" "$APP_SERVICE" "$WORKER_SERVICE" "$GPTAPI_SERVICE" >> "$BUILD_TMP/metadata"
    printf 'package_mode=%s\n' "$PACKAGE_MODE" >> "$BUILD_TMP/metadata"
    (cd "$BUILD_TMP" && find web python -type f -print0 | sort -z | xargs -0 sha256sum) > "$BUILD_TMP/SHA256SUMS"
    (cd "$BUILD_TMP" && find web python -type l -printf '%P\t%l\n' | LC_ALL=C sort) > "$BUILD_TMP/SYMLINKS"
    printf 'symlinks_sha256=%s\n' "$(sha256sum "$BUILD_TMP/SYMLINKS" | awk '{print $1}')" >> "$BUILD_TMP/metadata"
    mv "$BUILD_TMP" "$RELEASE_DIR"
    trap - EXIT
    printf '%s\n' "$RELEASE_ID" > "$STATE_DIR/staged-release"
    printf '已暂存 Linux standalone release：%s\nCompose、容器和数据卷未改动。\n' "$RELEASE_DIR"
    exit 0
fi

if [[ "$ACTION" == apply ]]; then
    [[ -n "$RELEASE_ID" ]] || RELEASE_ID="$(cat "$STATE_DIR/staged-release" 2>/dev/null || true)"
    [[ -n "$RELEASE_ID" && "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "没有有效的 staged release；先运行默认 --stage"
    RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
    [[ -d "$RELEASE_DIR/web" && -f "$RELEASE_DIR/metadata" && -f "$RELEASE_DIR/SHA256SUMS" ]] || die "staged release 不完整"
    (cd "$RELEASE_DIR" && sha256sum -c SHA256SUMS >/dev/null) || die "release 校验失败"
    [[ "$(sha256sum "$RELEASE_DIR/SYMLINKS" | awk '{print $1}')" == "$(sed -n 's/^symlinks_sha256=//p' "$RELEASE_DIR/metadata")" ]] || die "release 符号链接清单校验失败"
    current_symlinks="$(cd "$RELEASE_DIR" && find web python -type l -printf '%P\t%l\n' | LC_ALL=C sort)"
    [[ "$current_symlinks" == "$(cat "$RELEASE_DIR/SYMLINKS")" ]] || die "release 符号链接目标发生变化"
    [[ "$(sed -n 's/^compose_sha256=//p' "$RELEASE_DIR/metadata")" == "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" ]] || die "stage 后 Compose 文件已变化；请重新 stage 并复核拓扑"
    [[ "$(sed -n 's/^project=//p' "$RELEASE_DIR/metadata")" == "$COMPOSE_PROJECT" ]] || die "release 与当前 Compose 项目不匹配"
    [[ "$(sed -n 's/^compose=//p' "$RELEASE_DIR/metadata")" == "$COMPOSE_FILE" ]] || die "release 与当前 Compose 文件不匹配"
    [[ "$(sed -n 's/^expected_build_id=//p' "$RELEASE_DIR/metadata")" == "$EXPECTED_BUILD_ID" ]] || die "release 构建基线与当前上传包不一致"
    [[ "$(sed -n 's/^gptapi_image=//p' "$RELEASE_DIR/metadata")" == "$GPTAPI_IMAGE" ]] || die "stage 后 GPTAPI 镜像发生变化；请重新 stage 并复核"
    [[ "$(sed -n 's/^gptapi_python_version=//p' "$RELEASE_DIR/metadata")" == "$GPTAPI_PYTHON_VERSION" ]] || die "stage 后 GPTAPI Python 运行时发生变化；请重新 stage 并复核"
    [[ "$(sed -n 's/^app_service=//p' "$RELEASE_DIR/metadata")" == "$APP_SERVICE" && "$(sed -n 's/^worker_service=//p' "$RELEASE_DIR/metadata")" == "$WORKER_SERVICE" && "$(sed -n 's/^gptapi_service=//p' "$RELEASE_DIR/metadata")" == "$GPTAPI_SERVICE" ]] || die "release 服务名与当前参数不匹配"
    timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
    BACKUP_FILE="$STATE_DIR/backups/$(basename "$COMPOSE_FILE").$timestamp.bak"
    cp -p "$COMPOSE_FILE" "$BACKUP_FILE"
    CACHE_DIR="$STATE_DIR/runtime/web-cache"
    [[ ! -L "$STATE_DIR" && ! -L "$STATE_DIR/runtime" && ! -L "$CACHE_DIR" ]] || die "拒绝使用符号链接 cache 路径"
    mkdir -p "$CACHE_DIR"
    docker run --rm --pull never --network none --user 0 \
        -v "$CACHE_DIR:/managed-cache" -e APP_UID="$APP_UID" -e APP_GID="$APP_GID" \
        --entrypoint sh "$APP_IMAGE" -ec 'chown -R "$APP_UID:$APP_GID" /managed-cache && chmod 0750 /managed-cache' \
        || die "无法将独立 Next cache 目录归属给 App 容器用户 UID:GID $APP_UID:$APP_GID"
    YAML_TMP="$(mktemp "$STATE_DIR/yaml-update.XXXXXX.mjs")"
    trap 'rm -f -- "$YAML_TMP"' EXIT
    cat > "$YAML_TMP" <<'YAML'
import { readFileSync, writeFileSync, renameSync, statSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseDocument } = require('/yaml');
const { createHash } = require('node:crypto');
const [composePath, appPath, workerPath, pythonListPath] = process.argv.slice(2);
const document = parseDocument(readFileSync(composePath, 'utf8'));
if (document.errors.length) throw new Error('Compose YAML 无法解析');
const managed = '/.source-update/';
function nodeValue(item) {
  return item && typeof item.toJSON === 'function' ? item.toJSON() : item;
}
function targetOf(item) {
  const value = nodeValue(item);
  if (typeof value === 'string') return value.split(':')[1] || '';
  return value?.target || '';
}
function sourceOf(item) {
  const value = nodeValue(item);
  if (typeof value === 'string') return value.split(':')[0] || '';
  return value?.source || '';
}
function volumesFor(serviceName) {
  const service = document.getIn(['services', serviceName], true);
  if (!service) throw new Error(`Compose 中缺少服务 ${serviceName}`);
  let volumes = service.get('volumes', true);
  if (!volumes) { service.set('volumes', document.createNode([])); volumes = service.get('volumes', true); }
  if (!Array.isArray(volumes.items)) throw new Error(`服务 ${serviceName} 的 volumes 不是列表`);
  return volumes;
}
function setMount(serviceName, target, source, readOnly = true) {
  const volumes = volumesFor(serviceName);
  const matches = volumes.items.filter(item => targetOf(item) === target);
  for (const item of matches) {
    if (!sourceOf(item).includes(managed)) throw new Error(`拒绝覆盖非本脚本管理的 mount: ${serviceName}:${target}`);
  }
  volumes.items = volumes.items.filter(item => targetOf(item) !== target);
  volumes.add({ type: 'bind', source, target, read_only: readOnly });
}
function mountFor(serviceName, target) {
  return volumesFor(serviceName).items.find(item => targetOf(item) === target);
}
function writableNestedMount(serviceName, target) {
  const item = mountFor(serviceName, target);
  if (!item) throw new Error(`服务 ${serviceName} 缺少持久化 mount ${target}`);
  const value = nodeValue(item);
  if (value.read_only === true || (typeof value === 'string' && value.endsWith(':ro'))) throw new Error(`持久化 mount 必须可写：${serviceName}:${target}`);
}
const appService = process.env.APP_SERVICE;
const workerService = process.env.WORKER_SERVICE;
const gptapiService = process.env.GPTAPI_SERVICE;
const app = document.getIn(['services', appService]).toJSON();
const env = app?.environment || {};
if (env.DREAMYO_DATABASE_PROVIDER !== 'postgres' || !String(env.DATABASE_URL || '').includes('DATABASE_URL')) throw new Error('只支持已配置外部 PostgreSQL 的 Compose 服务');
writableNestedMount(appService, '/app/web/.data');
writableNestedMount(appService, '/app/web/.magic-proxy-runtime');
setMount(appService, '/app/web', appPath);
setMount(appService, '/app/web/.next/cache', process.env.CACHE_DIR, false);
setMount(workerService, '/app/web', workerPath);
for (const relative of readFileSync(pythonListPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
  if (!/^services\/chatgpt-api\/[A-Za-z0-9._/-]+\.py$/.test(relative) || relative.includes('..')) throw new Error('Python runtime 清单路径无效');
  setMount(gptapiService, `/app/${relative}`, `${process.env.RELEASE_DIR}/python/${relative}`);
}
const original = statSync(composePath);
const temp = `${composePath}.source-update-${process.pid}.tmp`;
writeFileSync(temp, document.toString(), { mode: original.mode & 0o777 });
chmodSync(temp, original.mode & 0o777);
const expectedHashMarker = process.env.SOURCE_UPDATE_EXPECTED_COMPOSE_HASH;
if (expectedHashMarker) {
  if (!expectedHashMarker.startsWith('/compose/.catalog-update-expected-hash')) throw new Error('事务 Compose 哈希标记路径无效');
  const hash = createHash('sha256').update(document.toString()).digest('hex');
  const markerTemp = `${expectedHashMarker}.${process.pid}.tmp`;
  writeFileSync(markerTemp, `${hash}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(markerTemp, expectedHashMarker);
}
renameSync(temp, composePath);
YAML
    COMPOSE_HASH_MARKER_CONTAINER=""
    COMPOSE_HASH_MARKER_ARGS=()
    SOURCE_UPDATE_EXPECTED_COMPOSE_HASH="${DREAMYO_SOURCE_UPDATE_COMPOSE_HASH_MARKER:-}"
    if [[ -n "$SOURCE_UPDATE_EXPECTED_COMPOSE_HASH" ]]; then
        [[ "$(dirname "$SOURCE_UPDATE_EXPECTED_COMPOSE_HASH")" == "$(dirname "$COMPOSE_FILE")" && "$SOURCE_UPDATE_EXPECTED_COMPOSE_HASH" != *$'\n'* && "$SOURCE_UPDATE_EXPECTED_COMPOSE_HASH" != *$'\r'* && ! -L "$SOURCE_UPDATE_EXPECTED_COMPOSE_HASH" ]] || die "事务 Compose 哈希标记必须位于 Compose 同一目录且不可为符号链接"
        COMPOSE_HASH_MARKER_CONTAINER="/compose/$(basename "$SOURCE_UPDATE_EXPECTED_COMPOSE_HASH")"
        COMPOSE_HASH_MARKER_ARGS=(-e "SOURCE_UPDATE_EXPECTED_COMPOSE_HASH=$COMPOSE_HASH_MARKER_CONTAINER")
    fi
    docker run --rm --pull never --network none --user 0 --entrypoint node \
        -v "$(dirname "$COMPOSE_FILE"):/compose:rw" -v "$YAML_TMP:/tmp/yaml-update.mjs:ro" \
        -v "$RELEASE_DIR/web/node_modules/yaml:/yaml:ro" \
        -v "$PACKAGE_DIR/python-runtime-files.txt:/tmp/python-runtime-files.txt:ro" \
        -e APP_SERVICE="$APP_SERVICE" -e WORKER_SERVICE="$WORKER_SERVICE" -e GPTAPI_SERVICE="$GPTAPI_SERVICE" -e RELEASE_DIR="$RELEASE_DIR" -e CACHE_DIR="$CACHE_DIR" \
        "${COMPOSE_HASH_MARKER_ARGS[@]}" \
        "$APP_IMAGE" /tmp/yaml-update.mjs "/compose/$(basename "$COMPOSE_FILE")" "$RELEASE_DIR/web" "$RELEASE_DIR/web" /tmp/python-runtime-files.txt || { restore_compose_backup "$BACKUP_FILE"; die "Compose 安全更新失败，原配置已恢复"; }
    if ! docker compose "${compose_args[@]}" config -q; then
        restore_compose_backup "$BACKUP_FILE"
        die "Compose 合并校验失败，原配置已恢复；备份保留在 $BACKUP_FILE"
    fi
    if ! compose_apply; then
        restore_compose_backup "$BACKUP_FILE"
        docker compose "${compose_args[@]}" config -q || die "更新失败且原 Compose 校验未通过；备份保留：$BACKUP_FILE"
        compose_apply || die "更新失败，已恢复旧 Compose，但旧服务健康检查仍失败；备份保留：$BACKUP_FILE"
        die "新版本健康检查失败，已自动恢复旧 Compose 和服务；备份保留：$BACKUP_FILE"
    fi
    printf 'backup=%s\nbackup_sha256=%s\napplied_sha256=%s\nrelease=%s\nproject=%s\ncompose=%s\napp_service=%s\nworker_service=%s\ngptapi_service=%s\n' \
        "$BACKUP_FILE" "$(sha256sum "$BACKUP_FILE" | awk '{print $1}')" \
        "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" "$RELEASE_DIR" "$COMPOSE_PROJECT" "$COMPOSE_FILE" \
        "$APP_SERVICE" "$WORKER_SERVICE" "$GPTAPI_SERVICE" > "$STATE_DIR/last-apply"
    printf '增量更新完成：%s\n已重建服务：%s %s %s\nCompose 备份：%s\n数据卷、.env、数据库和其他服务未修改。\n' "$RELEASE_DIR" "$APP_SERVICE" "$WORKER_SERVICE" "$GPTAPI_SERVICE" "$BACKUP_FILE"
fi

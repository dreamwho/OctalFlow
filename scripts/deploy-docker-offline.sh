#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

die() {
    printf '部署失败：%s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "服务器缺少命令：$1"
}

require_command docker
docker info >/dev/null 2>&1 || die "Docker 引擎未运行，请先启动 Docker Engine"
docker compose version >/dev/null 2>&1 || die "服务器需要 Docker Compose v2 插件"

DATABASE_MODE="${OCTALAICANVAS_DATABASE_MODE:-embedded}"
if [[ "$DATABASE_MODE" == external ]]; then
    COMPOSE_FILE="${OCTALAICANVAS_COMPOSE_FILE:-docker-compose.offline-external-db.yml}"
else
    COMPOSE_FILE="${OCTALAICANVAS_COMPOSE_FILE:-docker-compose.offline.yml}"
fi
ENV_FILE="$SCRIPT_DIR/.env"
MANIFEST_FILE="$SCRIPT_DIR/manifest.env"
[[ -f "$MANIFEST_FILE" ]] || die "缺少镜像清单：$MANIFEST_FILE"

# manifest.env 只由构建脚本生成，内容是固定键值，不包含密钥。
# shellcheck disable=SC1090
source "$MANIFEST_FILE"

DATABASE_MODE="${OCTALAICANVAS_DATABASE_MODE:-$DATABASE_MODE}"
COMPOSE_FILE="${OCTALAICANVAS_COMPOSE_FILE:-$COMPOSE_FILE}"
MAGIC_PROXY_IMAGE="${OCTALAICANVAS_MAGIC_PROXY_IMAGE:-metacubex/mihomo:v1.19.30}"
case "$DATABASE_MODE" in
    embedded|external) ;;
    *) die "部署包数据库模式无效：$DATABASE_MODE" ;;
esac
[[ -f "$COMPOSE_FILE" ]] || die "缺少 Compose 文件：$COMPOSE_FILE"

PACKAGE_PLATFORM="${OCTALAICANVAS_DOCKER_PLATFORM:-linux/amd64}"
case "$(uname -m)" in
    x86_64|amd64) HOST_PLATFORM="linux/amd64" ;;
    aarch64|arm64) HOST_PLATFORM="linux/arm64" ;;
    *) HOST_PLATFORM="unknown" ;;
esac
if [[ "$HOST_PLATFORM" != "$PACKAGE_PLATFORM" ]]; then
    if [[ "${OCTALAICANVAS_ALLOW_PLATFORM_EMULATION:-0}" != "1" ]]; then
        die "镜像包平台为 ${PACKAGE_PLATFORM}，但服务器架构为 ${HOST_PLATFORM}。请使用匹配架构的部署包。"
    fi
    printf '警告：使用 Docker 的跨架构仿真运行 %s 镜像，正式服务器应使用匹配架构的部署包。\n' "$PACKAGE_PLATFORM" >&2
fi

generate_token() {
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

read_env_value() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || return 0
    awk -v key="$key" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$ENV_FILE"
}

set_env_value() {
    local key="$1"
    local value="$2"
    local temp_file
    temp_file="$(mktemp "$SCRIPT_DIR/.env.XXXXXX")"
    awk -v key="$key" -v value="$value" '
        BEGIN { replaced = 0 }
        index($0, key "=") == 1 {
            if (!replaced) print key "=" value
            replaced = 1
            next
        }
        { print }
        END { if (!replaced) print key "=" value }
    ' "$ENV_FILE" > "$temp_file"
    mv -- "$temp_file" "$ENV_FILE"
}

ensure_env_value() {
    local key="$1"
    local default_value="$2"
    local current_value
    current_value="$(read_env_value "$key")"
    if [[ -z "$current_value" ]]; then
        set_env_value "$key" "$default_value"
    fi
}

if [[ ! -f "$ENV_FILE" ]]; then
    umask 077
    : > "$ENV_FILE"
fi
chmod 0600 "$ENV_FILE"

ensure_env_value NEXT_PUBLIC_SITE_URL "${NEXT_PUBLIC_SITE_URL:-http://localhost:3000}"
set_env_value OCTALAICANVAS_DOCKER_PLATFORM "$PACKAGE_PLATFORM"
set_env_value OCTALAICANVAS_IMAGE "$OCTALAICANVAS_IMAGE"
set_env_value OCTALAICANVAS_GEMINIAI_IMAGE "$OCTALAICANVAS_GEMINIAI_IMAGE"
set_env_value OCTALAICANVAS_MAGIC_PROXY_IMAGE "$MAGIC_PROXY_IMAGE"
if [[ "$DATABASE_MODE" == embedded ]]; then
    set_env_value OCTALAICANVAS_POSTGRES_IMAGE "$OCTALAICANVAS_POSTGRES_IMAGE"
fi
if [[ "$DATABASE_MODE" == embedded ]]; then
    ensure_env_value POSTGRES_DB "${POSTGRES_DB:-octalaicanvas}"
    ensure_env_value POSTGRES_USER "${POSTGRES_USER:-octalaicanvas}"
    ensure_env_value POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-$(generate_token)}"
fi
ensure_env_value OCTALAICANVAS_DATABASE_PROVIDER postgres
ensure_env_value OCTALAICANVAS_DATA_DIR /app/web/.data
ensure_env_value OCTALAICANVAS_INTERNAL_ORIGIN http://127.0.0.1:3000
ensure_env_value OCTALAICANVAS_BIND_ADDRESS "${OCTALAICANVAS_BIND_ADDRESS:-0.0.0.0}"
ensure_env_value OCTALAICANVAS_COOKIE_SECURE "${OCTALAICANVAS_COOKIE_SECURE:-0}"
if [[ "$DATABASE_MODE" == external ]]; then
    ensure_env_value OCTALAICANVAS_TRUSTED_PROXY_HOPS "${OCTALAICANVAS_TRUSTED_PROXY_HOPS:-1}"
else
    ensure_env_value OCTALAICANVAS_TRUSTED_PROXY_HOPS "${OCTALAICANVAS_TRUSTED_PROXY_HOPS:-0}"
fi
ensure_env_value OCTALAICANVAS_GEMINIAI_API_KEY "${OCTALAICANVAS_GEMINIAI_API_KEY:-$(generate_token)}"
ensure_env_value OCTALAICANVAS_MAGIC_PROXY_SECRET "${OCTALAICANVAS_MAGIC_PROXY_SECRET:-$(generate_token)}"
ensure_env_value OCTALAICANVAS_ENCRYPTION_KEY "${OCTALAICANVAS_ENCRYPTION_KEY:-$(generate_token)}"
ensure_env_value OCTALAICANVAS_INSTALL_TOKEN "${OCTALAICANVAS_INSTALL_TOKEN:-$(generate_token)}"
ensure_env_value OCTALAICANVAS_MAINTENANCE_TOKEN "${OCTALAICANVAS_MAINTENANCE_TOKEN:-$(generate_token)}"

if [[ "$DATABASE_MODE" == external ]]; then
    database_url="$(read_env_value DATABASE_URL)"
    if [[ -z "$database_url" ]]; then
        database_url="${OCTALAICANVAS_DATABASE_URL:-${DATABASE_URL:-}}"
    fi
    if [[ -z "$database_url" && -t 0 ]]; then
        read -r -p "请输入已有 Docker PostgreSQL 的 DATABASE_URL：" database_url
    fi
    [[ "$database_url" =~ ^postgres(ql)?:// ]] || die "external 模式必须提供有效的 DATABASE_URL，例如 postgres://用户:密码@127.0.0.1:5432/数据库"
    set_env_value DATABASE_URL "$database_url"
fi

worker_token="$(read_env_value OCTALAICANVAS_WORKER_TOKEN)"
maintenance_token="$(read_env_value OCTALAICANVAS_MAINTENANCE_TOKEN)"
if [[ -z "$worker_token" || "$worker_token" == "$maintenance_token" ]]; then
    set_env_value OCTALAICANVAS_WORKER_TOKEN "${OCTALAICANVAS_WORKER_TOKEN:-$(generate_token)}"
    worker_token="$(read_env_value OCTALAICANVAS_WORKER_TOKEN)"
    if [[ "$worker_token" == "$maintenance_token" ]]; then
        set_env_value OCTALAICANVAS_WORKER_TOKEN "$(generate_token)"
    fi
fi

encryption_key="$(read_env_value OCTALAICANVAS_ENCRYPTION_KEY)"
[[ "${#encryption_key}" -ge 32 ]] || die "OCTALAICANVAS_ENCRYPTION_KEY 至少需要 32 个字符"
for key in OCTALAICANVAS_INSTALL_TOKEN OCTALAICANVAS_MAINTENANCE_TOKEN OCTALAICANVAS_WORKER_TOKEN OCTALAICANVAS_GEMINIAI_API_KEY OCTALAICANVAS_MAGIC_PROXY_SECRET; do
    value="$(read_env_value "$key")"
    [[ "${#value}" -ge 32 ]] || die "$key 至少需要 32 个字符"
done

for archive in "$SCRIPT_DIR"/images/*.tar; do
    [[ -f "$archive" ]] || die "images/ 下没有镜像归档"
    printf '加载镜像：%s\n' "$(basename "$archive")"
    docker load --input "$archive"
done

docker image inspect "$(read_env_value OCTALAICANVAS_IMAGE)" >/dev/null 2>&1 || die "主应用镜像未加载"
docker image inspect "$(read_env_value OCTALAICANVAS_GEMINIAI_IMAGE)" >/dev/null 2>&1 || die "GeminiAI 镜像未加载"
docker image inspect "$(read_env_value OCTALAICANVAS_MAGIC_PROXY_IMAGE)" >/dev/null 2>&1 || die "Mihomo 镜像未加载"
if [[ "$DATABASE_MODE" == embedded ]]; then
    docker image inspect "${OCTALAICANVAS_POSTGRES_IMAGE:-postgres:16.6-alpine}" >/dev/null 2>&1 || die "PostgreSQL 镜像未加载"
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null || die "Compose 配置校验失败"
printf '启动服务……\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

health_timeout="${OCTALAICANVAS_DEPLOY_HEALTH_TIMEOUT_SECONDS:-600}"
poll_seconds="${OCTALAICANVAS_DEPLOY_HEALTH_POLL_SECONDS:-2}"
[[ "$health_timeout" =~ ^[0-9]+$ && "$health_timeout" -gt 0 ]] || die "OCTALAICANVAS_DEPLOY_HEALTH_TIMEOUT_SECONDS 必须为正整数"
[[ "$poll_seconds" =~ ^[0-9]+$ && "$poll_seconds" -gt 0 ]] || die "OCTALAICANVAS_DEPLOY_HEALTH_POLL_SECONDS 必须为正整数"

container_health() {
    docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || printf 'missing'
}

deadline=$((SECONDS + health_timeout))
while (( SECONDS < deadline )); do
    if [[ "$DATABASE_MODE" == embedded ]]; then
        postgres_health="$(container_health octalaicanvas-postgres)"
    else
        postgres_health="external"
    fi
    magic_proxy_health="$(container_health octalaicanvas-magic-proxy)"
    geminiai_health="$(container_health octalaicanvas-geminiai)"
    app_health="$(container_health octalaicanvas)"
    worker_health="$(container_health octalaicanvas-generation-worker)"
    printf '\r健康检查：postgres=%s magic-proxy=%s geminiai=%s app=%s worker=%s' "$postgres_health" "$magic_proxy_health" "$geminiai_health" "$app_health" "$worker_health"
    if [[ "$magic_proxy_health" == healthy && "$geminiai_health" == healthy && "$app_health" == healthy && "$worker_health" == running && ( "$DATABASE_MODE" == external || "$postgres_health" == healthy ) ]]; then
        printf '\n'
        break
    fi
    sleep "$poll_seconds"
done

if [[ "$DATABASE_MODE" == embedded && "$(container_health octalaicanvas-postgres)" != healthy || "$(container_health octalaicanvas-magic-proxy)" != healthy || "$(container_health octalaicanvas-geminiai)" != healthy || "$(container_health octalaicanvas)" != healthy || "$(container_health octalaicanvas-generation-worker)" != running ]]; then
    printf '\n服务未在配置的时间内全部就绪，最近日志如下：\n' >&2
    if [[ "$DATABASE_MODE" == embedded ]]; then
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=120 magic-proxy app generation-worker geminiai postgres >&2 || true
    else
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=120 magic-proxy app generation-worker geminiai >&2 || true
    fi
    exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
install_token="$(read_env_value OCTALAICANVAS_INSTALL_TOKEN)"
printf '\n部署完成。\n'
printf '安装向导：http://服务器IP:3000/install\n'
printf '首次安装令牌：%s\n' "$install_token"
printf '令牌只用于创建首个管理员，完成后可从 .env 删除 OCTALAICANVAS_INSTALL_TOKEN。\n'
printf '查看日志：docker compose --env-file .env -f %s logs -f magic-proxy app generation-worker geminiai\n' "$COMPOSE_FILE"

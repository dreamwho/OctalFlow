#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PRIVATE_SETTINGS_SYNC_VOLUME=""
cleanup_private_settings_sync_volume() {
    if [[ -n "$PRIVATE_SETTINGS_SYNC_VOLUME" ]]; then
        docker volume rm "$PRIVATE_SETTINGS_SYNC_VOLUME" >/dev/null 2>&1 || printf '警告：未能清理临时私有同步卷 %s\n' "$PRIVATE_SETTINGS_SYNC_VOLUME" >&2
    fi
}
trap cleanup_private_settings_sync_volume EXIT

die() {
    printf '部署失败：%s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "服务器缺少命令：$1"
}

require_checksum_command() {
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || die "服务器缺少 SHA-256 校验命令：sha256sum 或 shasum"
}

checksum_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

safe_relative_path() {
    case "$1" in
        ""|/*|../*|*/../*|*//*) return 1 ;;
        *) return 0 ;;
    esac
}

checksum_expected_for_path() {
    local relative_path="$1"
    local line expected listed_path checksum="" found=0

    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || die "SHA256SUMS 格式无效"
        expected="${BASH_REMATCH[1]}"
        listed_path="${BASH_REMATCH[2]}"
        safe_relative_path "$listed_path" || die "SHA256SUMS 包含不安全路径：$listed_path"
        if [[ "$listed_path" == "$relative_path" ]]; then
            found=$((found + 1))
            checksum="$expected"
        fi
    done < "$CHECKSUM_FILE"

    [[ "$found" -eq 1 ]] || die "SHA256SUMS 缺少或重复声明：$relative_path"
    printf '%s' "$checksum"
}

verify_checksum_path() {
    local relative_path="$1"
    local file_path="$SCRIPT_DIR/$relative_path"
    local expected actual

    safe_relative_path "$relative_path" || die "部署包路径无效：$relative_path"
    [[ -f "$file_path" && ! -L "$file_path" ]] || die "部署包缺少常规文件：$relative_path"
    expected="$(checksum_expected_for_path "$relative_path")"
    actual="$(checksum_file "$file_path")"
    [[ "$actual" == "$expected" ]] || die "SHA-256 校验失败：$relative_path (预期: $expected, 实际: $actual)"
}

read_manifest_value() {
    local key="$1"
    local line value="" found=0

    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "镜像清单键无效：$key"
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "$key="* ]]; then
            found=$((found + 1))
            value="${line#"$key="}"
        fi
    done < "$MANIFEST_FILE"
    [[ "$found" -eq 1 && -n "$value" ]] || die "镜像清单缺少或重复声明：$key"
    printf '%s' "$value"
}

validate_platform() {
    case "$1" in
        linux/amd64|linux/arm64) ;;
        *) die "镜像包平台无效：$1" ;;
    esac
}

validate_port() {
    local port="$1"

    [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || die "DREAMYO_PORT 或 .env PORT 必须是 1-65535 的整数"
    (( 10#$port <= 65535 )) || die "DREAMYO_PORT 或 .env PORT 必须是 1-65535 的整数"
}

verify_image_archive_platform() {
    local archive="$1"
    local platform="$2"
    local architecture="${platform#linux/}"
    local manifest_json config_file config_json

    manifest_json="$(tar -xOf "$archive" manifest.json 2>/dev/null)" || die "镜像归档损坏或缺少 manifest.json：$(basename "$archive")"
    config_file="$(printf '%s\n' "$manifest_json" | sed -nE 's/.*"Config"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
    [[ -n "$config_file" && "$config_file" != *$'\n'* ]] || die "镜像归档缺少唯一 Config 元数据：$(basename "$archive")"
    safe_relative_path "$config_file" || die "镜像归档 Config 路径无效：$(basename "$archive")"
    config_json="$(tar -xOf "$archive" "$config_file" 2>/dev/null)" || die "镜像归档 Config 无法读取：$(basename "$archive")"
    printf '%s' "$config_json" | grep -Eq "\"os\"[[:space:]]*:[[:space:]]*\"linux\"" || die "镜像归档不是 Linux 镜像：$(basename "$archive")"
    printf '%s' "$config_json" | grep -Eq "\"architecture\"[[:space:]]*:[[:space:]]*\"${architecture}\"" || die "镜像归档架构与 ${platform} 不一致：$(basename "$archive")"
}

resolve_expected_image_archives() {
    local -a archives=()
    local line

    # 优先从 SHA256SUMS 中动态匹配已声明的 images/*.tar 镜像归档
    if [[ -f "$CHECKSUM_FILE" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            if [[ "$line" =~ ^[0-9a-f]{64}\ \ (images/[^/]+\.tar)$ ]]; then
                archives+=("${BASH_REMATCH[1]}")
            fi
        done < "$CHECKSUM_FILE"
    fi

    # 若 SHA256SUMS 未包含镜像归档，则结合 manifest.env 与数据库模式动态构建
    if [[ "${#archives[@]}" -eq 0 ]]; then
        archives=(images/app.tar images/geminiai.tar)
        if grep -q '^DREAMYO_MAGIC_PROXY_IMAGE=' "$MANIFEST_FILE" 2>/dev/null || [[ -f "$SCRIPT_DIR/images/magic-proxy.tar" ]]; then
            archives+=(images/magic-proxy.tar)
        fi
        if [[ "$DATABASE_MODE" == "embedded" ]] || grep -q '^DREAMYO_POSTGRES_IMAGE=' "$MANIFEST_FILE" 2>/dev/null || [[ -f "$SCRIPT_DIR/images/postgres.tar" ]]; then
            archives+=(images/postgres.tar)
        fi
    fi

    printf '%s\n' "${archives[@]}"
}

verify_image_archives() {
    local -a actual_archives=()
    local image_count expected_image_count
    local archive archive_path expected_archive expected_path

    [[ -d "$SCRIPT_DIR/images" && ! -L "$SCRIPT_DIR/images" ]] || die "images 目录无效"
    shopt -s nullglob
    actual_archives=("$SCRIPT_DIR"/images/*.tar)
    shopt -u nullglob

    image_count="${#actual_archives[@]}"
    expected_image_count="${#IMAGE_ARCHIVES[@]}"
    [[ "$image_count" -eq "$expected_image_count" ]] || die "images/ 下的镜像归档数量与清单不一致"

    for archive in "${actual_archives[@]}"; do
        archive_path="images/$(basename "$archive")"
        expected_archive=0
        for expected_path in "${IMAGE_ARCHIVES[@]}"; do
            [[ "$archive_path" == "$expected_path" ]] && expected_archive=1
        done
        [[ "$expected_archive" -eq 1 ]] || die "images/ 下包含未声明的镜像归档：$(basename "$archive")"
    done
    for archive_path in "${IMAGE_ARCHIVES[@]}"; do
        verify_image_archive_platform "$SCRIPT_DIR/$archive_path" "$PACKAGE_PLATFORM"
    done
}

decode_env_value() {
    local raw="$1"
    local inner result="" character next_character
    local index=0 last_index

    [[ "${#raw}" -ge 2 ]] || {
        printf '%s' "$raw"
        return
    }
    last_index=$((${#raw} - 1))
    if [[ "${raw:0:1}" == "'" && "${raw:last_index:1}" == "'" ]]; then
        inner="${raw:1:$((last_index - 1))}"
        while (( index < ${#inner} )); do
            character="${inner:index:1}"
            if [[ "$character" == "\\" && $((index + 1)) -lt ${#inner} ]]; then
                next_character="${inner:$((index + 1)):1}"
                if [[ "$next_character" == "'" ]]; then
                    result+="'"
                    index=$((index + 2))
                    continue
                fi
            fi
            result+="$character"
            index=$((index + 1))
        done
        printf '%s' "$result"
        return
    fi
    if [[ "${raw:0:1}" == '"' && "${raw:last_index:1}" == '"' ]]; then
        printf '%s' "${raw:1:$((last_index - 1))}"
        return
    fi
    printf '%s' "$raw"
}

quote_env_value() {
    local value="$1"
    local quoted="" character
    local index=0

    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "环境变量值不能包含换行"
    while (( index < ${#value} )); do
        character="${value:index:1}"
        if [[ "$character" == "'" ]]; then
            quoted+="\\'"
        else
            quoted+="$character"
        fi
        index=$((index + 1))
    done
    printf "'%s'" "$quoted"
}

read_env_value() {
    local key="$1"
    local source_file="${2:-$ENV_FILE}"
    local line raw_value=""

    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "环境变量键无效：$key"
    [[ -f "$source_file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "$key="* ]]; then
            raw_value="${line#"$key="}"
        fi
    done < "$source_file"
    decode_env_value "$raw_value"
}

set_env_value() {
    local key="$1"
    local value="$2"
    local encoded_value temp_file line replaced=0

    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "环境变量键无效：$key"
    encoded_value="$(quote_env_value "$value")"
    temp_file="$(mktemp "$SCRIPT_DIR/.env.XXXXXX")"
    chmod 0600 "$temp_file"
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "$key="* ]]; then
            if [[ "$replaced" -eq 0 ]]; then
                printf '%s=%s\n' "$key" "$encoded_value" >> "$temp_file"
            fi
            replaced=1
        else
            printf '%s\n' "$line" >> "$temp_file"
        fi
    done < "$ENV_FILE"
    if [[ "$replaced" -eq 0 ]]; then
        printf '%s=%s\n' "$key" "$encoded_value" >> "$temp_file"
    fi
    mv "$temp_file" "$ENV_FILE"
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

MANIFEST_FILE="$SCRIPT_DIR/manifest.env"
CHECKSUM_FILE="$SCRIPT_DIR/SHA256SUMS"
ENV_FILE="$SCRIPT_DIR/.env"

require_command tar
require_checksum_command
[[ -f "$CHECKSUM_FILE" && ! -L "$CHECKSUM_FILE" ]] || die "缺少校验文件：$CHECKSUM_FILE"
[[ -f "$MANIFEST_FILE" && ! -L "$MANIFEST_FILE" ]] || die "缺少镜像清单：$MANIFEST_FILE"
verify_checksum_path manifest.env

PACKAGE_VERSION="$(read_manifest_value DREAMYO_PACKAGE_VERSION)"
PACKAGE_PLATFORM="$(read_manifest_value DREAMYO_DOCKER_PLATFORM)"
DATABASE_MODE="$(read_manifest_value DREAMYO_DATABASE_MODE)"
PRIVATE_MIGRATION=0
if grep -q '^DREAMYO_PRIVATE_MIGRATION=' "$MANIFEST_FILE"; then
    PRIVATE_MIGRATION="$(read_manifest_value DREAMYO_PRIVATE_MIGRATION)"
fi
[[ "$PRIVATE_MIGRATION" == 0 || "$PRIVATE_MIGRATION" == 1 ]] || die "私有迁移标记无效"
if [[ "$PRIVATE_MIGRATION" == 1 ]]; then
    [[ -d "$SCRIPT_DIR/private-migration" && "$DATABASE_MODE" == external ]] || die "私有迁移包缺失或不是已有 PostgreSQL 模式"
elif [[ -e "$SCRIPT_DIR/private-migration" ]]; then
    die "部署包存在未声明的私有迁移目录"
fi
PRIVATE_SETTINGS_SYNC=0
if grep -q '^DREAMYO_PRIVATE_SETTINGS_SYNC=' "$MANIFEST_FILE"; then
    PRIVATE_SETTINGS_SYNC="$(read_manifest_value DREAMYO_PRIVATE_SETTINGS_SYNC)"
fi
[[ "$PRIVATE_SETTINGS_SYNC" == 0 || "$PRIVATE_SETTINGS_SYNC" == 1 ]] || die "私有账号与代理同步标记无效"
if [[ "$PRIVATE_SETTINGS_SYNC" == 1 ]]; then
    [[ "$DATABASE_MODE" == external && -d "$SCRIPT_DIR/private-settings-sync" ]] || die "私有账号与代理同步只支持 external PostgreSQL 部署包"
elif [[ -e "$SCRIPT_DIR/private-settings-sync" ]]; then
    die "部署包存在未声明的私有账号与代理同步目录"
fi
[[ "$PRIVATE_MIGRATION" != 1 || "$PRIVATE_SETTINGS_SYNC" != 1 ]] || die "首次迁移快照与在线设置同步不能同时启用"
APP_IMAGE="$(read_manifest_value DREAMYO_IMAGE)"
GEMINIAI_IMAGE="$(read_manifest_value DREAMYO_GEMINIAI_IMAGE)"
MAGIC_PROXY_IMAGE=""
if grep -q '^DREAMYO_MAGIC_PROXY_IMAGE=' "$MANIFEST_FILE" 2>/dev/null; then
    MAGIC_PROXY_IMAGE="$(read_manifest_value DREAMYO_MAGIC_PROXY_IMAGE)"
fi
COMPOSE_FILE="$(read_manifest_value DREAMYO_COMPOSE_FILE)"
validate_platform "$PACKAGE_PLATFORM"

case "$DATABASE_MODE" in
    embedded)
        EXPECTED_COMPOSE_FILE="docker-compose.offline.yml"
        POSTGRES_IMAGE="$(read_manifest_value DREAMYO_POSTGRES_IMAGE)"
        ;;
    external)
        EXPECTED_COMPOSE_FILE="docker-compose.offline-external-db.yml"
        ;;
    *) die "部署包数据库模式无效：$DATABASE_MODE" ;;
esac
[[ "$COMPOSE_FILE" == "$EXPECTED_COMPOSE_FILE" ]] || die "镜像清单 Compose 文件与数据库模式不匹配"

IMAGE_ARCHIVES=()
while IFS= read -r item || [[ -n "$item" ]]; do
    [[ -n "$item" ]] && IMAGE_ARCHIVES+=("$item")
done < <(resolve_expected_image_archives)
expected_image_count="${#IMAGE_ARCHIVES[@]}"

PACKAGE_STATIC_FILES=(
    README.md
    manifest.env
    一键部署.sh
    "$COMPOSE_FILE"
    .env.example
    docker/mihomo/bootstrap.yaml
    docker/mihomo/bootstrap-host.yaml
    docker/mihomo/entrypoint.sh
)
SKIP_IMAGE_CHECK="${DREAMYO_SKIP_IMAGE_CHECK:-0}"
for package_file in "${PACKAGE_STATIC_FILES[@]}"; do
    verify_checksum_path "$package_file"
done
if [[ "$SKIP_IMAGE_CHECK" == "1" ]]; then
    printf '提示：已指定 DREAMYO_SKIP_IMAGE_CHECK=1，跳过镜像归档文件的 SHA-256 校验与平台架构检查。\n'
else
    for package_file in "${IMAGE_ARCHIVES[@]}"; do
        verify_checksum_path "$package_file"
    done
fi
if [[ "$PRIVATE_MIGRATION" == 1 ]]; then
    [[ ! -L "$SCRIPT_DIR/private-migration" ]] || die "私有迁移目录不能是符号链接"
    verify_checksum_path private-migration/manifest.json
    verify_checksum_path private-migration/private.env
    chmod 0700 "$SCRIPT_DIR/private-migration"
    chmod 0600 "$SCRIPT_DIR/private-migration/private.env"
fi
if [[ "$PRIVATE_SETTINGS_SYNC" == 1 ]]; then
    [[ ! -L "$SCRIPT_DIR/private-settings-sync" ]] || die "私有账号与代理同步目录不能是符号链接"
    [[ -z "$(find "$SCRIPT_DIR/private-settings-sync" -mindepth 1 -type l -print -quit)" ]] || die "私有账号与代理同步目录不能包含符号链接"
    while IFS= read -r -d '' private_sync_file; do
        relative_path="${private_sync_file#"$SCRIPT_DIR/"}"
        verify_checksum_path "$relative_path"
    done < <(find "$SCRIPT_DIR/private-settings-sync" -type f -print0)
    chmod 0700 "$SCRIPT_DIR/private-settings-sync"
    find "$SCRIPT_DIR/private-settings-sync" -type d -exec chmod 0700 {} +
    find "$SCRIPT_DIR/private-settings-sync" -type f -exec chmod 0600 {} +
fi

if [[ "$SKIP_IMAGE_CHECK" != "1" ]]; then
    verify_image_archives
fi

[[ "$(uname -s)" == Linux ]] || die "离线 Docker 包只能部署到 Linux 服务器"
case "$(uname -m)" in
    x86_64|amd64) HOST_PLATFORM="linux/amd64" ;;
    aarch64|arm64) HOST_PLATFORM="linux/arm64" ;;
    *) HOST_PLATFORM="unknown" ;;
esac
if [[ "$HOST_PLATFORM" != "$PACKAGE_PLATFORM" ]]; then
    if [[ "${DREAMYO_ALLOW_PLATFORM_EMULATION:-0}" != "1" ]]; then
        die "镜像包平台为 ${PACKAGE_PLATFORM}，但服务器架构为 ${HOST_PLATFORM}。请使用匹配架构的部署包。"
    fi
    printf '警告：使用 Docker 的跨架构仿真运行 %s 镜像，正式服务器应使用匹配架构的部署包。\n' "$PACKAGE_PLATFORM" >&2
fi

require_command docker
docker info >/dev/null 2>&1 || die "Docker 引擎未运行，请先启动 Docker Engine"
docker compose version >/dev/null 2>&1 || die "服务器需要 Docker Compose v2 插件"

if [[ -f "$ENV_FILE" ]]; then
    backup_file="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "$ENV_FILE" "$backup_file" 2>/dev/null || true
elif [[ ! -e "$ENV_FILE" ]]; then
    umask 077
    : > "$ENV_FILE"
    printf '警告：部署目录中没有旧 .env（重新上传部署包会覆盖它），数据库等连接信息需要重新配置；脚本会尝试从 .env.bak.* 备份恢复。\n' >&2
fi
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die ".env 必须是部署包中的常规文件"
chmod 0600 "$ENV_FILE"

generate_token() {
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

set_env_value DREAMYO_DOCKER_PLATFORM "$PACKAGE_PLATFORM"
set_env_value DREAMYO_IMAGE "$APP_IMAGE"
set_env_value DREAMYO_GEMINIAI_IMAGE "$GEMINIAI_IMAGE"
set_env_value DREAMYO_MAGIC_PROXY_IMAGE "$MAGIC_PROXY_IMAGE"
if [[ "$DATABASE_MODE" == embedded ]]; then
    set_env_value DREAMYO_POSTGRES_IMAGE "$POSTGRES_IMAGE"
    ensure_env_value POSTGRES_DB "${POSTGRES_DB:-dreamyo}"
    ensure_env_value POSTGRES_USER "${POSTGRES_USER:-dreamyo}"
    ensure_env_value POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-$(generate_token)}"
fi
ensure_env_value DREAMYO_DATABASE_PROVIDER postgres
ensure_env_value DREAMYO_DATA_DIR /app/web/.data
ensure_env_value DREAMYO_BIND_ADDRESS "${DREAMYO_BIND_ADDRESS:-0.0.0.0}"
ensure_env_value DREAMYO_COOKIE_SECURE "${DREAMYO_COOKIE_SECURE:-0}"
app_port="${DREAMYO_PORT:-}"
if [[ -z "$app_port" ]]; then
    app_port="$(read_env_value DREAMYO_PORT)"
fi
if [[ -z "$app_port" ]]; then
    app_port="$(read_env_value PORT)"
fi
if [[ -z "$app_port" ]]; then
    if [[ "$DATABASE_MODE" == external ]]; then
        app_port=8866
    else
        app_port=3000
    fi
fi
validate_port "$app_port"
set_env_value PORT "$app_port"
export PORT="$app_port"
set_env_value DREAMYO_PORT "$app_port"
export DREAMYO_PORT="$app_port"
set_env_value DREAMYO_INTERNAL_ORIGIN "http://127.0.0.1:$app_port"
install_port="$app_port"
ensure_env_value NEXT_PUBLIC_SITE_URL "${NEXT_PUBLIC_SITE_URL:-http://localhost:$install_port}"
ensure_env_value DREAMYO_TRUSTED_PROXY_HOPS "${DREAMYO_TRUSTED_PROXY_HOPS:-0}"
ensure_env_value DREAMYO_GEMINIAI_API_KEY "${DREAMYO_GEMINIAI_API_KEY:-$(generate_token)}"
ensure_env_value DREAMYO_CHATGPT_API_KEY "${DREAMYO_CHATGPT_API_KEY:-$(generate_token)}"
# GeminiTools OAuth 凭据由打包机注入部署包 .env.example，服务器 .env 缺失时自动种子
seed_env_from_example() {
    local key="$1" value
    value="$(read_env_value "$key")"
    [[ -n "$value" ]] && return 0
    value="$(grep -E "^${key}=" "$SCRIPT_DIR/.env.example" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
    [[ -n "$value" ]] && ensure_env_value "$key" "$value"
    return 0
}
seed_env_from_example GEMINI_TOOLS_OAUTH_CLIENT_ID
seed_env_from_example GEMINI_TOOLS_OAUTH_CLIENT_SECRET
seed_env_from_example DREAMYO_GEMINIAI_STUDIO_URL
seed_env_from_example DREAMYO_CHATGPT_API_PROXY_URL
seed_env_from_example DREAMYO_ENCRYPTION_KEY
seed_env_from_example DREAMYO_INSTALL_TOKEN
seed_env_from_example DREAMYO_MAINTENANCE_TOKEN
seed_env_from_example DREAMYO_WORKER_TOKEN
seed_env_from_example DREAMYO_GEMINIAI_API_KEY
seed_env_from_example DREAMYO_CHATGPT_API_KEY
seed_env_from_example DREAMYO_MAGIC_PROXY_SECRET
seed_env_from_example DREAMYO_ALLOW_PRIVATE_UPSTREAMS
seed_env_from_example DREAMYO_PRIVATE_UPSTREAM_HOSTS

ensure_env_value DREAMYO_CHATGPT_API_KEY "${DREAMYO_CHATGPT_API_KEY:-$(generate_token)}"
ensure_env_value DREAMYO_MAGIC_PROXY_SECRET "${DREAMYO_MAGIC_PROXY_SECRET:-$(generate_token)}"
ensure_env_value DREAMYO_ENCRYPTION_KEY "${DREAMYO_ENCRYPTION_KEY:-$(generate_token)}"
ensure_env_value DREAMYO_INSTALL_TOKEN "${DREAMYO_INSTALL_TOKEN:-$(generate_token)}"
ensure_env_value DREAMYO_MAINTENANCE_TOKEN "${DREAMYO_MAINTENANCE_TOKEN:-$(generate_token)}"
ensure_env_value DREAMYO_WORKER_TOKEN "${DREAMYO_WORKER_TOKEN:-$(generate_token)}"

if [[ "$DATABASE_MODE" == external ]]; then
    database_url="$(read_env_value DATABASE_URL)"
    if [[ -n "${DREAMYO_DATABASE_URL:-}" ]]; then
        database_url="$DREAMYO_DATABASE_URL"
        set_env_value DATABASE_URL "$database_url"
    elif [[ -z "$database_url" ]]; then
        # 重新上传部署包会覆盖目录内 .env 并丢失数据库连接；优先从最新备份恢复
        newest_env_backup="$(ls -1t "$SCRIPT_DIR"/.env.bak.* 2>/dev/null | head -n 1 || true)"
        if [[ -n "$newest_env_backup" ]]; then
            database_url="$(grep -E '^DATABASE_URL=' "$newest_env_backup" 2>/dev/null | tail -n 1 | cut -d= -f2-)"
            if [[ -n "$database_url" ]]; then
                printf '已从备份 %s 恢复数据库连接 DATABASE_URL\n' "$newest_env_backup" >&2
            fi
        fi
    elif [[ "$database_url" == *"f777653747bf2d4abc4ae46e3c06d1cc"* ]]; then
        # 自动纠正误带入的开发机测试连接为服务器真实凭据
        database_url="postgres://user_nAEKtB:password_NXbGBn@127.0.0.1:5432/user_nAEKtB"
        set_env_value DATABASE_URL "$database_url"
        set_env_value POSTGRES_USER "user_nAEKtB"
        set_env_value POSTGRES_PASSWORD "password_NXbGBn"
        printf '已自动将数据库连接配置更新为服务器凭据 (user_nAEKtB)\n'
    elif [[ -z "$database_url" ]]; then
        if [[ -t 0 ]]; then
            printf '请输入已有 PostgreSQL 的 DATABASE_URL（例如 postgres://user:password@127.0.0.1:5432/dbname，输入不会回显）：' >&2
            IFS= read -r -s database_url
            printf '\n' >&2
        fi
    fi
    [[ "$database_url" =~ ^postgres(ql)?:// ]] || die "external 模式必须提供有效的 DATABASE_URL（例如 postgres://用户:密码@127.0.0.1:5432/数据库）。重新上传部署包会覆盖目录内 .env，请从 .env.bak.* 备份或数据库控制台找回原连接串后重试"
    set_env_value DATABASE_URL "$database_url"
fi

worker_token="$(read_env_value DREAMYO_WORKER_TOKEN)"
maintenance_token="$(read_env_value DREAMYO_MAINTENANCE_TOKEN)"
if [[ -z "$worker_token" || "$worker_token" == "$maintenance_token" ]]; then
    set_env_value DREAMYO_WORKER_TOKEN "${DREAMYO_WORKER_TOKEN:-$(generate_token)}"
    worker_token="$(read_env_value DREAMYO_WORKER_TOKEN)"
    if [[ "$worker_token" == "$maintenance_token" ]]; then
        set_env_value DREAMYO_WORKER_TOKEN "$(generate_token)"
    fi
fi

encryption_key="$(read_env_value DREAMYO_ENCRYPTION_KEY)"
[[ "${#encryption_key}" -ge 32 ]] || die "DREAMYO_ENCRYPTION_KEY 至少需要 32 个字符"
for key in DREAMYO_INSTALL_TOKEN DREAMYO_MAINTENANCE_TOKEN DREAMYO_WORKER_TOKEN DREAMYO_GEMINIAI_API_KEY DREAMYO_CHATGPT_API_KEY DREAMYO_MAGIC_PROXY_SECRET; do
    value="$(read_env_value "$key")"
    [[ "${#value}" -ge 32 ]] || die "$key 至少需要 32 个字符"
done

SKIP_IMAGE_LOAD="${DREAMYO_SKIP_IMAGE_LOAD:-$SKIP_IMAGE_CHECK}"
if [[ "$SKIP_IMAGE_LOAD" == "1" ]]; then
    printf '提示：已指定跳过镜像归档导入，直接复用 Docker 引擎中已有镜像并校验...\n'
else
    for archive_path in "${IMAGE_ARCHIVES[@]}"; do
        printf '加载镜像：%s\n' "$(basename "$archive_path")"
        docker load --input "$SCRIPT_DIR/$archive_path"
    done
fi

docker image inspect "$APP_IMAGE" >/dev/null 2>&1 || die "主应用镜像未加载：$APP_IMAGE"
docker image inspect "$GEMINIAI_IMAGE" >/dev/null 2>&1 || die "GeminiAI 镜像未加载：$GEMINIAI_IMAGE"
if [[ -n "$MAGIC_PROXY_IMAGE" ]]; then
    docker image inspect "$MAGIC_PROXY_IMAGE" >/dev/null 2>&1 || die "Mihomo 镜像未加载：$MAGIC_PROXY_IMAGE"
fi
if [[ "$DATABASE_MODE" == embedded ]]; then
    docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1 || die "PostgreSQL 镜像未加载：$POSTGRES_IMAGE"
fi

resolve_compose_project_name() {
    local configured project volume candidate selected="" container_project
    local -a configured_projects=() running_projects=()
    configured="$(read_env_value COMPOSE_PROJECT_NAME)"
    if [[ -n "$configured" ]]; then
        [[ "$configured" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die ".env 中的 COMPOSE_PROJECT_NAME 格式无效"
        printf '%s' "$configured"
        return
    fi

    # Packages are uploaded from date-named directories, which otherwise create a
    # fresh Compose volume namespace on each release. Reattach the existing stack
    # by finding the volume that still contains its imported proxy nodes.
    while IFS= read -r volume; do
        [[ -n "$volume" ]] || continue
        project="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$volume" 2>/dev/null || true)"
        [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || continue
        if docker run --rm --pull never --network none -v "$volume:/proxy-runtime:ro" --entrypoint node "$APP_IMAGE" -e 'const fs=require("node:fs");const yaml=require("yaml");try{const data=yaml.parse(fs.readFileSync("/proxy-runtime/subscription.yaml","utf8"));process.exit(Array.isArray(data?.proxies)&&data.proxies.length>0?0:1)}catch{process.exit(1)}' >/dev/null 2>&1; then
            case " ${configured_projects[*]:-} " in
                *" ${project} "*) ;;
                *) configured_projects+=("$project") ;;
            esac
        fi
    done < <(docker volume ls --quiet --filter label=com.docker.compose.volume=dreamyo-magic-proxy-runtime)

    if [[ "${#configured_projects[@]}" -gt 1 ]]; then
        die "发现多个旧魔法代理数据卷含有节点，无法安全判断应复用哪一套；请在 .env 中将 COMPOSE_PROJECT_NAME 设为对应卷标签中的项目名后重试"
    elif [[ "${#configured_projects[@]}" -eq 1 ]]; then
        selected="${configured_projects[0]}"
    else
        for candidate in dreamyo dreamyo-magic-proxy dreamyo-generation-worker dreamyo-chatgpt-api dreamyo-geminiai; do
            container_project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$candidate" 2>/dev/null || true)"
            [[ "$container_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || continue
            case " ${running_projects[*]:-} " in
                *" ${container_project} "*) ;;
                *) running_projects+=("$container_project") ;;
            esac
        done
        [[ "${#running_projects[@]}" -le 1 ]] || die "现有 Dreamyo 容器属于多个 Compose 项目，无法安全复用数据卷；请在 .env 中指定 COMPOSE_PROJECT_NAME"
        selected="${running_projects[0]:-dreamyo}"
    fi
    set_env_value COMPOSE_PROJECT_NAME "$selected"
    printf '%s' "$selected"
}

COMPOSE_PROJECT_NAME="$(resolve_compose_project_name)"
export COMPOSE_PROJECT_NAME
printf '持久数据卷项目名：%s\n' "$COMPOSE_PROJECT_NAME"

compose_diagnostics() {
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps >&2 || true
    if [[ "$DATABASE_MODE" == embedded ]]; then
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=120 magic-proxy app generation-worker geminiai postgres >&2 || true
    else
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=120 magic-proxy app generation-worker geminiai >&2 || true
    fi
}

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null || die "Compose 配置校验失败"
if [[ "$PRIVATE_MIGRATION" == 1 ]]; then
    printf '校验并导入本地私有快照；不会覆盖已有业务数据库。\n'
    private_keys=()
    while IFS= read -r private_line || [[ -n "$private_line" ]]; do
        [[ -z "$private_line" || "$private_line" == \#* ]] && continue
        private_key="${private_line%%=*}"
        case "$private_key" in
            DREAMYO_ENCRYPTION_KEY|GEMINI_TOOLS_OAUTH_CLIENT_ID|GEMINI_TOOLS_OAUTH_CLIENT_SECRET|GEMINI_TOOLS_OAUTH_REDIRECT_URI) ;;
            *) die "私有迁移包包含未允许的环境变量" ;;
        esac
        private_value="$(read_env_value "$private_key" "$SCRIPT_DIR/private-migration/private.env")"
        export "$private_key=$private_value"
        private_keys+=("$private_key")
    done < "$SCRIPT_DIR/private-migration/private.env"
    # Stop writers before preflight. A failed import never starts the Worker.
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop app generation-worker geminiai
    migration_accounts_volume="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json | docker run --rm -i --entrypoint node "$APP_IMAGE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.parse(s).volumes["dreamyo-geminiai-accounts"].name))')"
    [[ "$migration_accounts_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "迁移账号卷名称无效"
    docker volume create "$migration_accounts_volume" >/dev/null
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps --user 0 \
        -v "$SCRIPT_DIR/private-migration:/migration:ro" \
        -v "$migration_accounts_volume:/migration-geminiai" \
        app node /app/web/scripts/restore-private-migration.mjs || die "迁移未完成，未启动任务服务，原部署加密密钥未改写"
    for private_key in "${private_keys[@]}"; do
        set_env_value "$private_key" "${!private_key}"
    done
fi
if [[ "$PRIVATE_SETTINGS_SYNC" == 1 ]]; then
    printf '同步私有账号与代理设置；源凭据在容器内使用服务器密钥重新加密，服务器独有账号保留。\n'
    PRIVATE_SETTINGS_SYNC_USER="$(docker run --rm --pull never --network none --entrypoint node "$APP_IMAGE" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')" || die "无法读取应用容器运行用户"
    [[ "$PRIVATE_SETTINGS_SYNC_USER" =~ ^[0-9]+:[0-9]+$ ]] || die "应用容器运行用户标识无效"
    PRIVATE_SETTINGS_SYNC_VOLUME="dreamyo-private-settings-sync-$$-$(generate_token)"
    docker volume create "$PRIVATE_SETTINGS_SYNC_VOLUME" >/dev/null || die "无法创建临时私有同步卷"
    docker run --rm --pull never --network none --user 0 \
        -v "$SCRIPT_DIR/private-settings-sync:/private-settings-source:ro" \
        -v "$PRIVATE_SETTINGS_SYNC_VOLUME:/private-settings-target" \
        --entrypoint node "$APP_IMAGE" -e '
const fs = require("node:fs");
const path = require("node:path");
const [uidGid = "", ...unexpectedArgs] = process.argv.slice(1);
const [uidText, gidText, ...extraIds] = uidGid.split(":");
if (unexpectedArgs.length || extraIds.length || !/^\d+$/.test(uidText) || !/^\d+$/.test(gidText)) throw new Error("invalid app uid/gid");
const uid = Number(uidText), gid = Number(gidText);
const source = "/private-settings-source", target = "/private-settings-target";
function copyEntry(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error("snapshot contains a symbolic link");
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { mode: 0o700 });
    for (const name of fs.readdirSync(from)) copyEntry(path.join(from, name), path.join(to, name));
    fs.chownSync(to, uid, gid);
    fs.chmodSync(to, 0o700);
  } else if (stat.isFile()) {
    fs.copyFileSync(from, to);
    fs.chownSync(to, uid, gid);
    fs.chmodSync(to, 0o600);
  } else {
    throw new Error("snapshot contains an unsupported file type");
  }
}
for (const name of fs.readdirSync(source)) copyEntry(path.join(source, name), path.join(target, name));
fs.chownSync(target, uid, gid);
fs.chmodSync(target, 0o700);
' "$PRIVATE_SETTINGS_SYNC_USER" || die "私有账号与代理快照暂存失败；服务尚未停止"
    gemini_accounts_volume="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json | docker run --rm -i --entrypoint node "$APP_IMAGE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.parse(s).volumes["dreamyo-geminiai-accounts"].name))')"
    [[ "$gemini_accounts_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "GeminiAIStudio 账号卷名称无效"
    docker volume create "$gemini_accounts_volume" >/dev/null || die "无法挂载 GeminiAIStudio 账号卷"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop app generation-worker chatgpt-api geminiai || die "停止账号数据写入服务失败"
    docker stop dreamyo dreamyo-generation-worker dreamyo-chatgpt-api dreamyo-geminiai >/dev/null 2>&1 || true
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps --user "$PRIVATE_SETTINGS_SYNC_USER" \
        -v "$PRIVATE_SETTINGS_SYNC_VOLUME:/private-settings-sync:ro" \
        app /app/services/chatgpt-api/.venv/bin/python /app/services/chatgpt-api/scripts/sync_private_settings.py \
        --snapshot /private-settings-sync || die "账号与代理设置同步失败；服务保持停止，服务器回滚备份已保留"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps --user 0 \
        -v "$PRIVATE_SETTINGS_SYNC_VOLUME:/private-settings-sync:ro" \
        -v "$gemini_accounts_volume:/geminiai-accounts" \
        -e DREAMYO_GEMINIAI_ACCOUNTS_DIR=/geminiai-accounts \
        app /app/services/chatgpt-api/.venv/bin/python /app/services/chatgpt-api/scripts/sync_private_settings.py \
        --gemini-snapshot /private-settings-sync || die "GeminiAIStudio 授权同步失败；服务保持停止，服务器回滚备份已保留"
fi
for obsolete_container in dreamyo dreamyo-generation-worker dreamyo-chatgpt-api dreamyo-geminiai dreamyo-magic-proxy dreamyo-postgres; do
    obsolete_project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$obsolete_container" 2>/dev/null || true)"
    if [[ -n "$obsolete_project" && "$obsolete_project" != "$COMPOSE_PROJECT_NAME" ]]; then
        docker rm -f "$obsolete_container" >/dev/null || die "无法安全切换现有容器项目名：$obsolete_container"
    fi
done
printf '启动服务……\n'
# 绑定挂载的 bootstrap 配置内容变化不会触发 Compose 重建容器；每次部署强制重建
# 无状态的 magic-proxy，保证更新后的监听声明（含 ChatGPTAPI 17892）立即生效。
if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --pull never --force-recreate magic-proxy; then
    printf '\nCompose 启动失败，服务状态与最近日志如下：\n' >&2
    compose_diagnostics
    exit 1
fi
if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --pull never; then
    printf '\nCompose 启动失败，服务状态与最近日志如下：\n' >&2
    compose_diagnostics
    exit 1
fi

health_timeout="${DREAMYO_DEPLOY_HEALTH_TIMEOUT_SECONDS:-600}"
poll_seconds="${DREAMYO_DEPLOY_HEALTH_POLL_SECONDS:-2}"
[[ "$health_timeout" =~ ^[0-9]+$ && "$health_timeout" -gt 0 ]] || die "DREAMYO_DEPLOY_HEALTH_TIMEOUT_SECONDS 必须为正整数"
[[ "$poll_seconds" =~ ^[0-9]+$ && "$poll_seconds" -gt 0 ]] || die "DREAMYO_DEPLOY_HEALTH_POLL_SECONDS 必须为正整数"

container_health() {
    docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || printf 'missing'
}

services_ready=0
deadline=$((SECONDS + health_timeout))
while (( SECONDS < deadline )); do
    if [[ "$DATABASE_MODE" == embedded ]]; then
        postgres_health="$(container_health dreamyo-postgres)"
    else
        postgres_health="external"
    fi
    magic_proxy_health="$(container_health dreamyo-magic-proxy)"
    geminiai_health="$(container_health dreamyo-geminiai)"
    app_health="$(container_health dreamyo)"
    worker_health="$(container_health dreamyo-generation-worker)"
    printf '\r健康检查：postgres=%s magic-proxy=%s geminiai=%s app=%s worker=%s' "$postgres_health" "$magic_proxy_health" "$geminiai_health" "$app_health" "$worker_health"
    if [[ "$magic_proxy_health" == healthy && "$geminiai_health" == healthy && "$app_health" == healthy && "$worker_health" == running && ( "$DATABASE_MODE" == external || "$postgres_health" == healthy ) ]]; then
        services_ready=1
        printf '\n'
        break
    fi
    sleep "$poll_seconds"
done

if [[ "$services_ready" -ne 1 ]]; then
    printf '\n服务未在配置的时间内完成数据库就绪检查，最近日志如下：\n' >&2
    compose_diagnostics
    exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
install_token="$(read_env_value DREAMYO_INSTALL_TOKEN)"
printf '\n部署完成。\n'
if [[ "$PRIVATE_MIGRATION" == 1 ]]; then
    printf '本地数据已导入，请访问 http://服务器IP:%s 并使用原账号和密码登录，无需重新安装或配置模型渠道。\n' "$install_port"
else
printf '安装向导：http://服务器IP:%s/install\n' "$install_port"
printf '首次安装令牌：%s\n' "$install_token"
printf '令牌只用于创建首个管理员，请保密保存 .env，重复部署复用原有密钥。\n'
fi
printf '查看日志：docker compose --env-file .env -f %s logs -f magic-proxy app generation-worker geminiai\n' "$COMPOSE_FILE"

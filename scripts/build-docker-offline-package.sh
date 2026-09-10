#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DATE="${OCTALAICANVAS_PACKAGE_DATE:-$(date +%Y%m%d)}"
PACKAGE_DIR="${OCTALAICANVAS_PACKAGE_DIR:-$REPO_ROOT/本次修改需上传文件_$PACKAGE_DATE}"
PLATFORM="${OCTALAICANVAS_DOCKER_PLATFORM:-linux/amd64}"
APP_IMAGE="${OCTALAICANVAS_OFFLINE_APP_IMAGE:-octalaicanvas-app:offline}"
GEMINIAI_IMAGE="${OCTALAICANVAS_OFFLINE_GEMINIAI_IMAGE:-octalaicanvas-geminiai:offline}"
MAGIC_PROXY_IMAGE="${OCTALAICANVAS_MAGIC_PROXY_IMAGE:-metacubex/mihomo:v1.19.30}"
POSTGRES_IMAGE="${OCTALAICANVAS_OFFLINE_POSTGRES_IMAGE:-postgres:16.6-alpine}"
BUILD_PROGRESS="${BUILDKIT_PROGRESS:-plain}"
DATABASE_MODE="${OCTALAICANVAS_DATABASE_MODE:-external}"
PRIVATE_MIGRATION_DIR="${OCTALAICANVAS_PRIVATE_MIGRATION_DIR:-}"
PRIVATE_MIGRATION=0
PRIVATE_MIGRATION_FILES=()

die() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

require_checksum_command() {
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || die "缺少 SHA-256 校验命令：sha256sum 或 shasum"
}

checksum_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

validate_platform() {
    case "$1" in
        linux/amd64|linux/arm64) ;;
        *) die "OCTALAICANVAS_DOCKER_PLATFORM 只能是 linux/amd64 或 linux/arm64" ;;
    esac
}

verify_image_archive_platform() {
    local archive="$1"
    local platform="$2"
    local architecture="${platform#linux/}"
    local manifest_json config_file config_json

    manifest_json="$(tar -xOf "$archive" manifest.json 2>/dev/null)" || die "镜像归档损坏或缺少 manifest.json：$archive"
    config_file="$(printf '%s\n' "$manifest_json" | sed -nE 's/.*"Config"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
    [[ -n "$config_file" && "$config_file" != *$'\n'* ]] || die "镜像归档缺少唯一 Config 元数据：$archive"
    case "$config_file" in
        /*|../*|*/../*|*//*) die "镜像归档 Config 路径无效：$archive" ;;
    esac
    config_json="$(tar -xOf "$archive" "$config_file" 2>/dev/null)" || die "镜像归档 Config 无法读取：$archive"
    printf '%s' "$config_json" | grep -Eq "\"os\"[[:space:]]*:[[:space:]]*\"linux\"" || die "镜像归档不是 Linux 镜像：$archive"
    printf '%s' "$config_json" | grep -Eq "\"architecture\"[[:space:]]*:[[:space:]]*\"${architecture}\"" || die "镜像归档架构与 ${platform} 不一致：$archive"
}

archive_existing_package() {
    local timestamp archive_dir suffix=0

    [[ -e "$PACKAGE_DIR" || -L "$PACKAGE_DIR" ]] || return 0
    timestamp="$(date +%Y%m%d%H%M%S)"
    archive_dir="${PACKAGE_DIR}_归档_${timestamp}"
    while [[ -e "$archive_dir" || -L "$archive_dir" ]]; do
        suffix=$((suffix + 1))
        archive_dir="${PACKAGE_DIR}_归档_${timestamp}_${suffix}"
    done
    printf '归档旧部署包：%s -> %s\n' "$PACKAGE_DIR" "$archive_dir"
    mv "$PACKAGE_DIR" "$archive_dir"
}

write_checksums() {
    local relative_path

    (
        cd "$PACKAGE_DIR"
        for relative_path in "$@"; do
            printf '%s  %s\n' "$(checksum_file "$relative_path")" "$relative_path"
        done
    ) > "$PACKAGE_DIR/SHA256SUMS"
}

verify_private_migration_snapshot() {
    local directory="$1"

    [[ -d "$directory" && ! -L "$directory" ]] || die "OCTALAICANVAS_PRIVATE_MIGRATION_DIR 必须是非符号链接目录：$directory"
    [[ -f "$REPO_ROOT/web/scripts/restore-private-files.mjs" ]] || die "缺少私有迁移快照校验器：web/scripts/restore-private-files.mjs"
    require_command node
    node --input-type=module --eval '
import { pathToFileURL } from "node:url";
const { verifyPrivateSnapshot } = await import(pathToFileURL(process.argv[1]).href);
await verifyPrivateSnapshot(process.argv[2]);
' -- "$REPO_ROOT/web/scripts/restore-private-files.mjs" "$directory" || die "私有迁移快照校验失败"
}

copy_private_migration() {
    local source_directory="$1"
    local destination="$PACKAGE_DIR/private-migration"

    mkdir -m 0700 "$destination"
    cp -pR "$source_directory/." "$destination/"
    find "$destination" -type d -exec chmod 0700 {} +
    find "$destination" -type f -exec chmod 0600 {} +
    chmod 0700 "$destination"
    chmod 0600 "$destination/private.env"
    verify_private_migration_snapshot "$destination"
}

collect_private_migration_files() {
    local relative_path

    while IFS= read -r -d '' relative_path; do
        [[ "$relative_path" != *$'\n'* && "$relative_path" != *$'\r'* ]] || die "私有迁移文件路径不能包含换行"
        PRIVATE_MIGRATION_FILES+=("$relative_path")
    done < <(cd "$PACKAGE_DIR" && find private-migration -type f -print0)
    [[ "${#PRIVATE_MIGRATION_FILES[@]}" -gt 0 ]] || die "私有迁移目录不包含普通文件"
}

case "$DATABASE_MODE" in
    embedded) COMPOSE_FILE="docker-compose.offline.yml" ;;
    external) COMPOSE_FILE="docker-compose.offline-external-db.yml" ;;
    *) die "OCTALAICANVAS_DATABASE_MODE 只能是 embedded 或 external" ;;
esac

if [[ -n "$PRIVATE_MIGRATION_DIR" ]]; then
    [[ "$DATABASE_MODE" == external ]] || die "OCTALAICANVAS_PRIVATE_MIGRATION_DIR 仅支持 external PostgreSQL 模式"
    verify_private_migration_snapshot "$PRIVATE_MIGRATION_DIR"
    PRIVATE_MIGRATION=1
fi

validate_platform "$PLATFORM"

case "$PACKAGE_DIR" in
    "$REPO_ROOT"/本次修改需上传文件_*) ;;
    *) die "部署包目录必须位于项目根目录且以 本次修改需上传文件_ 开头：$PACKAGE_DIR" ;;
esac

require_command docker
require_command tar
require_checksum_command
docker info >/dev/null 2>&1 || die "Docker 引擎未运行，请先启动 Docker Desktop 或 Docker Engine"
docker buildx version >/dev/null 2>&1 || die "当前 Docker 未提供 buildx"
docker compose version >/dev/null 2>&1 || die "当前 Docker 未提供 Compose v2"

[[ -f "$REPO_ROOT/VERSION" ]] || die "缺少 VERSION"
VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
[[ -n "$VERSION" ]] || die "VERSION 为空"

archive_existing_package
mkdir -p "$PACKAGE_DIR/images"

printf '构建主应用镜像：%s（平台 %s）\n' "$APP_IMAGE" "$PLATFORM"
docker buildx build \
    --platform "$PLATFORM" \
    --tag "$APP_IMAGE" \
    --load \
    --progress "$BUILD_PROGRESS" \
    "$REPO_ROOT"

printf '构建 GeminiAI 镜像：%s（平台 %s）\n' "$GEMINIAI_IMAGE" "$PLATFORM"
docker buildx build \
    --platform "$PLATFORM" \
    --tag "$GEMINIAI_IMAGE" \
    --load \
    --progress "$BUILD_PROGRESS" \
    "$REPO_ROOT/services/geminiai"

printf '拉取 Mihomo 镜像（不重新构建）：%s（平台 %s）\n' "$MAGIC_PROXY_IMAGE" "$PLATFORM"
docker pull --platform "$PLATFORM" "$MAGIC_PROXY_IMAGE"

if [[ "$DATABASE_MODE" == embedded ]]; then
    printf '拉取 PostgreSQL 基础镜像：%s（平台 %s）\n' "$POSTGRES_IMAGE" "$PLATFORM"
    docker pull --platform "$PLATFORM" "$POSTGRES_IMAGE"
fi

if [[ "$DATABASE_MODE" == embedded ]]; then
    docker image inspect --platform "$PLATFORM" "$APP_IMAGE" "$GEMINIAI_IMAGE" "$MAGIC_PROXY_IMAGE" "$POSTGRES_IMAGE" >/dev/null || die "构建或拉取的镜像无法读取"
else
    docker image inspect --platform "$PLATFORM" "$APP_IMAGE" "$GEMINIAI_IMAGE" "$MAGIC_PROXY_IMAGE" >/dev/null || die "构建或拉取的镜像无法读取"
fi

printf '导出主应用镜像归档\n'
docker save --platform "$PLATFORM" --output "$PACKAGE_DIR/images/app.tar" "$APP_IMAGE"
printf '导出 GeminiAI 镜像归档\n'
docker save --platform "$PLATFORM" --output "$PACKAGE_DIR/images/geminiai.tar" "$GEMINIAI_IMAGE"
printf '导出 Mihomo 镜像归档\n'
docker save --platform "$PLATFORM" --output "$PACKAGE_DIR/images/magic-proxy.tar" "$MAGIC_PROXY_IMAGE"
if [[ "$DATABASE_MODE" == embedded ]]; then
    printf '导出 PostgreSQL 镜像归档\n'
    docker save --platform "$PLATFORM" --output "$PACKAGE_DIR/images/postgres.tar" "$POSTGRES_IMAGE"
fi

IMAGE_ARCHIVES=(images/app.tar images/geminiai.tar images/magic-proxy.tar)
if [[ "$DATABASE_MODE" == embedded ]]; then
    IMAGE_ARCHIVES+=(images/postgres.tar)
fi
for archive in "${IMAGE_ARCHIVES[@]}"; do
    verify_image_archive_platform "$PACKAGE_DIR/$archive" "$PLATFORM"
done

install -m 0755 "$REPO_ROOT/scripts/deploy-docker-offline.sh" "$PACKAGE_DIR/一键部署.sh"
install -m 0644 "$REPO_ROOT/$COMPOSE_FILE" "$PACKAGE_DIR/$COMPOSE_FILE"
install -m 0644 "$REPO_ROOT/.env.example" "$PACKAGE_DIR/.env.example"

# GeminiTools OAuth 凭据只保存在本地 .env（不入库）；打包时注入部署包模板，
# 由一键部署脚本种子到服务器 .env，避免每次更新都要手工补配置。
seeded_oauth_keys=0
seed_env_example_from_local_env() {
    local key="$1" value
    value="$(grep -E "^${key}=" "$REPO_ROOT/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
    [[ -n "$value" ]] || return 0
    awk -v key="$key" -v value="$value" '
        $0 ~ "^"key"=" { print key "=" value; seeded = 1; next }
        { print }
        END { if (!seeded) print key "=" value }
    ' "$PACKAGE_DIR/.env.example" > "$PACKAGE_DIR/.env.example.seed" && mv "$PACKAGE_DIR/.env.example.seed" "$PACKAGE_DIR/.env.example"
    seeded_oauth_keys=1
}
seed_env_example_from_local_env GEMINI_TOOLS_OAUTH_CLIENT_ID
seed_env_example_from_local_env GEMINI_TOOLS_OAUTH_CLIENT_SECRET
seed_env_example_from_local_env OCTALAICANVAS_GEMINIAI_STUDIO_URL
seed_env_example_from_local_env OCTALAICANVAS_CHATGPT_API_PROXY_URL
seed_env_example_from_local_env OCTALAICANVAS_ENCRYPTION_KEY
seed_env_example_from_local_env OCTALAICANVAS_INSTALL_TOKEN
seed_env_example_from_local_env OCTALAICANVAS_MAINTENANCE_TOKEN
seed_env_example_from_local_env OCTALAICANVAS_WORKER_TOKEN
seed_env_example_from_local_env OCTALAICANVAS_GEMINIAI_API_KEY
seed_env_example_from_local_env OCTALAICANVAS_CHATGPT_API_KEY
seed_env_example_from_local_env OCTALAICANVAS_MAGIC_PROXY_SECRET
seed_env_example_from_local_env OCTALAICANVAS_ALLOW_PRIVATE_UPSTREAMS
seed_env_example_from_local_env OCTALAICANVAS_PRIVATE_UPSTREAM_HOSTS
if [[ "$seeded_oauth_keys" == 1 ]]; then
    chmod 0600 "$PACKAGE_DIR/.env.example"
    printf '已将本地关键环境变量（OAuth/AIStudio/ChatGPT API代理/私网放行等）注入部署包模板（部署时会自动种子到服务器 .env）\n'
fi
mkdir -p "$PACKAGE_DIR/docker/mihomo"
install -m 0644 "$REPO_ROOT/docker/mihomo/bootstrap.yaml" "$PACKAGE_DIR/docker/mihomo/bootstrap.yaml"
install -m 0644 "$REPO_ROOT/docker/mihomo/bootstrap-host.yaml" "$PACKAGE_DIR/docker/mihomo/bootstrap-host.yaml"
install -m 0755 "$REPO_ROOT/docker/mihomo/entrypoint.sh" "$PACKAGE_DIR/docker/mihomo/entrypoint.sh"

if [[ "$PRIVATE_MIGRATION" == 1 ]]; then
    copy_private_migration "$PRIVATE_MIGRATION_DIR"
    collect_private_migration_files
fi

{
cat <<EOF
OCTALAICANVAS_PACKAGE_VERSION=$VERSION
OCTALAICANVAS_DOCKER_PLATFORM=$PLATFORM
OCTALAICANVAS_DATABASE_MODE=$DATABASE_MODE
OCTALAICANVAS_PRIVATE_MIGRATION=$PRIVATE_MIGRATION
OCTALAICANVAS_IMAGE=$APP_IMAGE
OCTALAICANVAS_GEMINIAI_IMAGE=$GEMINIAI_IMAGE
OCTALAICANVAS_MAGIC_PROXY_IMAGE=$MAGIC_PROXY_IMAGE
OCTALAICANVAS_COMPOSE_FILE=$COMPOSE_FILE
EOF
if [[ "$DATABASE_MODE" == embedded ]]; then
    printf 'OCTALAICANVAS_POSTGRES_IMAGE=%s\n' "$POSTGRES_IMAGE"
fi
} > "$PACKAGE_DIR/manifest.env"

if [[ "$DATABASE_MODE" == embedded ]]; then
    DATABASE_DESCRIPTION="该包包含 PostgreSQL 镜像，并会自动创建 octalaicanvas-postgres 数据库容器。"
    DATABASE_COMMAND="首次部署不需要已有 PostgreSQL。"
else
    DATABASE_DESCRIPTION="该包复用服务器上已有的 Docker PostgreSQL，不包含或启动新的 PostgreSQL 镜像。"
    DATABASE_COMMAND="首次部署前请在 .env 中配置已有 PostgreSQL 的 DATABASE_URL；如果留空，一键脚本会在交互终端中询问。已有 PostgreSQL 必须已映射到宿主机可访问端口（默认 5432），DATABASE_URL 中填写实际端口，因为应用使用 host 网络访问宿主机。"
fi

if [[ "$DATABASE_MODE" == external ]]; then
    DEFAULT_APPLICATION_URL="http://服务器IP:8866"
    PORT_GUIDANCE='external 模式默认端口为 8866。若服务器部署目录已有旧 `.env` 的 `PORT=3000`，脚本会保留它；要切换到 8866，请显式执行 `OCTALAICANVAS_PORT=8866 ./一键部署.sh`，脚本会写回 `.env`，之后重复部署会复用该端口。'
    NETWORK_EXPOSURE_GUIDANCE='- external 模式默认直接暴露 8866 端口，正式公网环境建议在前面配置 HTTPS 反向代理，并把 `OCTALAICANVAS_BIND_ADDRESS` 改为 `127.0.0.1`。'
else
    DEFAULT_APPLICATION_URL="http://服务器IP:3000"
    PORT_GUIDANCE='embedded 模式默认端口为 3000。'
    NETWORK_EXPOSURE_GUIDANCE='- 默认直接暴露 3000 端口，正式公网环境建议在前面配置 HTTPS 反向代理，并把 `OCTALAICANVAS_BIND_ADDRESS` 改为 `127.0.0.1`。'
fi

if [[ "$PRIVATE_MIGRATION" == 1 ]]; then
    DEPLOYMENT_SUMMARY="脚本会自动加载 images/ 下的应用、GeminiAI 和 Mihomo 镜像，创建持久化数据卷，导入经过校验的私有迁移快照，并启动全部服务。$DATABASE_DESCRIPTION"
    ACCESS_HEADING="私有迁移模式不提供首次管理员安装指南。"
    ACCESS_URL_BLOCK="服务启动后请使用迁移前已有的管理员身份登录；默认端口下访问 ${DEFAULT_APPLICATION_URL}。"
    PRIVATE_CONTENT_NOTICE='- 本包内含敏感私有迁移数据，绝不可上传到公共仓库、对象存储或公共下载链接。私有迁移只允许导入空的目标 PostgreSQL 一次；已有导入记录或业务数据时部署会拒绝覆盖。'
else
    DEPLOYMENT_SUMMARY="脚本会自动加载 images/ 下的应用、GeminiAI 和 Mihomo 镜像，创建持久化数据卷，生成首次部署所需的内部密钥，并启动全部服务。$DATABASE_DESCRIPTION"
    ACCESS_HEADING="默认访问地址为："
    ACCESS_URL_BLOCK="\`\`\`
$DEFAULT_APPLICATION_URL/install
\`\`\`

首次安装令牌会在脚本完成时显示，也保存在服务器部署目录的 .env 中。请保密保存 .env，重复部署继续复用原有密钥。"
    PRIVATE_CONTENT_NOTICE='- 不包含本机 .env、用户渠道密钥、支付密钥和账号登录态。请部署后在后台或服务器 .env 中配置；外部模型生成仍需网络、有效账号和额度，离线部署不等于离线调用外部模型。'
fi

cat > "$PACKAGE_DIR/README.md" <<EOF
# OctalFlow 离线 Docker 部署包

版本：$VERSION
目标平台：$PLATFORM
数据库模式：$DATABASE_MODE

## 一键部署

在已安装 Docker Engine 与 Compose v2 的 Linux 服务器上执行：

\`\`\`bash
chmod +x 一键部署.sh
./一键部署.sh
\`\`\`

$DEPLOYMENT_SUMMARY

$DATABASE_COMMAND

$PORT_GUIDANCE

$ACCESS_HEADING

$ACCESS_URL_BLOCK

## 说明

- 镜像归档已经包含 Node.js、Next.js standalone、Sharp/libvips、FFmpeg、PostgreSQL 客户端、Python、Camoufox/Playwright、GeminiAI sidecar 和 Mihomo v1.19.30 运行依赖；Mihomo 镜像由构建机拉取并原样保存，不在脚本中重建。
- 应用还内置 CPU PyTorch、Transformers、Depth Anything V2 Small 模型权重，以及官方 Linux amd64 Dreamina CLI；深度推理无需启动后下载模型。CLI 登录目录保存在应用数据卷的 dreamina/ 下，可执行 \`docker exec -it octalaicanvas dreamina login\` 登录。二进制及模型遵循各自厂商条款，本包用于自有服务器部署。
- Mihomo 只提供两个静态内部 mixed 监听：GeminiAIStudio 与 GeminiTools 共用这一份镜像，但通过独立端口和代理分组隔离；动态订阅通过私有 runtime 文件 provider 刷新。
- Mihomo 的只读入口脚本随配置文件一同打包，启动时校验 Controller 密钥和监听地址，并初始化共享 provider 文件权限。
- 应用媒体和 GeminiAI 账号分别保存在独立卷中；embedded 模式下 PostgreSQL 数据另保存在 \`octalaicanvas-postgres\` 卷中，external 模式下不管理 PostgreSQL 数据卷。
$PRIVATE_CONTENT_NOTICE
- 请为本应用提供独立的 PostgreSQL 数据库及有建表权限的账号，勿填写其他系统正在使用的数据库。一键脚本不会替你创建外部数据库，也不会管理现有 PostgreSQL 容器及数据卷。
$NETWORK_EXPOSURE_GUIDANCE

## 运维

\`\`\`bash
docker compose --env-file .env -f $COMPOSE_FILE ps
docker compose --env-file .env -f $COMPOSE_FILE logs -f magic-proxy app generation-worker geminiai
\`\`\`

不要执行 \`docker compose down -v\`，否则会删除应用媒体和 GeminiAI 账号数据卷；embedded 模式还会删除 PostgreSQL 数据卷。
EOF

chmod 0600 "$PACKAGE_DIR/manifest.env"
PACKAGE_CHECKSUM_FILES=(
    README.md
    manifest.env
    一键部署.sh
    "$COMPOSE_FILE"
    .env.example
    docker/mihomo/bootstrap.yaml
    docker/mihomo/bootstrap-host.yaml
    docker/mihomo/entrypoint.sh
    "${IMAGE_ARCHIVES[@]}"
)
if [[ "$PRIVATE_MIGRATION" == 1 ]]; then
    PACKAGE_CHECKSUM_FILES+=("${PRIVATE_MIGRATION_FILES[@]}")
fi
write_checksums "${PACKAGE_CHECKSUM_FILES[@]}"
chmod 0644 "$PACKAGE_DIR/SHA256SUMS"
printf '\n部署包已生成：%s\n' "$PACKAGE_DIR"
du -sh "$PACKAGE_DIR" "$PACKAGE_DIR/images" 2>/dev/null || true
printf '上传整个目录到服务器后执行：./一键部署.sh\n'

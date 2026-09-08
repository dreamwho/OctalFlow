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

die() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

case "$DATABASE_MODE" in
    embedded) COMPOSE_FILE="docker-compose.offline.yml" ;;
    external) COMPOSE_FILE="docker-compose.offline-external-db.yml" ;;
    *) die "OCTALAICANVAS_DATABASE_MODE 只能是 embedded 或 external" ;;
esac

case "$PACKAGE_DIR" in
    "$REPO_ROOT"/本次修改需上传文件_*) ;;
    *) die "部署包目录必须位于项目根目录且以 本次修改需上传文件_ 开头：$PACKAGE_DIR" ;;
esac

require_command docker
docker info >/dev/null 2>&1 || die "Docker 引擎未运行，请先启动 Docker Desktop 或 Docker Engine"
docker buildx version >/dev/null 2>&1 || die "当前 Docker 未提供 buildx"
docker compose version >/dev/null 2>&1 || die "当前 Docker 未提供 Compose v2"

[[ -f "$REPO_ROOT/VERSION" ]] || die "缺少 VERSION"
VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
[[ -n "$VERSION" ]] || die "VERSION 为空"

if [[ -e "$PACKAGE_DIR" ]]; then
    printf '删除旧部署包：%s\n' "$PACKAGE_DIR"
    rm -rf -- "$PACKAGE_DIR"
fi
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

install -m 0755 "$REPO_ROOT/scripts/deploy-docker-offline.sh" "$PACKAGE_DIR/一键部署.sh"
install -m 0644 "$REPO_ROOT/$COMPOSE_FILE" "$PACKAGE_DIR/$COMPOSE_FILE"
install -m 0644 "$REPO_ROOT/.env.example" "$PACKAGE_DIR/.env.example"
mkdir -p "$PACKAGE_DIR/docker/mihomo"
install -m 0644 "$REPO_ROOT/docker/mihomo/bootstrap.yaml" "$PACKAGE_DIR/docker/mihomo/bootstrap.yaml"
install -m 0644 "$REPO_ROOT/docker/mihomo/bootstrap-host.yaml" "$PACKAGE_DIR/docker/mihomo/bootstrap-host.yaml"
install -m 0755 "$REPO_ROOT/docker/mihomo/entrypoint.sh" "$PACKAGE_DIR/docker/mihomo/entrypoint.sh"

{
cat <<EOF
OCTALAICANVAS_PACKAGE_VERSION=$VERSION
OCTALAICANVAS_DOCKER_PLATFORM=$PLATFORM
OCTALAICANVAS_DATABASE_MODE=$DATABASE_MODE
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

脚本会自动加载 images/ 下的应用、GeminiAI 和 Mihomo 镜像，创建持久化数据卷，生成首次部署所需的内部密钥，并启动全部服务。$DATABASE_DESCRIPTION

$DATABASE_COMMAND

默认访问地址为：

\`\`\`
http://服务器IP:3000/install
\`\`\`

首次安装令牌会在脚本完成时显示，也保存在服务器部署目录的 .env 中。创建首个管理员后，可以从 .env 删除 \`OCTALAICANVAS_INSTALL_TOKEN\`。

## 说明

- 镜像归档已经包含 Node.js、Next.js standalone、Sharp/libvips、FFmpeg、PostgreSQL 客户端、Python、Camoufox/Playwright、GeminiAI sidecar 和 Mihomo v1.19.30 运行依赖；Mihomo 镜像由构建机拉取并原样保存，不在脚本中重建。
- Mihomo 只提供两个静态内部 mixed 监听：GeminiAIStudio 与 GeminiTools 共用这一份镜像，但通过独立端口和代理分组隔离；动态订阅通过私有 runtime 文件 provider 刷新。
- Mihomo 的只读入口脚本随配置文件一同打包，启动时校验 Controller 密钥和监听地址，并初始化共享 provider 文件权限。
- 应用媒体和 GeminiAI 账号分别保存在独立卷中；embedded 模式下 PostgreSQL 数据另保存在 \`octalaicanvas-postgres\` 卷中，external 模式下不管理 PostgreSQL 数据卷。
- 外部模型渠道密钥、支付密钥和 OAuth 密钥不会被打进镜像。请在后台或服务器 .env 中配置，避免把密钥固化到发布包。
- 默认直接暴露 3000 端口，正式公网环境建议在前面配置 HTTPS 反向代理，并把 \`OCTALAICANVAS_BIND_ADDRESS\` 改为 \`127.0.0.1\`。

## 运维

\`\`\`bash
docker compose --env-file .env -f $COMPOSE_FILE ps
docker compose --env-file .env -f $COMPOSE_FILE logs -f magic-proxy app generation-worker geminiai
\`\`\`

不要执行 \`docker compose down -v\`，否则会删除应用媒体和 GeminiAI 账号数据卷；embedded 模式还会删除 PostgreSQL 数据卷。
EOF

chmod 0600 "$PACKAGE_DIR/manifest.env"
printf '\n部署包已生成：%s\n' "$PACKAGE_DIR"
du -sh "$PACKAGE_DIR" "$PACKAGE_DIR/images" 2>/dev/null || true
printf '上传整个目录到服务器后执行：./一键部署.sh\n'

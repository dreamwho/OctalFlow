# WEB / GPTAPI 源码增量更新

20261021 当前交付改用**本地 Linux 预编译运行包**，避免服务器 npm 下载超时。上传 `dreamyo-runtime-update-20261021.tar.gz` 后执行 `scripts/deploy-runtime-update.sh`；完整更新、回滚命令和验证记录见 [本地运行包部署说明](generation-management/本地运行包部署_20261021.md)。以下保留源码构建流程供有稳定构建网络的环境使用。

此流程在服务器现有 Linux 容器环境中构建 Next.js standalone 运行目录，然后把一个版本化目录挂入现有 Compose 服务。它不会构建或导入完整应用镜像，也不会输出或修改 `.env` 内容、数据库、账号数据卷、媒体数据卷或代理服务。

## 上传包内容

上传包需要包含完整的 WEB 构建输入，因为当前运行镜像只有 standalone 运行文件，不包含完整 Next.js 源码或编译依赖。包内至少包括：

```text
scripts/deploy-source-update.sh
web/                         # 完整当前 WEB 源码、public、scripts、package/lock/workspace 文件
VERSION
CHANGELOG.md
expected-build-id.txt        # 目标服务器当前 App 的基线 BUILD_ID，必须且只能一行
python-runtime-files.txt     # 本次 release 要挂载的 GPTAPI Python 覆盖文件清单
services/chatgpt-api/...     # 清单中的 Python 文件
SHA256SUMS                   # 覆盖上传包内其他全部普通文件
```

当前包适配已复核的线上 App Build ID `ja-z1noZmz9I3b9ZrddNp`，镜像 ID 固定为 `sha256:640c3f1482573ec994e96a4d18d0fc8eeab7a7fadcef6ed0e305448e6d5783ff`。本地历史参考构建 `UDOFZu1p4n7eOhjSxw7Vn` 与线上有一项未发布业务差异，交付副本已按回传构建文件排除；证据详见 `docs/generation-management/部署基线修正_20261021.md`。stage/apply 除读取实际 Build ID，还必须通过 `expected-runtime-files.json` 与 `scripts/verify-source-update-baseline.cjs` 对 App、Worker 的镜像 ID 和 2361 个已核验代码文件逐一校验。任何不符都停止，不猜测、不跳过。GPTAPI 继续独立核对 stage 时镜像及 Python 版本。

`python-runtime-files.txt` 每行一个仓库相对路径，例如 `services/chatgpt-api/api/accounts.py`。它描述当前 release 的**完整有效覆盖集合**：曾由此流程覆盖、仍需保留的 Python 文件也必须继续列出；要恢复某个文件为镜像内版本，就从清单中移除它。不要放 Python 测试、凭据或账号文件。

打包时排除 `.env*`（示例模板也不需要）、`web/.data`、`web/node_modules`、`web/.next`、SQLite/数据库文件、模型缓存和用户上传内容。脚本会校验 SHA-256，并拒绝 `web` 中的本地构建目录和环境文件。它只把 `web/`、版本文件以及清单列出的 Python 文件交给 builder。

## 服务器要求

- Linux x86_64 或 ARM64、Docker 和 Docker Compose v2；目标是同一个 Compose 项目中的 App、generation-worker、GPTAPI 三个正在运行服务。构建容器的 Node 版本、ABI 和 CPU 架构必须与当前 App 容器一致。
- 指定唯一、绝对路径的 Compose 文件和它的项目目录。Compose 容器标签必须确认它们都由这同一份文件创建；多文件 Compose、其他项目目录和非 host-network 部署会停止执行。
- 现有 App 镜像必须运行 Node 22 并含有 Corepack。脚本直接以该镜像作为临时 builder，检查它和运行中 App 的 Node 版本、ABI 与架构一致；YAML 解析器从锁定的 WEB 依赖构建产物中单独挂入一次性配置容器。
- App 与 generation-worker 必须由同一镜像 ID 创建；GPTAPI 可以继续使用独立的旧镜像。脚本在 stage 记录 GPTAPI 镜像 ID 与 venv Python 版本，apply 前要求两者未变，以确认 Python 覆盖仍对应原运行时。Compose 的健康检查负责服务启动后验证。
- WEB 依赖必须能从 builder 访问配置的 pnpm registry；如果需要代理，脚本只把当前 shell 已导出的代理变量临时传给 builder，不写入文件或镜像。
- App Compose 配置必须是外部 PostgreSQL 模式，并保留可写的 `/app/web/.data` 与 `/app/web/.magic-proxy-runtime` 持久化挂载。父目录 release 挂载为只读，原有嵌套数据挂载继续由 Compose 提供；App 的 Next `.next/cache` 使用 `.source-update/runtime/web-cache` 独立可写目录，脚本仅将此目录 chown 给 App 容器实际 UID/GID 并限制为 `0750`，避免只读源码树阻断图片优化缓存。

构建使用 `pnpm@11.9.0`、`pnpm install --frozen-lockfile`、TypeScript 检查和 Next.js production build。临时 builder 显式以 root 身份运行，避免 App 镜像默认 `USER node` 对 Corepack 和挂载输出目录的权限限制；仅暂存目录由它写入，生成的 release 文件保持容器可读。Sharp 及 Linux `@img` 运行包按项目 Dockerfile 的方式打入 standalone release。无法安装锁文件依赖、Node 环境不匹配或 Sharp 检查失败时，stage 会停止，运行服务和 Compose 文件保持原样。

## 执行

先用明确参数执行默认的暂存阶段。暂存只创建 `.source-update/releases/<release-id>`，不修改 Compose，也不重建服务：

```bash
./scripts/deploy-source-update.sh \
  --compose /opt/www/dreamyo/docker-compose.offline-external-db.yml \
  --project-dir /opt/www/dreamyo \
  --app-service app \
  --worker-service generation-worker \
  --gptapi-service chatgpt-api
```

检查构建成功输出和服务器 release 校验后，再显式应用已暂存版本：

```bash
./scripts/deploy-source-update.sh \
  --apply \
  --compose /opt/www/dreamyo/docker-compose.offline-external-db.yml \
  --project-dir /opt/www/dreamyo \
  --app-service app \
  --worker-service generation-worker \
  --gptapi-service chatgpt-api
```

脚本会再次核对目标 Build ID、stage 时的 Compose SHA、运行服务归属和数据挂载，先备份 Compose，再用本次 Linux 构建的 YAML 解析器在一次性容器中只更新三个服务的源码挂载，校验 Compose 配置，然后只重建 App、Worker 和 GPTAPI。Compose 的现有健康检查负责等待；如需指定整体等待时限，可由运维显式设置 `DREAMYO_DEPLOY_HEALTH_TIMEOUT_SECONDS`，脚本不额外设定默认时限。健康检查失败时会原子恢复 Compose 备份并尝试恢复原服务。

手动回滚最近一次应用：

```bash
./scripts/deploy-source-update.sh \
  --rollback \
  --compose /opt/www/dreamyo/docker-compose.offline-external-db.yml \
  --project-dir /opt/www/dreamyo \
  --app-service app \
  --worker-service generation-worker \
  --gptapi-service chatgpt-api
```

回滚会恢复原 Compose 文件并重建这三个服务，release 与备份留在 `.source-update/` 以便追查。更新流程不执行 `docker cp`，所以后续按同一 Compose 文件重建容器仍会挂载当前 release。

## 限制

这不是适用于任意 Compose 管理器的热补丁。若面板实际使用多份 Compose 文件、改写文件、使用不同 project directory，或不允许修改其 Compose 源文件，脚本会拒绝操作；不能仅靠临时 `docker cp` 保证容器重建后保留更新。使用面板时需确认面板后续重建仍读取被更新的同一份 Compose 文件。

此方式仍会上传完整 WEB 源码并在服务器安装构建依赖；它避免的是重新打包、传输和导入整套运行镜像。它不保证零停机，三个目标服务会被重建。其它服务和挂载数据不在操作范围内。本地脚本和隔离配置验证不等于已在目标服务器执行 stage/apply 或通过线上验收。

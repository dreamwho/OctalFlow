# 全渠道 Traffic Meter 架构与部署契约（2026-10-01）

本文记录本轮独立流量计量服务的架构、部署边界和当前工作区文件清单。当前实现的 ASGI 入口是 `traffic_meter.main:app`；Compose、离线打包和本地运行时必须使用同一入口。本文记录契约、文件清单及本地验证；服务器验收与本地证据分开报告。

## 架构契约

- `traffic-meter` 是独立于 DOLA 开关的 Python sidecar，默认控制端口为 `18083`，通过 FastAPI 控制面申请和释放临时 relay lease。
- Provider 使用 `DREAMYO_TRAFFIC_METER_URL` 与 `DREAMYO_TRAFFIC_METER_KEY`；sidecar 使用 `TRAFFIC_METER_KEY`、`TRAFFIC_METER_PORT`、`TRAFFIC_METER_BIND_HOST`、`TRAFFIC_METER_PUBLIC_HOST` 和 `TRAFFIC_METER_STATE_PATH`。
- 内部服务密钥至少 32 个字符，只能通过服务环境变量注入，不写日志、不返回浏览器、不放入请求上下文；远程 URL 必须同时提供对应密钥。
- 桥接网络中 sidecar 绑定 `0.0.0.0`、公共主机名为 `traffic-meter`，只使用 Compose `expose`，不发布宿主机控制端口；host 网络和本地运行时绑定 `127.0.0.1`，公共主机同为 `127.0.0.1`。
- sidecar 状态写入独立持久卷的 `TRAFFIC_METER_STATE_PATH`；SQLite WAL 只保存归因元数据、脱敏地址、端口和字节数，不保存代理密码、Cookie、请求体或响应体。
- Web 只创建可信的渠道、模型、协议、连接方式、角色和归因范围上下文；Provider 不接受用户请求体中的同名字段覆盖服务端上下文。租约覆盖整个真实网络操作，完成、取消、异常和浏览器关闭都要释放。
- GeminiAI 持久共享浏览器使用明确的 `channelId=geminiai/sharedchannel`、`model=__shared_browser__` 和 `attributionScope=shared_browser`，不得把共享浏览器字节伪装归因给某个具体模型；有代理时模式标记为 unknown 并展示实际端口，避免把可变模式误算为通用代理。DOLA 浏览器后台流量也使用共享浏览器模型分类，协议上传、提交和查询继续按实际任务模型计量。
- 计量起点是 `traffic-meter` 到上游代理或目标站之间的实际 TCP 字节流，包含代理握手和 TLS 记录；不包含 Web 到 Provider 的内部环回段、IP/TCP 包头、重传、DNS UDP、代理后续跳点或 Provider 外的结果下载，也不等于 ISP 或供应商账单。
- 统计从本次接入开始，不补算历史；DOLA 原有本地 SQLite 仅保留给旧库调用和测试，不能作为全局后台统计来源。
- BuildKit 构建 GeminiAI 与 Dola 时必须提供名为 `traffic-meter` 的 additional context；两个 Dockerfile 从该 context 复制 `src`，无需重复安装 meter 包，现有 Provider 依赖已包含 `httpx`。
- 根应用镜像把 meter client 源码复制到 `/app/services/traffic-meter/src`，并设置 `/app/services/traffic-meter/src:/app/services/chatgpt-api` 的 `PYTHONPATH`，保证 GPT API 进程可导入 `traffic_meter.client`。
- 离线包应包含 `dreamyo-traffic-meter:offline` 和 `images/traffic-meter.tar`，并把镜像摘要、归档校验、内部密钥生成、Compose 健康检查和 sidecar 健康状态纳入安装流程；本轮没有重新构建镜像或上传服务器。
- Dreamina CLI 的真实付费渠道接入路径已纳入归因上下文，但当前没有真实付费账号出站、账单对账或供应商收费口径验收，因此不能宣称 CLI 付费流量已生产验证。

## 当前工作区文件清单

以下是本次盘点时所有已修改 tracked 文件和已出现的 untracked 源文件，共 106 个；已排除 `.venv`、`node_modules`、`.next`、构建输出、pytest 缓存、Playwright 产物、日志和其他生成文件。`CHANGELOG.md` 与 `docs/content/docs/progress/pending-test.mdx` 为根任务已有改动，本轮只登记、不修改。

### 根配置、桌面打包与部署

- `.env.example`：加入 traffic-meter 镜像、远程地址、密钥、端口、绑定地址、公共主机和状态路径模板。
- `Dockerfile`：把 meter client 源码复制进生产镜像并设置 Python 导入路径。
- `apps/desktop/scripts/prepare-runtime.mjs`：把 `services/traffic-meter/src` 纳入桌面 Runtime staging。
- `apps/desktop/scripts/prepare-runtime.test.mjs`：断言桌面 Runtime staging 会携带 traffic-meter 源码目录。
- `docker-compose.yml`：加入桥接网络 traffic-meter、独立状态卷、Provider URL/key 和健康依赖。
- `docker-compose.local.yml`：为本地 Compose 加入桥接 traffic-meter、内网端口和共享密钥。
- `docker-compose.lowmem.yml`：为低内存拓扑加入独立 sidecar、持久卷和健康依赖。
- `docker-compose.external-db.yml`：为外置 PostgreSQL 拓扑加入桥接 sidecar 与 Provider 计量配置。
- `docker-compose.baota.yml`：为宝塔 host 网络拓扑加入回环监听的 traffic-meter。
- `docker-compose.offline.yml`：为内置 PostgreSQL 离线拓扑加入 meter 镜像、GPT/Dola/Gemini URL/key 和健康依赖。
- `docker-compose.offline-external-db.yml`：为外置 PostgreSQL 离线 host 网络拓扑加入回环 meter 和所有 Provider 依赖。
- `scripts/build-docker-offline-package.sh`：构建、加载、导出、校验并写入 traffic-meter 离线镜像、归档和 manifest。
- `scripts/deploy-docker-offline.sh`：加载 meter 镜像、生成并校验 32 字符密钥、选择项目、输出日志并等待 sidecar 健康。
- `services/dola-api/Dockerfile`：通过 BuildKit named context 复制 meter client，并把它加入 Dola 的 `PYTHONPATH`。
- `services/geminiai/Dockerfile`：通过 BuildKit named context 复制 meter client，并把它加入 GeminiAI 的 `PYTHONPATH`。
- `docs/backend-database.md`：把出口流量持久化说明从 DOLA 局部统计更新为全局 meter、租约和 TCP 计量边界。
- `CHANGELOG.md`：根任务已有的全渠道流量统计变更记录，本轮未修改。
- `docs/content/docs/progress/pending-test.mdx`：根任务已有的流量统计待服务器验收事项，本轮未修改。

### traffic-meter Python sidecar

- `services/traffic-meter/Dockerfile`：定义 Python 3.12 sidecar 镜像、默认端口、状态路径和安装入口。
- `services/traffic-meter/pyproject.toml`：声明 FastAPI、HTTPX、pproxy、Pydantic、Uvicorn 依赖及 `traffic-meter` 命令。
- `services/traffic-meter/src/traffic_meter/__init__.py`：导出 Provider 共用的客户端、租约和异常类型。
- `services/traffic-meter/src/traffic_meter/client.py`：实现带 `X-Traffic-Key` 的异步/同步租约申请、释放和查询客户端。
- `services/traffic-meter/src/traffic_meter/core.py`：实现带上下文归因、Pinned target、pproxy relay 和 SQLite WAL 字节计量的核心引擎。
- `services/traffic-meter/src/traffic_meter/main.py`：提供健康检查、租约申请/释放和内部流量查询 HTTP API。
- `services/traffic-meter/tests/browser_fixture.py`：提供仅回环网络的可复现浏览器 E2E seed/control fixture，并输出动态端口 manifest。
- `services/traffic-meter/tests/test_meter.py`：覆盖 relay、租约生命周期、认证、上下文、字节累计和查询过滤契约。

### Python Provider 上下文与租约接入

- `services/chatgpt-api/api/app.py`：校验可信内部 traffic context 请求头并把上下文绑定到 ChatGPT 请求生命周期。
- `services/chatgpt-api/pyproject.toml`：把 HTTPX 声明为 ChatGPT Provider 的直接依赖。
- `services/chatgpt-api/uv.lock`：同步 ChatGPT Provider 的 HTTPX 锁定依赖元数据。
- `services/chatgpt-api/services/account_service.py`：为账号 token 刷新请求接入独立的 account probe traffic lease，并在异常路径释放租约。
- `services/chatgpt-api/services/log_service.py`：跨线程和流式迭代器复制上下文，保证日志调用继续携带归因信息。
- `services/chatgpt-api/services/openai_backend_api.py`：在同步 HTTP、流式响应和图片流程中申请/释放 meter lease 并保持原始日志 profile。
- `services/chatgpt-api/services/protocol/conversation.py`：把 traffic context 复制到图片并发 worker。
- `services/chatgpt-api/services/traffic_context.py`：定义 ChatGPT trusted context 解码、默认归因和租约辅助函数。
- `services/chatgpt-api/tests/test_account_refresh_traffic.py`：覆盖 GPT 账号刷新租约、直通回退、配置失败和异常释放。
- `services/chatgpt-api/tests/test_traffic_context.py`：测试 ChatGPT context 校验、默认值和租约错误边界。
- `services/dola-api/src/dola_api/app.py`：为 Dola 提交、账号检查、Google 登录和流量查询接入可信上下文及异步统计查询。
- `services/dola-api/src/dola_api/contracts.py`：扩展 Dola 请求模型的代理来源和 traffic context 字段。
- `services/dola-api/src/dola_api/query.py`：让账号探活、生成查询、素材读取和结果下载沿用统一的计量代理上下文。
- `services/dola-api/src/dola_api/session.py`：让浏览器会话、导航、登录和下载流程持有共享的计量租约边界。
- `services/dola-api/src/dola_api/traffic.py`：实现 Dola trusted context、meter relay 适配、旧本地统计兼容和查询封装。
- `services/dola-api/src/dola_api/uploads.py`：把 ImageX 上传、Apply、二进制和 Commit 请求接入对应上传计量配置。
- `services/dola-api/tests/test_traffic_context.py`：测试 Dola 只接受可信头部上下文并拒绝用户请求体伪造归因。
- `services/geminiai/src/aistudio_api/api/app.py`：在 GeminiAI HTTP 入口绑定可信上下文并标记共享浏览器调用。
- `services/geminiai/src/aistudio_api/infrastructure/gateway/client.py`：让 GeminiAI Gateway 请求携带模型、连接方式和共享浏览器归因信息。
- `services/geminiai/src/aistudio_api/traffic_context.py`：定义 GeminiAI context 解码、共享浏览器标识和 lease 生命周期辅助函数。
- `services/geminiai/tests/unit/test_traffic_context.py`：测试 GeminiAI 上下文校验、共享浏览器归因和租约释放行为。

### Web 运行时、服务端传输和管理接口

- `web/playwright.config.ts`：把 traffic E2E 场景纳入桌面与移动项目匹配范围。
- `web/scripts/chatgpt-api-local-runtime.mjs`：把 meter client 源目录加入本地 ChatGPT Provider `PYTHONPATH`。
- `web/scripts/compose-contract.mjs`：校验所有 Compose 拓扑的 meter 服务、网络边界、密钥、卷、镜像、BuildKit context 和健康依赖。
- `web/scripts/docker-offline-package.test.mjs`：更新离线镜像归档和诊断日志契约以包含 meter。
- `web/scripts/dola-api-local-runtime.mjs`：把 meter client 源目录加入本地 Dola Provider `PYTHONPATH`。
- `web/scripts/geminiai-local-runtime.mjs`：把 meter client 源目录加入本地 GeminiAI Provider `PYTHONPATH`。
- `web/scripts/run-app.mjs`：在开发运行时解析并监督本地 traffic-meter sidecar。
- `web/scripts/start-standalone.mjs`：在 standalone 启动时共享 meter URL/key 并监督 sidecar 生命周期。
- `web/scripts/traffic-meter-local-runtime.mjs`：实现远程 meter 复用、本地 loopback sidecar 解析、临时密钥和状态路径配置。
- `web/scripts/traffic-meter-local-runtime.test.mjs`：测试远程配置、本地 Dola Python 环境、回环绑定、端口校验和缺失运行时行为。
- `web/e2e/traffic.spec.ts`：覆盖后台流量筛选、渠道/模型/连接方式/端口显示和状态持久化的浏览器场景。
- `web/src/app/api/admin/traffic/route.ts`：提供带管理员权限检查和时间维度校验的全局流量查询接口。
- `web/src/app/api/admin/traffic/route.test.ts`：测试管理员权限、系统渠道补全和 meter 查询响应映射。
- `web/src/app/api/ai/system/[channelId]/[...path]/route.ts`：向系统 AI Provider 转发可信 traffic context 头部。
- `web/src/app/api/dola/[...path]/route.ts`：向 Dola Provider 转发服务端生成的 traffic context。
- `web/src/components/admin/admin-traffic-panel.tsx`：提供后台全局流量按时间、渠道、模型、连接方式和端口筛选的面板。
- `web/src/components/admin/admin-traffic-panel.test.tsx`：测试流量面板筛选序列化和共享浏览器标签文案。
- `web/src/lib/admin-traffic-types.ts`：定义流量筛选、明细和汇总的共享 TypeScript 类型。
- `web/src/lib/server/traffic-context.ts`：用 AsyncLocalStorage 保存可信请求归因并生成 Provider headers。
- `web/src/lib/server/traffic-context.test.ts`：测试并发请求间渠道、模型和角色上下文隔离。
- `web/src/lib/server/traffic-filter.ts`：解析带时区的时间范围及渠道、模型、协议、连接方式和端口过滤。
- `web/src/lib/server/traffic-filter.test.ts`：测试筛选维度、端口 0 和无效时间/端口输入。
- `web/src/lib/server/traffic-meter-client.ts`：实现 Web 服务到 meter 的认证查询客户端和超时处理。
- `web/src/lib/server/traffic-meter.integration.test.ts`：用 Node Undici 驱动真实 central traffic-meter relay，校验 Host、header 鉴权、socket 字节和租约关闭。
- `web/src/services/api/admin-traffic.ts`：封装后台流量查询 API 请求及错误映射。

### Web Provider 出站归因接入

- `web/src/app/admin/chatgpt-api/components/admin-chatgpt-api-section.tsx`：在 ChatGPT API 管理区接入流量统计入口或状态展示。
- `web/src/app/admin/runninghub/components/admin-runninghub-section.tsx`：在 RunningHub 管理区补充流量统计入口或归因展示。
- `web/src/components/admin/admin-dola-api-section.tsx`：在 Dola 管理区接入全局流量统计入口。
- `web/src/components/admin/admin-dreamina-section.tsx`：在 Dreamina 管理区接入 CLI 流量统计入口。
- `web/src/components/admin/admin-gemini-tools-section.tsx`：在 GeminiTools 管理区接入流量统计入口。
- `web/src/components/admin/admin-geminiai-section.tsx`：在 GeminiAI 管理区接入流量统计入口并保留共享浏览器归因语义。
- `web/src/components/admin/admin-minimax-h3-section.tsx`：在 MiniMax H3 管理区接入出站流量统计入口。
- `web/src/components/admin/admin-minimax-section.tsx`：在 MiniMax 管理区接入出站流量统计入口。
- `web/src/components/admin/admin-overview.tsx`：在后台总览加入全局流量统计区块。
- `web/src/components/admin/channels/admin-channel-detail-drawer.tsx`：在渠道详情抽屉加入按渠道查看流量的入口。
- `web/src/lib/server/audio-task-runtime.ts`：为音频任务提交、查询和下载建立对应的 traffic context。
- `web/src/lib/server/chatgpt-api-service.test.ts`：回归 GPT Provider header 组合，拒绝带 traffic context 但缺少内部 dispatch 标记的请求。
- `web/src/lib/server/chatgpt-api-service.ts`：向 ChatGPT API sidecar 请求传递可信 traffic context。
- `web/src/lib/server/dola/provider.ts`：为 Dola Provider 调用补充任务归因上下文。
- `web/src/lib/server/dola/service.ts`：让 Dola 服务层传递统一的 traffic context。
- `web/src/lib/server/dreamina-cli-provider.ts`：为 Dreamina CLI 的提交、状态查询和结果下载接入流量上下文。
- `web/src/lib/server/dreamina-cli-provider.test.ts`：覆盖 Dreamina CLI 出站请求的流量上下文契约。
- `web/src/lib/server/gemini-tools-service.ts`：为 GeminiTools 出站请求补充渠道、模型和连接方式归因。
- `web/src/lib/server/gemini-tools-service.test.ts`：测试 GeminiTools 归因请求和共享上下文边界。
- `web/src/lib/server/geminiai-provider.ts`：向 GeminiAI sidecar 请求注入可信 traffic context。
- `web/src/lib/server/image-task-runtime.ts`：为图片任务提交、查询和下载建立独立的 traffic context 作用域。
- `web/src/lib/server/minimax-audio-store.ts`：为 MiniMax 音频请求补充渠道、模型和协议归因。
- `web/src/lib/server/qwen-audio-service.ts`：为 Qwen 音频请求补充渠道、模型和协议归因。
- `web/src/lib/server/runninghub-service.ts`：为 RunningHub 上传、提交和查询请求补充流量归因。
- `web/src/lib/server/safe-outbound-fetch.ts`：在可信 pinned target 上申请 meter lease、通过 relay 发起请求并在流结束时释放。
- `web/src/lib/server/safe-outbound-fetch.test.ts`：测试安全出站请求的 meter lease、流式释放和原有代理边界。
- `web/src/lib/server/text-task-runtime.ts`：为文本任务提交和取消查询建立 traffic context。
- `web/src/lib/server/video-task-runtime.ts`：为视频任务查询和结果下载建立 traffic context，并保留 Dola 验证状态。

### 模型目录与取消请求补充归因

- `web/src/app/api/admin/models/route.ts`：已保存渠道的目录同步按真实渠道与协议记录，单列模型目录；未保存配置不伪造渠道身份。
- `web/src/app/api/admin/models/route.test.ts`：验证服务端保存的渠道归属与未保存配置行为。
- `web/src/lib/server/generation-task-cancellation-service.ts`：直接上游取消请求按原任务渠道、模型与 cancel 角色计量。
- `web/src/lib/server/generation-task-cancellation-service.test.ts`：验证取消操作的真实任务归属及原有取消契约。

### 本地进程关闭顺序

- `web/scripts/generation-runtime.mjs`：先关闭渠道、Web 和 worker，待真实关闭事件到齐后再关闭 traffic-meter。
- `web/scripts/generation-runtime.test.mjs`：验证计量服务最后关闭、异常退出与原有监督行为。

## 验收边界

- 本地和 CI 可以验证 API、上下文、relay、配置契约、浏览器交互和离线打包脚本；手工 GPT OAuth 登录浏览器、user-code exchange 与 Gemini `LoginService` 手工认证明确排除出生成流量统计，不能据此宣称生成路径已覆盖；根任务应在最终汇报中补入实际执行的命令与数量。
- 真实服务器部署、镜像加载、重启持久化、真实上游生成/上传/下载、真实付费 CLI 账号和 ISP/供应商账单对账仍属于单独验收边界。
- 任何生产报告都应把“TCP relay 字节统计”与“ISP/供应商账单”分开描述，并把 GeminiAI shared browser 单列，避免把共享流量误算到某个模型。

## 可复现浏览器 fixture

在仓库根目录执行以下命令启动仅访问 `127.0.0.1` 的本地 seed/control fixture。命令会生成至少 32 字符的临时密钥；启动输出包含 fresh fixture 目录、`ports.json` 路径和动态端口，浏览器回归应读取该 JSON：

```bash
TRAFFIC_METER_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')" \
PYTHONPATH=services/traffic-meter/src \
python services/traffic-meter/tests/browser_fixture.py
```

可选设置 `DREAMYO_TRAFFIC_FIXTURE_DIR` 复用指定目录。fixture 只使用回环 echo、upstream 和 proxy，不访问外部网络；主图上下行 seed 为 `b"fixture" * 128`（各 896 B），另含 `e2e-video` 与 `e2e-text` 两个上下文。新增文件：`services/traffic-meter/tests/browser_fixture.py`。

## 本地验证结果（2026-10-01，最终构建 AbnrhqmeJ84Zx1b5E_5U5）

- Web 全量 Vitest：699 个测试文件通过、6 个跳过；3492 项通过、12 项跳过。跳过项由各测试的数据库/运行环境条件控制，不能视为已验证。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全部通过；已按生产模式重启 `PORT=3333 pnpm start`，本地独立 meter、DOLA 与 GeminiAI 服务正常启动。
- `pnpm test:protocols` 在真实 central meter 环境下：7 个文件、159 项通过。Web 本地 TCP fixture 的请求实际落入 central SQLite，累计覆盖 20 个协议标识；Python Provider 桥接仍由隔离 mock 验证，不能等同真实付费上游验收。
- central meter：10 项通过，包含大小写 HTTP 鉴权、持续 HTTP 转发不泄露 Proxy-*、HTTP/TLS 的独立 socket 字节核对、代理、DNS 固定地址、租约释放与时间过滤。DOLA 全量：121 项通过；GPT 最终范围检查：20 项通过；GeminiAI 相关：36 项通过。
- 浏览器流量专题：12 项通过（3 项初始化、桌面/390px/430px 各 3 项），覆盖浅深主题、时间弹层边界、时间/渠道/模型/模式/端口筛选、空结果、渠道详情按需加载。原始 fixture 上下行各 896 B，API 和界面均精确返回各 896 B；没有使用上传文件大小估算。
- 实际生成流程的本地 fixture 回归：文本故障转移、图片落盘与幂等、视频提交/取消、音频落盘、Canvas 编辑/连线/持久化、首尾帧重试与引用、完成视频引用以及发送前本地附件草稿均通过。
- 一项既有 `core.spec.ts` 用例仍寻找已移除的 `.creative-composer`；当前未修改的 `/create/page.tsx` 渲染 ImageVideoWorkbench，该用例在生成前失败。未将该失败算作通过，也未为本轮统计功能改动无关页面。
- 7 种 Compose 配置、离线打包/启动契约测试通过；未构建新的 Docker 镜像或部署服务器。严格 UTF-8 解码、乱码标记扫描和 `git diff --check` 通过。
- 六组当前构建的浅深主题截图与几何证据保存在 `docs/assets/traffic-meter-20261001/`。截图中的商业订单 PostgreSQL 提示来自隔离 file-provider 测试环境，首页商业订单统计不属于本轮验收范围。

统计自本轮计量接入开始，不追算历史。全局统计仅计算渠道的出站 TCP 段，内部服务转发不重复计数。GeminiAI 的持久共享浏览器只能按共享模型、共享渠道及实际端口统计；其具体模型、渠道别名与可变代理模式无法精确拆分。人工 GPT/Gemini OAuth 管理登录排除在生成统计外。Dreamina CLI 的真实付费生成、服务器持久化/重启和供应商账单对账尚未验证。

本轮代码尚未提交、推送或部署。服务器升级须同时部署独立 `traffic-meter` 服务、持久卷与至少 32 字符的私有服务密钥，不能仅替换 Web 前端。

最终补充验证：模型目录与取消请求专题 27 项通过，进程关闭顺序专题 10 项通过。最后一轮全量测试 3492 项通过、12 项跳过，类型检查、lint 和生产构建全部通过。一次与构建并行执行时，打包脚本测试超过默认 5 秒；顺序重跑全量通过，未调整超时。最终构建的流量浏览器专题仍为 12 项通过。实际本地关闭时 GeminiAI 的 lease DELETE 返回 200，未再出现 traffic_meter_unavailable；仍保留启动器既有 5 秒强制退出契约。已重新启动本地生产服务。

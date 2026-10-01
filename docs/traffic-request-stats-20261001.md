# 全渠道请求级流量统计跟进清单（2026-10-01）

本文是 [前一份 106 文件架构与部署契约](./traffic-meter-20261001.md) 的请求级统计跟进，不替代前文，也不代表已经部署。本文只登记当前工作区的请求、任务、重试尝试、真实出站路径和后台展示改动；没有调用真实付费上游。

## 归因与计量契约

- `requestId` 是一次真实出站操作的稳定日志 ID；`taskId` 是本地生成任务 ID；`attemptId` 是该任务的一次提交、查询、上传、下载、取消或重试尝试。一个任务可以包含多个 request，重试不会覆盖旧 attempt。
- `channelId/channelName`、`model`、`protocol`、`connectionMode`、`role`、`attributionScope` 和实际 relay/upstream `port` 由服务端上下文产生。用户请求体、浏览器自定义 header 和时间/模型推断不能覆盖这些字段。
- 中央 SQLite 保存原始 `uploadBytes`、`downloadBytes` 和 `totalBytes`；后台的 MB、GB 只是显示单位：`1 MB = 1,000,000 B`、`1 GB = 1,000,000,000 B`，不是 MiB/GiB。全局、任务和请求明细沿用管理员设置的同一显示单位，原始字节仍是核对依据。
- 统计起点是本轮 meter 接入之后的真实 TCP relay 字节，包含代理握手/TLS 记录，不包含 Web 内部环回、IP/TCP 包头、重传、DNS UDP、代理后续跳点或结果下载之外的网络段；它不等于运营商或上游供应商账单。历史匿名事件不补填 `requestId/taskId/attemptId`，不能按时间窗口或模型猜归属。
- GeminiAI 持久浏览器是共享连接边界：使用 `channelId=geminiai/sharedchannel`、`model=__shared_browser__`、`attributionScope=shared_browser`；共享字节不带具体 request/task/attempt，也不声称属于某个具体模型或渠道别名。代理存在时 `connectionMode=unknown`，只展示实际端口；直连才标记 `direct`。人工 OAuth/Google 登录控制面仍属于管理登录，不纳入生成流量。

## 稳定 ID 与后台入口

| 出站面 | `requestId` 来源 | 任务/上游 ID 关系 | 后台明细入口 |
| --- | --- | --- | --- |
| GPT API | `LoggedCall.call_id` / `call_records.id` | `taskId` 保留本地生成任务，供应商诊断 ID 单独保存 | GPT 请求日志与请求流量明细 |
| DOLA | `dola_request_logs.id` | 同一 `task_id` 关联上传、提交、查询；`role` 区分阶段、`attemptId` 区分提交尝试/重试 | DOLA 请求日志、任务流量明细 |
| GeminiAI | 请求日志有稳定 ID；浏览器字节保留共享归因 | 持久共享浏览器不能精确绑定具体请求、任务和模型 | GeminiAI 请求日志及共享浏览器说明 |
| GeminiTools | 服务端预先创建的 request-log ID | HTTP 调用保留本地生成任务 ID，可精确查询 | GeminiTools 请求日志及通道明细 |
| Dreamina CLI | `dreamina-cli-log-*` | `generation_task_id` 与 `submissionId` 保持独立 | Dreamina CLI 请求日志 |
| RunningHub | `runninghub_request_logs.id` | `runninghub_tasks.id`、`remote_task_id` 单独记录 | RunningHub 上传/提交日志 |
| 通用文本/图像/视频/音频 | 生成日志或 provider 预分配的 request log ID | `generation_tasks.id`、slot、`upstreamTaskId` 不互相替代 | 任务列表、请求明细、生成日志 |

新增后台服务端接口为：

- `GET /api/admin/traffic`：按时间、渠道、模型、协议、连接模式和端口查询全局汇总，返回覆盖边界说明。
- `GET /api/admin/traffic/tasks`：按 `taskId` 分页，任务内再按 request/attempt/role/route split 展开。
- `POST /api/admin/traffic/requests`：按稳定 `requestIds` 和可选 `taskIds` 精确查询；不会把共享浏览器字节拼入 exact request。

## 文件级跟进清单

### Web 上下文、内部来源与计费关联

- `web/src/lib/server/traffic-context.ts`：用 AsyncLocalStorage 保存服务端渠道、模型、协议、路由、角色及 request/task/attempt ID，并生成受信 `x-dreamyo-traffic-context`。
- `web/src/lib/server/traffic-context.test.ts`：验证并发上下文隔离、服务端生成 header 和 request/task/attempt 传递。
- `web/src/lib/server/internal-origin.ts`、`web/src/lib/server/internal-origin.test.ts`、`web/src/lib/server/internal-origin.integration.test.ts`：内部 Web→Provider 请求沿用受信上下文，禁止用户头部伪造归因。
- `web/src/lib/server/system-ai-billing.ts`、`web/src/lib/server/system-ai-billing.test.ts`：系统 AI 的点数/账单关联与传输字节分开，内部调用沿用同一上下文。
- `web/src/app/api/ai/system/[channelId]/[...path]/route.ts`、`web/src/app/api/dola/[...path]/route.ts`：内部 Provider dispatch 入口生成并转发可信上下文。
- `web/src/lib/server/traffic-meter-client.ts`：认证的 lease、release、global/task/request 查询客户端；未配置 meter 时保留直通行为，配置失败返回明确错误。
- `web/src/lib/server/safe-outbound-fetch.ts`、`web/src/lib/server/safe-outbound-fetch.test.ts`：固定目标的 HTTP 出站申请 relay lease，流结束、取消和异常释放；不记录 body/cookie/密钥。
- `web/src/lib/server/traffic-filter.ts`、`web/src/lib/server/traffic-filter.test.ts`：时间窗、渠道、模型、协议、连接模式和端口解析/校验。

### 任务运行时、通用 trace 与生成日志

- `web/src/lib/server/image-task-runtime.ts`、`web/src/lib/server/video-task-runtime.ts`、`web/src/lib/server/audio-task-runtime.ts`、`web/src/lib/server/text-task-runtime.ts`：提交、查询、下载、取消等阶段分别建立 role/attempt 上下文。
- `web/src/lib/server/generation-task-cancellation-service.ts`、`web/src/lib/server/generation-task-cancellation-service.test.ts`：取消请求沿用原任务的真实渠道/模型并生成独立 cancel attempt。
- `web/src/lib/generation-log-snapshot.ts`：把 request/task/attempt、协议 trace、请求/响应字节和 slot 元数据整理为公开的生成日志快照。
- `web/src/lib/server/generation-log-repository.ts`、`web/src/lib/server/generation-log-repository.test.ts`、`web/src/lib/server/generation-log-task-service.ts`：持久化日志、任务关联与明细查询，保持 provider upstream ID 与本地 ID 分离。
- `web/src/app/api/video-generation-tasks/video-generation-route.ts`：生成任务和上游任务创建时保留稳定 task/attempt 关联。
- `web/src/lib/server/minimax-audio-store.ts`、`web/src/lib/server/qwen-audio-service.ts`：音频 provider 的真实请求日志 ID 与 submit/query/download 上下文。

### Provider 出站桥接

- `services/chatgpt-api/api/app.py`、`services/chatgpt-api/services/traffic_context.py`：验证可信 header、绑定 GPT 请求上下文和 lease 边界。
- `services/chatgpt-api/services/log_service.py`：将 `LoggedCall.call_id` 绑定为当前 request ID，并显式复制线程池/流式 worker 上下文。
- `services/chatgpt-api/services/openai_backend_api.py`、`services/chatgpt-api/services/protocol/conversation.py`：同步、流式、图片和签名上传使用实际 egress profile 申请/释放 relay，日志继续保留原始出口 profile。
- `services/chatgpt-api/services/account_service.py`：账号 token 刷新的维护请求使用 `__account_probe__`/维护角色和实际 profile 路由；不把生成模型伪装到刷新请求。
- `web/src/lib/server/chatgpt-api-service.ts`、`web/src/lib/server/chatgpt-api-service.test.ts`：Web 到 GPT sidecar 的内部 dispatch header 和上下文回归。
- `services/dola-api/src/dola_api/app.py`、`contracts.py`、`traffic.py`、`query.py`、`session.py`、`uploads.py`、`tests/test_traffic_context.py`：DOLA HTTP、浏览器共享会话、ImageX 上传、提交/查询/下载和内部查询统一使用可信上下文。
- `web/src/lib/server/dola/provider.ts`、`web/src/lib/server/dola/service.ts`：DOLA 任务阶段上下文桥接；DOLA 浏览器后台与具体生成任务分开统计。
- `services/geminiai/src/aistudio_api/api/app.py`、`traffic_context.py`、`infrastructure/gateway/client.py`、`tests/unit/test_traffic_context.py`：GeminiAI sidecar header、共享浏览器 lease、持久连接关闭/重启生命周期和未知代理模式。
- `web/src/lib/server/geminiai-provider.ts`、`web/src/lib/server/gemini-tools-service.ts`、`web/src/lib/server/gemini-tools-service.test.ts`：Gemini provider 出站上下文及 request-log 关联。
- `web/src/lib/server/dreamina-cli-provider.ts`、`dreamina-cli-service.ts`、`dreamina-cli-store.ts`、对应 `dreamina-cli-provider.test.ts`、`dreamina-cli-service.test.ts`、`dreamina-cli-store.test.ts`：CLI spawn 前预分配 request log ID，子进程继承专用 HTTP(S) proxy 环境，成功/失败都保留同一 request/task/attempt。
- `web/src/lib/server/runninghub-service.ts`、`runninghub-store.ts`、`runninghub-service.test.ts`：上传与 JSON 提交分别预分配稳定 request log，任务 ID、远端任务 ID 和上传/提交路由拆分。

### Python central meter、请求查询与 fixture

- `services/traffic-meter/src/traffic_meter/core.py`：`traffic_events` 保存 request/task/attempt、归因字段、实际端口与原始上下行字节；任务分组、请求精确查询和 shared-browser 排除规则在此实现。
- `services/traffic-meter/src/traffic_meter/main.py`：提供 `/internal/leases`、`/internal/traffic`、`/internal/traffic/tasks`、`/internal/traffic/requests`。
- `services/traffic-meter/src/traffic_meter/client.py`、`__init__.py`：Provider 共用的异步/同步租约与查询客户端。
- `services/traffic-meter/tests/test_meter.py`：覆盖实际 TCP relay、代理/TLS 字节、认证、lease 释放、时间过滤、任务合计、request/attempt/role/route split 和 shared-browser 边界。
- `services/traffic-meter/tests/browser_fixture.py`：仅回环的浏览器 seed/control fixture；保留旧 direct/magic/generic seed，新增同一 `e2e-task-image`/`e2e-request-image` 的 direct upload + 第二 upstream port 的 chained submit。每个 seed 使用独立目标/代理 capture socket，按 request ID 记录连接数和 wire bytes，并在 `ports.json` 分开输出 `payloadExpected`、独立实测的 `rawExpected`、`splitPorts` 和 `seededRequests`。
- `services/traffic-meter/pyproject.toml`、`Dockerfile`、`uv.lock`：sidecar 运行入口与依赖契约；`.venv`、`__pycache__`、`egg-info` 属于本地生成物，不是部署清单。

### 新 API、类型、设置与管理员 UI

- `web/src/lib/admin-traffic-types.ts`：共享全局、任务和 request 明细类型，包含原始字节、显示单位、路由 split 和覆盖状态。
- `web/src/app/api/admin/traffic/route.ts`、`route.test.ts`：管理员权限、时间过滤、渠道名称补全、全局 coverage 信息。
- `web/src/app/api/admin/traffic/tasks/route.ts`、`web/src/app/api/admin/traffic/requests/route.ts`、`task-requests.test.ts`：任务分页与稳定 ID 精确明细。
- `web/src/services/api/admin-traffic.ts`：前端查询封装。
- `web/src/lib/traffic-format.ts`、`traffic-format.test.ts`：SI MB/GB 格式化，默认 MB；不改变后端原始字节。
- `web/src/app/api/admin/settings/route.ts`、`web/src/lib/auth/store-types.ts`、`store-foundation.ts`、`store-normalizers.ts`、`web/src/lib/auth/store-settings-pipeline.test.ts`：保存、刷新和规范化全局 `trafficUnit`，设置立即影响全局/任务/request 统计。
- `web/src/components/admin/admin-traffic-panel.tsx`、`admin-traffic-panel.test.tsx`：全局时间、渠道、模型、模式、端口筛选和 MB/GB 选择。
- `web/src/components/admin/admin-task-traffic-panel.tsx`：任务列表及任务内 request/attempt/role/route split。
- `web/src/components/admin/admin-request-traffic.tsx`、`admin-request-traffic.test.tsx`：按 request/task ID 展开上传、下载、总量及实际 route。
- `web/src/components/admin/admin-overview.tsx`、`admin-configuration-sections.tsx`、`channels/admin-channel-detail-drawer.tsx`：总览、配置区和渠道详情的流量入口。
- `web/src/app/admin/chatgpt-api/components/admin-chatgpt-api-section.tsx`、`chatgpt-log-detail.tsx`、`chatgpt-request-log-panel.tsx`、`web/src/app/admin/runninghub/components/admin-runninghub-section.tsx`、`web/src/components/admin/dola-request-log-panel.tsx`：既有 provider 请求日志接入稳定 request/task 明细。
- `web/src/components/admin/admin-dola-api-section.tsx`、`admin-dreamina-section.tsx`、`admin-gemini-tools-section.tsx`、`admin-geminiai-section.tsx`、`admin-generation-log.tsx`、`admin-minimax-h3-section.tsx`、`admin-minimax-section.tsx`：各渠道日志/流量入口和 shared-browser/coverage 文案。
- `web/e2e/traffic.spec.ts`、`web/playwright.config.ts`：浏览器流量专题夹具和桌面/390px/430px 项目配置；最终浏览器门禁以根任务最后一次运行结果为准。

### 运行时、打包和部署契约登记

- `.env.example`、`Dockerfile`、`docker-compose*.yml`、`services/dola-api/Dockerfile`、`services/geminiai/Dockerfile`：sidecar URL/key、桥接网络、持久卷、BuildKit named context 和健康依赖。
- `apps/desktop/scripts/prepare-runtime.mjs`、`prepare-runtime.test.mjs`、`web/scripts/*-local-runtime.mjs`、`traffic-meter-local-runtime.test.mjs`：本地/桌面 runtime staging 和 sidecar 监督。
- `web/scripts/run-app.mjs`、`start-standalone.mjs`、`generation-runtime.mjs`、`generation-runtime.test.mjs`：Provider/Web/worker 先关闭，真实关闭事件到齐后再释放 meter。
- `scripts/build-docker-offline-package.sh`、`scripts/deploy-docker-offline.sh`、`web/scripts/compose-contract.mjs`、`web/scripts/docker-offline-package.test.mjs`：离线镜像、密钥、Compose 拓扑和安装诊断契约；本文件不宣称已构建或上传服务器。

## 本地 fixture 启动与验收边界

根任务完成生产构建并发出启动信号后，可在仓库根目录启动仅回环 fixture。密钥由 Python 进程生成并仅放入当前 shell 环境，命令不会打印密钥；控制台只输出 fixture 目录、`ports.json` 和动态端口：

```bash
cd /Users/dream/Desktop/Vibe\ Coding/PythonProject/Octal-Canvas
METER_KEY="$(services/traffic-meter/.venv/bin/python -c 'import secrets; print(secrets.token_hex(32))')"
export TRAFFIC_METER_KEY="$METER_KEY"
export PYTHONPATH="services/traffic-meter/src"
services/traffic-meter/.venv/bin/python services/traffic-meter/tests/browser_fixture.py
unset METER_KEY TRAFFIC_METER_KEY PYTHONPATH
```

fixture manifest 同时保留 payload 与 wire 两套值：`e2e-request-image` 的 payload 是 direct upload `896 B` + chained submit `11 B`，合计 `907/907/1814 B`；本地实测 central relay wire 为 upload `966 B`、download `965 B`、total `1931 B`，其中 chained submit 自身为 `70/69/139 B`（包含 HTTP CONNECT 请求/响应握手），direct upload 仍为 `896/896/1792 B`。历史 `e2e-request-video` 实测为 `570/569/1139 B`，`e2e-request-text` 实测为 `262/261/523 B`。这些是本地 deterministic seed，不是供应商账单样本；浏览器 E2E 必须读取 `rawExpected` 或按 `wireAudit` 对账，不能再把 payload `907 B` 当作 TCP 总量。

已完成的专项证据：

- `services/traffic-meter/.venv/bin/python -m pytest -q services/traffic-meter/tests/test_meter.py -k real_tcp_task_and_request_breakdowns_keep_retry_routes_together`：1 项通过，验证同一 task 下两个 request/attempt 的真实 TCP 字节和 magic/chained route split。
- `services/chatgpt-api/.venv/bin/python -m pytest -q services/chatgpt-api/tests/test_traffic_context.py services/chatgpt-api/tests/test_account_refresh_traffic.py`：15 项通过，覆盖可信上下文、账号刷新实际 profile、异常 release。
- `web` provider 专项：Dreamina CLI、RunningHub 共 4 个文件，28 项通过；其中 Dreamina 25、RunningHub 3，覆盖预分配 request ID、task/attempt 传递及 upload/submit 分裂。
- `python -m py_compile services/traffic-meter/tests/browser_fixture.py`：fixture 语法检查通过；fixture 运行完成：独立 TCP capture 与中央计量逐请求对账一致；最新浏览器结果见下文。
- 独立 fixture runtime audit：四条 seed 均使用独立 capture socket，`wireAudit.connectionCount=1` 且 request ID 精确匹配；SQLite 逐 request 的 central counter 与独立 `rawExpected` 完全一致。`e2e-request-image` 对账为 `966/965/1931 B`，不是 payload `907/907/1814 B`。
- 根任务已回收的同轮专项门禁快照还包括 central meter 11 项、DOLA 123 项、GPT 10 项和协议 159 项通过；这些数字只代表对应隔离测试范围，不代表真实供应商调用或部署验收。
- `pnpm exec vitest run --no-file-parallelism`（`web`，2026-10-01 18:15）：703 个文件通过、6 个跳过；3515 项通过、12 项跳过，耗时约 119 秒。跳过项仍按各测试环境条件处理，不能算作执行通过。

最终本地验收（2026-10-01）：

- `pnpm exec vitest run --no-file-parallelism`：703 个文件通过、6 个跳过；3519 项通过、12 项跳过。最终日志 `/tmp/traffic-request-full-vitest-final.log`。
- `pnpm typecheck`、`pnpm lint`、`git diff --check`：通过。144 个变更文本严格 UTF-8 解码通过，未发现常见乱码标记。
- `pnpm build`：通过；生产 Build ID `-TluvjGhFfy7SbYE9NlKM`。已按生产模式重启本地 `pnpm start`，首页 `3333` 与计量服务 `18083/health` 返回 200。
- 流量浏览器专题：21 项通过（3 项初始化；桌面 1440、390px、430px 各 6 项），包含浅深主题、MB/GB 即时保存/持久化/刷新、时间/渠道/模型/连接/端口筛选、全局/任务/请求聚合、DOLA 日志列表/详情/刷新。日志 `/tmp/traffic-request-browser-final.log`。
- DOLA 浏览器日志是隔离测试目录中的已知日志夹具，按同一个真实 meter request ID 加入：独立 wire capture 测得上行 966、下行 965、合计 1931 字节，API、日志和任务报表一致。直连上传为 896/896，链式提交为 70/69；后者含 11 字节正文与代理 CONNECT 开销。不是调用真实 DOLA 生成。
- 浅深主题截图及几何记录位于 `docs/assets/traffic-request-stats-20261001/`（不进 Git）。
- Canvas/图片/视频精选浏览器回归：6 项通过；2 条既有 `/create` 创作用例未通过，仍寻找 `creative-media-round`。当前未修改的 `/create/page.tsx` 渲染 `ImageVideoWorkbench`，这两条用例不能列为通过。证据 `/tmp/traffic-context-browser-subset.log`。
- 本地接入关联 ID 前的匿名计量库已保留在 `web/.data/traffic-meter/anonymous-archive-20261001-181320/`；新计量库按本轮 schema 建立。匿名历史无法追溯分配到任务，不作推算。

本轮没有 Git 提交/push 或服务器部署，没有新增付费上游生成。服务器重启/部署验收、真实供应商生成和供应商账单对账仍未执行；TCP 字节流统计与 ISP/供应商计费口径不同。

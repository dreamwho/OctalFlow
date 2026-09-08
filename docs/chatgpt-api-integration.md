# ChatGPT API 集成说明

## 当前使用入口与实现范围

后台 → 上游配置 → ChatGPT API，包含账号与渠道、统计报表、反代网关与 API 密钥、代理管理、IPWO、魔法代理、请求日志七个 Tab。

1. 导入本人有权使用的 ChatGPT 账号凭据；异步操作通过进度查询确认完成，导入本身不代表上游授权有效。
   默认导入不刷新上游，接口同步返回新增/更新或跳过数量，页面立即刷新账号列表；不会要求导入进度 ID。刷新额度、删除等返回 `progress_id` 的操作仍通过进度查询确认。
   在“文件导入”中多选 CPA 文件夹内的 `.json` 文件（推荐），或选择 Sub2API JSON 文件；两组来自相同账号时只需选择其中一组。页面会预览账号数并去重，确认后才提交；存在错误文件时必须重新选择。粘贴凭据方式继续保留。无需上传整个文件夹或手工拼接文件内容。
   可以一次选择 50 个账号，系统按每个请求的实际字节数自动拆批并显示已确认账号数。无需手动分组；中断时先核对账号列表，当前批可能已经写入，系统不会自动重试或继续后续批次。
2. 选择文本或图片模型并保存，自动同步 `chatgpt-api` 托管协议渠道与逻辑模型；站内调用不需要另填 API 密钥，也不依赖公共网关开关。
3. 单账号“刷新额度”和“刷新全部额度”都会自动跟随真实任务进度，显示等待动画、已处理数量和百分比，完成后刷新账号状态。进度连接中断保留未确认状态，“恢复进度连接”只查询原任务，不重新提交。每次额度刷新在请求日志中记录开始及最终结果，进度查询不重复记请求日志。
4. 统计支持 `24h`、`7d`、`30d` 原生时间桶和模型维度。当前 UI 已覆盖摘要、趋势、模型请求分布与耗时表，并补齐原生运行环境快照、调用活跃度热力图。
5. 代理管理覆盖代理组、节点、默认出口、失败回退、批量导入和单节点/全组测试。用户代理方式只有 `native`（移植代理管理）与 `magic`（魔法代理）两种；Next 管理桥 `/api/admin/chatgpt-api/proxy-selection` 对接 Python `GET/PATCH /integration/proxy-selection`，请求体持久化 `{enabled:boolean, mode:"native"|"magic", native_source:"manual"|"ipwo"}`，默认值为 `{enabled:false, mode:"native", native_source:"manual"}`。GET/PATCH 响应在这三项之外还返回 `magicConfigured:boolean` 与 `ipwoConfigured:boolean` 两个配置状态位，不返回代理凭据。`native_source` 只是 native 内部的手动代理或 IPWO API 自动源，不是第三种方式；`enabled=false` 强制直连，开启时只按 `mode` 选择一种方式。IPWO 使用独立 Tab 与来源开关选择 native 内的 `manual`/`ipwo`，关闭总开关不自动切换到另一来源。已存代理密码不回显；编辑已有节点或自定义出口时留空保留。关闭魔法代理不会自动恢复 native，必须显式切换策略；IPWO URL 同步与 mode 切换分开处理，IPWO 测试是显式临时诊断，不自动调用、不启用策略或保存节点。魔法代理订阅支持公开 HTTPS Clash YAML 地址导入，也支持后台直接选择 `.yaml`、`.yml` 或 `.txt` 文件上传；本地文件会按同一套 `proxies` 节点校验和大小限制处理，文件导入后不能执行地址刷新，需重新选择文件导入。
6. 外部客户端使用本系统地址下的 `/api/chatgpt-api/v1` 和本页创建的 API 密钥，需要单独启用公共网关。公共网关开关与代理总开关是不同配置；内部调用由管理员 Session/用户权限、渠道与计费链路控制，再通过仅服务端持有的运行时认证调用 Python，外部不能通过伪造内部标记绕过网关。

运行内核源于本地 `chatgpt2api2-main`，使用非官方 ChatGPT Web 接口，并非 OpenAI 官方 API 服务。实际可用性取决于账号、网络和上游变更；预置目录不代表账号拥有全部模型权限。

## 本地运行

### IPWO 测试诊断日志

“测试 IPWO 连接”弹窗按配置校验、API 提取、代理出口连接、出口信息读取显示真实步骤与耗时。连接失败显示 libcurl 数字错误码及安全中文说明；已识别的 CONNECT 响应保留 HTTP 状态码。未知错误明确说明阶段未确定，不推断为白名单或认证失败。错误分类参考 [libcurl 错误码](https://curl.se/libcurl/c/libcurl-errors.html)。

后端终端同步输出 `IPWO diagnostic=<单次测试标识> stage=... status=... elapsed_ms=... message=...`，用于关联同次测试的过程。日志不输出原始异常、API 提取链接、代理地址或凭据，也不关闭 TLS 校验或自动重试。提取成功只代表取得代理出口，不代表出口连通成功；再次点击测试可能消耗供应商资源。

执行 `services/chatgpt-api/setup.sh` 安装锁定依赖，然后在 `web` 目录执行 `pnpm build && pnpm start`。启动器自动管理已安装的 Python 内部服务，默认仅监听 `127.0.0.1:8046`；内部服务不应直接对公网暴露。

必须保留项目的 `OCTALAICANVAS_ENCRYPTION_KEY`，账号、用户密钥和代理配置在独立数据目录加密保存。应用 PostgreSQL 数据与 Provider 独立 SQLite 数据是两个存储边界，迁移时需同时保存 Provider 数据目录和加密密钥。完整环境参数见根目录 `.env.example` 与 `services/chatgpt-api/README.md`。

ChatGPT Magic Proxy 使用独立绑定和运行时配置；现有 Gemini 原生代理行为不因该 override 改变。监听端口、Docker 镜像和部署网络沿现有配置，本轮未重新构建或发布 Docker 镜像。

## 原始参照、桥接与 vendored 文件清单

原始统计/代理页面和契约来自本地 `chatgpt2api2-main`：

- `chatgpt2api2-main/web-vue/src/views/Dashboard.vue`：原始统计页参照；运行环境、活跃度热力图与模型请求分布已按本项目 React UI 接入。
- `chatgpt2api2-main/web-vue/src/views/Proxy.vue`：原始代理组、节点、默认/回退、导入和测试管理页。
- `chatgpt2api2-main/web-vue/src/api/stats.ts`、`web-vue/src/api/proxy.ts`：原始请求方法和前端 schema。
- `chatgpt2api2-main/api/system.py`、`contracts/proxy.py`、`api/dashboard_contract.py`、`services/dashboard_view.py`：原始管理员路由、代理契约、统计响应契约和统计组装。

Octal-Canvas 相关文件：

- `web/src/app/admin/chatgpt-api/components/admin-chatgpt-api-section.tsx`：ChatGPT API 管理 UI，承载账号/模型、网关、代理、日志及当前统计摘要。
- `web/src/app/api/admin/chatgpt-api/[...path]/route.ts`：Session、`upstream.manage` 权限、统计/代理管理员桥接和脱敏审计。
- `web/src/app/admin/chatgpt-api/components/use-account-operation-progress.ts`：串行自动跟随、页面可见性控制、终态停止及进度校验。
- `web/src/app/admin/chatgpt-api/components/chatgpt-statistics.tsx`：时间范围、统计摘要、成功/失败趋势与模型耗时。
- `web/src/app/admin/chatgpt-api/components/chatgpt-proxy-manager.tsx`：代理默认出口、组与节点编辑、导入和测试结果。
- `web/src/app/admin/chatgpt-api/components/chatgpt-ipwo-panel.tsx`、`web/src/services/api/chatgpt-ipwo.ts`、`web/src/services/api/chatgpt-ipwo.test.ts`：IPWO 独立 Tab、来源开关、脱敏设置/测试 API 及前端契约测试。
- `web/src/services/api/chatgpt-api.ts`、`web/src/lib/server/chatgpt-api-service.ts`：Next 管理桥的 `proxy-selection` 读写及 `native_source` 路由字段。
- `web/src/lib/channel-protocol-registry.ts`、`web/src/lib/auth/store-types.ts`、`store-normalizers-channel.ts`、`store-normalizers.ts`、`web/src/stores/use-config-store.ts`：注册托管协议及前后端渠道类型。
- `web/src/app/api/ai/system/[channelId]/[...path]/route.ts`、`web/src/lib/server/admin-model-catalog.ts`、`text-protocol-resolver.ts`：站内受控调用、模型目录与文本规划路由。
- `web/src/lib/server/chatgpt-api-service.ts`：内部运行时认证、Magic Proxy 绑定和错误脱敏。
- `web/src/lib/server/chatgpt-api-models.ts`：按原生目录能力保存托管渠道并同步逻辑模型。
- `services/chatgpt-api/contracts/proxy.py`、`services/chatgpt-api/services/dashboard_metrics_service.py`、`services/chatgpt-api/services/proxy_management_service.py`、`services/chatgpt-api/services/proxy_service.py`、`services/chatgpt-api/services/storage/dashboard_metrics_repository.py`、`services/chatgpt-api/api/support.py`：源项目统计/代理服务及受限运行时适配。
- 尚未 vendored 的原始统计组装/响应与完整 system 路由：`api/dashboard_contract.py`、`services/dashboard_view.py`、`api/system.py`；`services/chatgpt-api/UPSTREAM-SOURCE-MANIFEST.sha256` 记录来源边界。

## 主要修改文件

- `web/src/components/admin/admin-sections.ts`、`admin-section-nav.tsx`、`admin-dashboard.tsx`：新增权限控制、导航和按需加载入口。
- `web/src/app/admin/chatgpt-api/components/admin-chatgpt-api-section.tsx`：账号、模型、代理、网关密钥和日志管理页面。
- `web/src/app/admin/chatgpt-api/account-import.ts`、`account-import.test.ts`：CPA/Sub2API 多文件解析、凭据白名单、去重、错误拦截与既有请求大小限制测试。
- `web/src/app/admin/chatgpt-api/account-operation-result.ts`、`account-operation-result.test.ts`：区分原生同步完成与异步受理，覆盖新增、重复导入、部分失败和未知响应。
- `web/src/components/admin/admin-gemini-tools-section.tsx`：拆分代理 Tab，合并网关与 API 密钥 Tab。
- `web/src/services/api/chatgpt-api.ts`：统一后台请求和数据类型。
- `web/src/app/api/admin/chatgpt-api/[...path]/route.ts`：管理员鉴权、职责权限、请求白名单与脱敏审计。
- `web/src/app/api/chatgpt-api/[...path]/route.ts`：公开兼容接口、用户密钥校验和媒体响应桥接，继续受公共网关开关控制。
- `web/src/lib/server/chatgpt-api-service.ts`：内部认证、代理绑定、错误脱敏、安全参考图读取与签名媒体链接。
- `services/chatgpt-api/services/proxy_management_service.py`：`_proxy_selection_payload` 组装 `enabled`、`mode`、`native_source` 及 `magicConfigured`/`ipwoConfigured` 响应字段。
- `services/chatgpt-api/api/ipwo.py`：独立 IPWO 路由，已纳入运行时并通过真实 Next/Python 双进程 HTTP 验收。
- `web/src/lib/server/outbound-url-security.ts`：参考图读取可显式禁止访问私网，不改变既有渠道私网配置。
- `web/src/lib/server/magic-proxy-service.ts`、`database/magic-proxy-repository.ts`、`database/schema.ts`、`web/src/services/api/magic-proxy.ts`、`web/src/components/admin/magic-proxy-binding-card.tsx`：维护 ChatGPT Magic Proxy 独立绑定，并保留原有 Gemini Provider 行为；共享方式选择由 `proxy-selection` 契约负责，不由 Magic 关闭动作隐式恢复 native。
- `docker/mihomo/bootstrap.yaml`、`bootstrap-host.yaml`：声明独立代理组和监听配置；没有进行镜像构建。
- `web/scripts/chatgpt-api-local-runtime.mjs`、`start-standalone.mjs`：本地生产启动器接入 Python 生命周期。
- `services/chatgpt-api/`：移植执行内核、内部桥接、加密存储、锁定依赖及许可证来源清单；不复制原项目账号或数据库。
- `.env.example`、`.gitignore`：环境配置说明及运行数据排除。
- 对应 `*.test.ts`、`*.test.mjs`、`services/chatgpt-api/tests/test_runtime_contract.py`：鉴权、密钥、代理兼容性和持久化契约测试。
- `web/e2e/chatgpt-api.spec.ts`、`web/playwright.chatgpt-api.config.ts`：隔离生产模式的页面行为与响应式验收。
  文件导入专项覆盖 20 份夹具合并为 10 个账号、错误文件禁止提交、仅确认后提交、移动端弹窗与取消后清空；不使用真实账号进行浏览器提交。
- `web/scripts/accept-chatgpt-api.mjs`：隔离 Next/Python 双进程真实 HTTP 验收，不触发真实账号生成。
- `docs/backend-database.md`、`docs/content/docs/progress/`、`CHANGELOG.md`、`THIRD_PARTY_LICENSES.md`：数据结构、验收边界与开源归属说明。

## 验收边界

本轮实现包含额度自动进度、刷新日志、统计报表、代理组/节点/默认/回退/导入/测试管理、代理凭据脱敏，以及 `GET/PATCH /integration/proxy-selection` 对应的单一持久 `{enabled, mode, native_source}` 选择。默认值为 `false/native/manual`；`mode` 只有 native 与 magic，`native_source` 只在 native 内选择 manual 或 ipwo；响应另有 `magicConfigured`/`ipwoConfigured` 配置状态位。URL 同步不等同于 mode 切换；关闭总开关强制直连，不自动选择另一来源，关闭魔法代理也不自动恢复 native。

`chatgpt-api` 托管协议、逻辑模型和内部/公共网关分离已纳入当前验收范围。Web 质量门禁、typecheck、lint 和 production build 通过；真实 Next/Python 双进程 HTTP 已验证开关关闭、启用、读取持久化，IPWO 安全保存/不回显/不自动启用、代理 CRUD 及托管模型、keys、gateway。1440/390/430、浅深主题和 7 个 Tab 的 Playwright 验收通过，覆盖 mode 互斥、总开关关闭持久化、保存失败、IPWO 保存与显式日志；最新 IPWO 手机日志截图、重启后的 read 验收通过，本地 `3333` production 已启动。IPWO `timeout_seconds` 接受任意正整数、默认 10，不设 10–30 限制。Fake-IP 兼容沿用现有 TUN 模型而非 DoH：仅已验证的 `ipwo.net` HTTPS 子域标准 443 可解析到 `198.18.0.0/15`，Curl 固定该结果且保持 `verify=True`；其他私有/保留 DNS 结果拒绝，IPWO 返回的代理 IP 仍须为 public/global，且 `198.18/15` 不得用于返回的代理 endpoint。Python 全量测试 22 项 exit 0，仅有 2 条第三方 TestClient 弃用警告。本轮未调用真实上游，既有真实账号/上游能力和完整 Canvas/图片/视频业务矩阵未执行。

真实账号/上游生成、代理出口质量和完整 Canvas/图片/视频业务矩阵仍未执行；本轮没有调用真实上游，也没有构建 Docker。

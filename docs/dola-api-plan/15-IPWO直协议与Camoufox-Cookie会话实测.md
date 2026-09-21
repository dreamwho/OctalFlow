# IPWO 直协议与 Camoufox Cookie 会话环境矩阵实测

日期：2026-09-16。基础计划版本：v1.4；批量 Cookie 文件与独立 HTTP 复测的更新见 [16-105账号Cookie批量导入与直协议复测](16-105账号Cookie批量导入与直协议复测.md)。本次更新为 v1.7：已确认 Camoufox 页面会话为正式提交主链路，并分别记录 IPWO/us 区域阻断和显式台湾节点通过。状态：**协议环境选择已经取得可复现实测依据；应用已按用户确认进入实施。** 本页中的台湾节点只用于历史验证，产品实现统一接入现有通用代理管理，不提供区域专用配置。

本页记录用户指定的环境矩阵，并把结果转换为可直接交给后续 Agent 的实现合同。测试目标不是绕过 Dola 的验证机制，而是在相同 Fast 5 秒、16:9、单参考图条件下，确认哪种正常授权会话能提交并收到上游受理信号。早先因直连 Camoufox 已收到 ACK 而暂缓 IPWO+Camoufox；用户随后明确要求补测，故本版记录该组合的真实导航结果。

## 1. 测试问题与停止条件

固定输入：

- 模型：Dreamina Seedance 2.0 Fast，wire ID `seedance_v2.0`。
- 时长：5 秒。
- 比例：16:9。
- 引用：1 张项目自有 960×540 PNG。
- 会话：用户提供的 105 行 Cookie 文本文件第 1 条 Cookie Header；Cookie 值只在内存中解析并注入测试 context。
- 每个真实 Case 最多一次创建；写独占锁后无论成功、滑块或未知结果都不自动重发。
- 成功停止条件：`/chat/completion` 返回 HTTP 200 且 SSE 包含 `SSE_ACK`，没有 `verify/slide`，页面挑战 DOM 不可见。
- 阻塞条件：HTTP 200 但 SSE 为 `STREAM_ERROR`，decision 为 `type=verify/subtype=slide`，且无 `SSE_ACK`。

测试顺序：

| 顺序 | Case | 传输 | 代理 | 是否浏览器点击创建 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `DOLA-ENV-IPWO-F005-I1` | 独立 Python HTTP 协议 | 通用代理组 `ipwo` / 节点 `us` | 否 | `verify/slide`，未受理 |
| 2 | `DOLA-ENV-CAMOUFOX-F005-I1` | Camoufox 持久 context 内的 Dola 原生页面请求 | 直连 | 是，由 Provider 自动化原生页面 | `SSE_ACK`，无滑块 |
| 3 | `DOLA-ENV-CAMOUFOX-IPWO-F005-I1` | Camoufox 原生页面请求 | 解析的 `ipwo/us` | 未进入创建 | Dola 导航被 `/security/region-restricted` 拦截，未消耗额度 |
| 4 | `DOLA-ENV-CAMOUFOX-IPWO-TW-F005-I1` | Camoufox 原生页面请求 | 显式 HTTP/HTTPS 台湾节点 | 是，由 Provider 自动化原生页面 | `SSE_ACK`，无滑块 |

这里的“浏览器点击创建”只描述上游传输实现。正式产品仍由 Canvas/测试窗口调用本站服务端 API；用户不会手工进入 Dola 页面。Provider 在服务器 Camoufox context 中完成页面操作、签名请求观察和状态回传。

## 2. 第一轮：IPWO 通用代理下的独立协议提交

第一轮不是浏览器生成。执行器是独立 Python `httpx` 客户端，Dola 页面仅用于此前取得当前授权会话与参考图上传事实；本次创建请求完全由协议脚本发出。

执行步骤：

1. 从当前 ChatGPT API 运行时的受限解析接口取得通用代理 `ipwo/us`，代理 URL 只在进程内使用。
2. 用直连与代理出口分别请求出口检查服务，仅把 IP 做短哈希保存；两个哈希不同，证明测试流量确实经过 IPWO。
3. 能力接口通过 IPWO 返回 code 0，观察到 `seedance_v2.0` 与 `seedance_v2.5`。
4. 当前会话查询通过 IPWO 返回 code 0。
5. `pre_handle_v2_without_conv` 通过 IPWO 返回 code 0，并取得预生成标识。
6. 创建请求通过 IPWO 发出一次；没有使用复制的历史签名参数，也没有浏览器点击发送。
7. HTTP 返回 200 和 `text/event-stream`，事件为 `SSE_HEARTBEAT → STREAM_ERROR → SSE_REPLY_END`。
8. decision 为 `code=10000, from=shark_admin, type=verify, subtype=slide`；没有 `SSE_ACK` 或生成任务 ID。

结论仅限当前样本：**IPWO 通用代理不能让现有独立 HTTP 提交免于滑块。** 不能推断 IPWO 本身不可用，因为读取、查询和预处理都成功；也不能把 HTTP 200 当成生成受理。此路径不得作为生产默认，也不得在滑块后自动换代理重发。

脱敏证据：[DOLA-ENV-IPWO-F005-I1.sanitized.json](evidence/live/DOLA-ENV-IPWO-F005-I1.sanitized.json)。执行脚本：[env-matrix-probe.py](evidence/env-matrix-probe.py)。

## 3. 第二轮：用户 Cookie + Camoufox 直连

### 3.1 会话恢复与无额度预检

测试使用 Google AI Studio 现有模式的关键启动参数：

```python
Camoufox(
    headless=True,
    main_world_eval=True,
    persistent_context=True,
    user_data_dir="<PRIVATE_TEMP_PROFILE>",
)
```

用户 Cookie 文件被识别为 UTF-8 单行 Cookie Header。测试器用标准 Cookie 解析器生成仅限 `.dola.com` 的安全 Cookie 项，注入新建的专用 context；文件内容没有写入日志、JSON 证据或浏览器截图。预检只完成以下动作，没有点击发送：

1. 打开当前 Dola 会话路由并确认没有跳回登录页，也没有出现登录/注册按钮。
2. 进入 Create Videos，确认 `2.0 Fast` 模型入口可用。
3. 通过页面文件输入上传自有参考图，等待 `CommitImageUpload` HTTP 200，并确认编辑器仍持有一个文件。
4. 选择 5 秒与 16:9；确认编辑器、发送按钮、模型、时长、比例和附件各命中一次。
5. 清理预检 profile，以新 context 执行真实 Case，防止预检状态污染结果。

测试过程中发现，当前页面的附件预览不再统一使用历史 `flow-image-sign` URL。实现不能以固定图片域名或图片节点数量判断上传成功；应以本次上传请求的成功响应、编辑器附件状态和创建请求实际引用三者共同确认。

### 3.2 一次真实提交结果

创建前先写 `/tmp/DOLA-ENV-CAMOUFOX-F005-I1.lock`，再点击页面真实发送按钮一次。观察到：

- 账号会话恢复：通过。
- 模型/时长/比例/附件：Fast、5 秒、16:9、1 张图。
- `/chat/completion`：HTTP 200。
- 请求 URL：存在页面运行时生成的签名参数；证据只保存布尔值，不保存签名 URL。
- SSE：`SSE_HEARTBEAT、SSE_ACK、FULL_MSG_NOTIFY、DOWNLINK_CMD、STREAM_MSG_NOTIFY、STREAM_CHUNK、SSE_REPLY_END`。
- `verify/slide`：无。
- 页面挑战 DOM：不可见。
- 自动重发：无。

结论：**当前 Cookie 在全新 Camoufox 持久 context 中，可以用 Dola 原生页面链路提交 Fast 5 秒单图视频并收到 ACK，未显示滑块。** 用户已要求无需持续跟踪本次视频，因此本 Case 证明到“提交受理且无滑块”，不把它扩写成“媒体查询、下载和播放均已通过”。媒体闭环仍是 T02/T14 的实施验收项。

脱敏证据：[DOLA-ENV-CAMOUFOX-F005-I1.sanitized.json](evidence/live/DOLA-ENV-CAMOUFOX-F005-I1.sanitized.json)。执行脚本：[camoufox-env-probe.py](evidence/camoufox-env-probe.py)。

## 4. 第三轮：Camoufox + IPWO

本次按用户补充要求，使用 105 行 Cookie 文件第 1 条账号，在 `ipwo/us` 代理下启动全新 Camoufox context，目标仍为 Fast 5 秒、16:9、单参考图。代理确实被挂载到 Camoufox，但 Dola 首次导航被重定向到 `/security/region-restricted`，编辑器、模型选择器和发送按钮都没有出现，因此没有上传、没有点击创建、没有 `/chat/completion`、没有消耗视频额度。

结论：**IPWO+Camoufox 作为代理组合尚未形成可用生成链路；本次阻塞点是代理区域限制，不是滑块。** 该组合不能作为直连失败时的自动回退，也不能标记为生产可用。只有管理员显式绑定代理并通过新的地区、账号、上传、提交、查询和媒体闭环 Case 后，才允许加入账号池。

脱敏证据：[DOLA-ENV-CAMOUFOX-IPWO-F005-I1.sanitized.json](evidence/live/DOLA-ENV-CAMOUFOX-IPWO-F005-I1.sanitized.json)。执行脚本：[camoufox-env-probe.py](evidence/camoufox-env-probe.py)。

### 4.1 显式台湾 IPWO 节点复测

用户随后提供一个带鉴权的 HTTP/HTTPS 台湾节点。本次只把该 URL 在进程内解析为 Camoufox proxy 配置，用户名、密码和完整 URL 不写入输出；仍使用同一个 Cookie 文件第 1 条账号、全新 profile、Fast 5 秒、16:9、单参考图。由于上一次仅在页面初始化阶段超时，先将页面初始化等待改为可配置的 90 秒；这不是生成重试，之前没有发送创建请求。

实际结果：

- 账号会话恢复：通过。
- Dola 编辑器、Fast 模型、5 秒、16:9 和参考图：通过。
- `/chat/completion`：HTTP 200，页面签名参数存在。
- SSE：`SSE_HEARTBEAT → SSE_ACK → FULL_MSG_NOTIFY → DOWNLINK_CMD → STREAM_MSG_NOTIFY → STREAM_CHUNK → SSE_REPLY_END`。
- `verify/slide`：无；挑战 DOM：不可见；自动重发：无。
- `generationTaskId`：页面 ACK 未提供独立任务 ID；本 Case 只判定为“提交受理”，不宣称最终媒体已查询和下载。

结论：**显式台湾 IPWO 节点 + Camoufox 页面提交在该账号和这组参数下通过，未出现滑块。** 这只能作为 `accountId + credentialVersion + 通用代理目标快照 + 参数` 的可复现实验样本，不能推断解析的 `ipwo/us` 或其他节点、账号和地区均通过。生产仍以 Camoufox 为传输方式；代理由管理员显式绑定，且任务从上传到查询保持同一出口快照。

脱敏证据：[DOLA-ENV-CAMOUFOX-IPWO-TW-F005-I1.sanitized.json](evidence/live/DOLA-ENV-CAMOUFOX-IPWO-TW-F005-I1.sanitized.json)。

## 5. 确定的生产架构

### 5.1 主传输

`DolaProtocolProfile.transport` 的正式发布固定为 `browser-session/camoufox-page`。这表示所有生产提交必须由隔离 Camoufox 页面完成；页面内部观察到的 `/chat/completion` 仍是上游正常 HTTP 请求，但产品不使用无浏览器的 `httpx`/独立 HTTP 作为提交器。独立 HTTP 只保留为研究、协议诊断和失败对照，不进入普通 API 路由，也不能由任务运行时自动切换。代理是同一 Camoufox transport 的可选出口：直连仍是默认，显式台湾节点已在本 Case 通过，解析的 `ipwo/us` 仍因地区限制失败。运行中的任务永远不能因一个 transport 或代理失败而切换并重建。

```text
Canvas / 视频工作台 / 管理测试窗口
  → Next.js 创建持久 generation task 与 Dola attempt
  → 账号调度器固定 accountId + credentialVersion + proxyTargetSnapshot
  → 私网 dola-api Provider 领取一次 dispatch
  → AccountRuntimePool 取得该账号的 Camoufox context
  → Dola 原生页面上传引用、选择模型/时长/比例、填提示词
  → 写 dispatch_started 并点击发送一次
  → 监听该 page 发出的签名 /chat/completion 响应
  → SSE_ACK 后持久化 accepted；后续查询原会话/消息
  → 媒体下载、站内存储、Canvas 原节点更新
```

Provider 自动化的是上游页面，业务真源仍是本站数据库。BrowserContext、Page 和临时 profile 只是执行资源；进程重启后通过已存的 account/attempt/upstream identity 恢复，不能把浏览器内存当任务数据库。

### 5.2 AccountRuntimePool

运行时键：`accountId + credentialVersion + proxyTargetSnapshot`。每个键最多一个可写 context；并发超过该账号已验证能力时排队。Context 从加密 Cookie 初始化，成功页面访问后可把最新 Cookie 集合回写为新的加密 credential revision。规则：

- 账号之间绝不共用 profile、Page、Cookie jar、上传资源或 conversation。
- 同一 attempt 从上传到查询/下载固定账号和出口。
- 更新 Cookie、停用/删除账号或修改代理时，只影响新 attempt；空闲旧 context 安全关闭。
- 活动 page 崩溃后先按原 upstream identity 核对；没有确认未受理之前不再次点击发送。
- profile 放在 Provider 私有临时目录，0700；正常关闭、凭据替换和测试结束时删除。永久凭据只在 Next.js 加密数据层保存。
- 不使用用户日常 Chrome profile，不依赖桌面已打开的 Dola 页面。

### 5.3 页面操作与网络判定

页面控制优先使用可访问名称和当前业务语义，不使用压缩 class、固定 webpack 模块号或坐标点击。每个阶段都以网络/DOM双证据确认：

| 阶段 | 操作 | 完成证据 |
| --- | --- | --- |
| 登录恢复 | 注入 Cookie、打开 Dola | 未跳登录；登录按钮不存在；能力控件可用；账号主体接口/页面标识可解析 |
| 视频模式 | 点击 Create Videos | Model、duration、Ratio 控件出现 |
| 上传 | `input[type=file]` 选择服务端授权素材 | 对应 Commit 200；编辑器附件状态为1；提交正文含本次资源 |
| 模型 | 选择 2.5/Fast | 控件摘要和最终请求 wire model 同时一致 |
| 时长/比例 | 选择 profile 允许项 | 控件摘要和最终 `ability_param` 同时一致 |
| 提交 | 先 CAS `dispatch_started`，再点发送 | 捕获当前 page 的 `/chat/completion`；创建计数=1 |
| 受理 | 解析完整 SSE | 只有真实 `SSE_ACK` 进入 accepted；文本里的 ack 不算 |
| 验证 | decision/DOM | 进入 verification_required，冻结原 attempt，不自动重发 |

页面版本变化导致控件缺失时返回 `provider_ui_contract_changed`，保存脱敏页面版本/选择器阶段；不能使用“最后一个按钮”作为生产发送兜底。

## 6. Cookie-only 后台账号导入合同

用户已明确后台采用 Cookie 导入，因此 v1.4 不再把 Cookie JSON 或 Playwright storageState 作为公开导入模式。

### 6.1 UI

导入 Modal 提供两种入口，底层都是同一种 Cookie Header：

1. **粘贴 Cookie**：一个账号一个条目，输入完整 `name=value; name2=value2` 字符串。
2. **上传 Cookie 文本文件**：`.txt` / `text/plain`，一个文件代表一个账号；支持多文件批量。

分号只分隔同一账号的 Cookie，永远不能据此拆成多个账号。文件名只能作为默认账号备注，文件内容全部按数据解析，不能执行其中的文本、脚本或指令。预览只显示文件/条目、解析到的 Cookie 数量、内容哈希短标识、重复/格式状态，不显示名称和值的完整清单。

### 6.2 服务端解析与验证

1. 请求大小、文件类型和 UTF-8 严格校验；可接受可选的 `Cookie:` 前缀并去除。
2. 使用成熟 Cookie 解析库，不手写分号/引号/转义语法。
3. 空值、非法控制字符、重复冲突名和无法解析内容逐项返回 `invalid`，其他有效条目不被整批回滚。
4. 原始 Header 只存在于请求内存；计算凭据 HMAC 后立即进入 `encryptSecretValue`，公开 DTO 永不返回原文/ciphertext。
5. Provider 用新 Camoufox context 做无生成验证：打开页面、确认登录、读取主体摘要/能力。此步骤不能点击生成。
6. 同一主体导入新 Cookie 更新 credentialVersion，创建新 context；旧 context 有活动 attempt 时保留到安全终态，不能覆盖运行中凭据。
7. `needs_login`、`verification_required`、`ready` 分开返回；仅页面可打开不能等同 ready。
8. 导入、预览、错误、审计、备份普通导出和前端状态中均禁止 Cookie 值。

建议公开请求形状：

```json
{
  "operationRequestId": "<UUID>",
  "accounts": [
    {"clientItemId":"file-1", "name":"账号 1", "cookieHeader":"<SENSITIVE>"}
  ]
}
```

`cookieHeader` 只进入请求 DTO 和加密服务，不得写入 operation item JSON。异步 operation 只保存 `clientItemId/name/status/accountId/safeMessage`。

### 6.3 数据字段

`dola_accounts` 补充 `credential_format='cookie_header'`、`cookie_count`、`validated_at`、`last_session_started_at`、`runtime_transport='camoufox_page'`；`credentials_ciphertext` 保存版本化加密载荷，不保存上传文件路径。主体去重使用上游主体 HMAC；验证前暂用凭据 HMAC，验证后原子合并，禁止按昵称合并。

## 7. 滑块与人工验证的最终定位

Camoufox 当前 Case 没有出现滑块，只能证明这次环境和账号组合。不能声称 Camoufox 永久规避验证码，也不能加入自动拖动、轨迹伪造或验证码识别绕过。

当未来任务出现官方挑战：

1. Provider 已在原 account/context/page 中，所以直接保存 verification 与 challenge 关联，停止当前 dispatch 流程。
2. Canvas 原节点进入“需要完成 Dola 验证”；管理员后台和任务所有者受限 Modal 指向同一个 verification。
3. 只传输官方挑战区域和必要输入，人工操作；不暴露地址栏、聊天历史、Cookie或调试端口。
4. 验证后先观察 Dola 页面是否由官方 success callback 自动重发；`resumeOwner=official-page/service` 继续互斥。
5. 已产生 ACK 则继续查询；确认未受理且 service 获得唯一恢复权时，才建立一个恢复 attempt。未知状态不重发。

13/14 的受限验证设计继续有效，但从主链路前置门槛调整为生产故障恢复能力。上线前仍需用一次真实挑战完成裁剪、拖动、租约和双重重发验收；没有挑战样本时可以先以 fixture 验证状态机，功能标“待真实挑战验收”。

## 8. 代理策略与本轮发现的凭据暴露缺陷

默认 Dola 绑定为直连。通用/魔法/链式代理继续作为管理员显式配置，创建 context 前固定通用代理绑定快照；本轮台湾 IPWO 节点只属于实测参数，不形成 Dola 专属区域配置、环境变量或 `proxyRevision`，也不能作为默认或自动回退；不能在同一个 context 热切换，也不能因滑块自动改出口。

本轮只读调用发现 `services/chatgpt-api/api/integration.py::_redact_proxy_node()` 曾原样返回 `ProxyNode`，导致管理员 `/api/proxy/view` 响应可能包含节点完整 URL；本次实施已改为返回无凭据投影，并补充了带用户名、密码节点的回归。应用实施的 T10 仍需在目标部署复核：

- `/api/proxy/view` 的每个 node 只返回安全展示字段，`url` 为空或只返回无凭据的 host/port 投影。
- 保存 patch 仍通过服务端 `_restore_proxy_url` 合并旧密文/配置，空展示值不能误删凭据。
- `/api/proxy/resolve-url` 改为私网服务身份调用或移入 Provider 受限接口，不能由普通后台浏览器取得完整代理密码。
- 错误、审计和通用代理请求日志只存 scheme/host/port/group/node 安全标签。
- 增加含用户名、密码、转义字符的回归，检查 JSON、日志和异常文本均无原值。

这是实施前安全阻塞项；本轮没有修改现有运行服务。

## 9. 对原任务卡的具体调整

| 任务 | v1.4 调整 |
| --- | --- |
| T01 | 把四个环境 Case 加入脱敏协议基线；解析IPWO/us明确为region-restricted未创建，显式台湾节点为ACK无滑块 |
| T02 | 主实现固定 Camoufox page transport；直接复用 Google AI Studio 的启动思想，不复用其账号数据/Profile；完成 Cookie context、页面编排、网络事件与媒体查询 |
| T02-V | 从“主路径必须先解决一次滑块”改为异常恢复子任务；仍保留真实挑战发布验收 |
| T03 | 公开导入仅 Cookie Header 粘贴/文本文件；实现逐项解析、加密、主体去重、无生成验证和版本更新 |
| T04 | 调度 account runtime，而非把 Cookie 交给多个无状态 HTTP 请求；固定 transport/proxy snapshot |
| T05 | dispatch 前 CAS，页面点击一次；ACK/无ACK/滑块/未知结果分别持久化；后续精确查询原 page/conversation |
| T07 | Canvas 仍提供两模型、六比例与各自时长；挑战时原节点进入可恢复状态 |
| T08 | Dola API 页面导入 Modal 改成 Cookie-only；展示 Camoufox runtime 健康和账号会话状态 |
| T09 | 测试窗口走同一持久任务和 Camoufox Provider；不得前端直连 Dola |
| T10 | 修复 proxy view/resolve URL 凭据边界；Dola 默认直连，代理需单独验收 |
| T14 | 新增 Cookie导入、Camoufox选择器/网络fixture、真实ACK、未知提交和挑战恢复矩阵 |
| T15 | 镜像预装并锁定 Camoufox/Firefox依赖；私有profile权限、清理、健康检查和目标Linux验收 |

## 10. 实施与验收示例

### 10.1 Provider dispatch 伪代码

```python
runtime = pool.acquire(account_id, credential_version, proxy_target_snapshot)
page = runtime.video_page()
await ensure_authenticated(page)
await attach_owned_references(page, references)
await select_video_options(page, model, duration, ratio)
await fill_prompt(page, prompt)

await claim_dispatch_once(attempt_id, lease_epoch)
response = await click_once_and_wait_chat_completion(page)
result = parse_complete_sse(response)

if result.verification:
    await persist_verification_required(attempt_id, runtime.context_id, result.safe_decision)
elif result.ack:
    await persist_accepted(attempt_id, result.upstream_identity)
else:
    await persist_submission_unknown(attempt_id)
```

`click_once_and_wait_chat_completion` 必须绑定当前 page、本次操作和路径，不能捕获历史响应；异常后不调用第二次 click。选择器合同变化发生在 claim 前可以安全失败，发生在 claim/点击后只能进入 unknown/核对。

### 10.2 必须新增的自动化

| ID | 场景 | 断言 |
| --- | --- | --- |
| C01 | 单行 Cookie Header / 可选 `Cookie:` 前缀 | 解析成功、值不出现在响应/日志 |
| C02 | 多 `.txt`、重复主体、一个非法文件 | 有效逐项完成；重复更新/去重；非法不影响其他项 |
| C03 | Cookie 过期/跳登录 | `needs_login`，生成创建计数0 |
| C04 | 新 Cookie 更新运行账号 | credentialVersion递增；旧活动任务保持旧context；新任务使用新context |
| B01 | Camoufox 页面控件正常 | 模型/时长/比例/附件与最终网络body一致 |
| B02 | Commit 200但旧图片URL选择器不变 | 仍以附件状态和最终body确认，不误报上传失败 |
| B03 | 发送前控件合同变化 | 未claim/未点击；可安全失败 |
| B04 | 点击后无ACK且连接断开 | submission_unknown；创建次数1；不自动点击 |
| B05 | ACK + 后续媒体 | accepted后精确查询，下载原媒体，页面关闭可恢复 |
| B06 | verify/slide | 原attempt暂停；同context挑战；无换号/换出口/自动重发 |
| P01 | 默认直连 | 使用无代理context；与当前通过Case一致 |
| P02 | 管理员显式代理 | context启动前应用快照；上传/提交/查询/下载同一出口 |
| P03 | `/api/proxy/view` | 用户名、密码、完整URL在响应和日志中均不存在 |
| P04 | 解析的 Camoufox+IPWO/us 导航被区域限制 | 已实测“未创建”失败样本；UI标代理地区阻断，不能自动进入生产账号池 |
| P05 | 显式台湾节点 + Camoufox | 当前账号/Fast5秒/16:9/单图收到ACK且无滑块；只允许作为该通用代理目标快照的历史验证样本 |

### 10.3 真实发布验收

1. 导入一个用户授权 Cookie 文本文件，账号落库加密；重启 Provider 后新 context 仍能恢复登录。
2. 在目标 Linux/部署镜像执行 Fast 5 秒、16:9、单图，获得 ACK、原会话关联、完成结果、媒体下载和 FFprobe；创建 POST 计数为1。
3. Seedance 2.5 用已通过参数做同样 Provider 闭环；再按11验证15/30秒扩展预算。
4. 两模型六比例继续逐格记录菜单、wire参数与实际宽高；当前页面成功不替代未测格。
5. 如果真实挑战出现，完成受限人工验证和唯一恢复；如果没有出现，挑战功能保持“fixture通过、真实待验收”。
6. Cookie、签名URL、代理密码、Dola主体明文不进入浏览器日志、后台接口、截图、测试报告或部署包。

## 11. 证据边界和当前状态

已证明：

- IPWO 通用代理确实改变了独立HTTP出口，但该创建仍触发 `verify/slide`。
- 用户 Cookie 可以恢复到全新专用 Camoufox context。
- Camoufox 直连完成参考图上传、Fast/5秒/16:9参数选择，并一次提交收到 `SSE_ACK`，没有滑块。
- Camoufox + IPWO 已补测：代理导航被 `/security/region-restricted` 拦截，未进入创建、未消耗视频额度。
- 显式台湾 IPWO 节点 + Camoufox 完成参考图上传、Fast/5秒/16:9 参数选择，并一次提交收到 `SSE_ACK`，没有滑块。

尚未证明：

- 本次 Camoufox Case 的最终媒体查询、下载、播放与实际5秒规格；用户明确要求停止持续关注。
- 解析的 IPWO/us + Camoufox 当前不可用作生产默认；显式台湾节点仅对本 Case 的账号、凭据版本、参数和通用代理目标快照通过，启用前仍需完成目标环境的查询、下载和媒体闭环。
- Camoufox 对所有账号、地区、时间长期不出现挑战。
- 目标 Linux/容器已经具备相同结果。
- 应用账号库、Canvas、后台、网关、日志、去水印已经实现。

本轮只新增/更新方案、研究脚本和脱敏证据；没有修改应用源码、数据库、管理员账号配置或线上服务，没有建立部署包，也没有 Git 提交。

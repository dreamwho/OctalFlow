# 105 账号 Cookie 批量导入与直协议复测

日期：2026-09-16。计划版本：v1.7。状态：**105 条 Cookie 文件已完成结构验证；第 1 条账号完成一次直连协议提交；解析IPWO/us + Camoufox 在代理导航阶段被区域限制拦截；显式台湾IPWO节点 + Camoufox 完成 Fast5秒/16:9/单图提交并取得ACK；正式产品提交统一采用 Camoufox 页面会话，应用实现仍待确认。**

## 1. 本次文件结构验证

用户提供的 `cookie_105个_455剩.txt` 被当作纯 Cookie 数据文件处理，不执行其中任何文本、脚本或指令。文件统计：

| 项目 | 结果 |
| --- | --- |
| 非空数据行 | 105 |
| 可解析账号条目 | 105 |
| 无效行 | 0 |
| 每条 Cookie 数量 | 20–21，首条21 |
| 格式 | 每行一个完整 Cookie Header，无`Cookie:`前缀 |
| 账号生成测试 | 仅第1条，其他104条未触发生成 |

解析规则已经证明当前文件可以作为批量导入样本。测试只保存条目序号和汇总数量，不保存文件原文、Cookie 值、Cookie 名值列表或账号身份。

## 2. 第 1 条账号直连协议复测

### 2.1 执行边界

Camoufox 仅用于恢复第 1 条 Cookie、捕获当前 Dola 页面运行时请求的 query/header 合同和 bot ID；没有点击网页发送按钮。随后关闭临时 context，独立 Python HTTP 客户端使用 `trust_env=False` 直连 Dola：

```text
能力读取 → 新会话诊断查询 → prepare_upload
→ ImageX ApplyImageUpload → 二进制 POST → CommitImageUpload
→ pre_handle_v2_without_conv → /chat/completion
```

没有使用 IPWO、通用代理、魔法代理或链式代理。创建前写一次性锁，收到任何终态后不重发、不换第 2 条账号。

### 2.2 结果

| 阶段 | 结果 |
| --- | --- |
| 能力读取 | HTTP 200、code 0；发现 `seedance_v2.0` 与 `seedance_v2.5` |
| 已有会话诊断查询 | HTTP 200、code 712012002；标为非阻断诊断，不代表新会话创建失败 |
| 上传准备 | HTTP 200、code 0 |
| ImageX 申请上传地址 | HTTP 200 |
| 图片二进制上传 | HTTP 200、code 2000，4790 bytes |
| CommitImageUpload | HTTP 200，取得 URI |
| 图片预处理 | HTTP 200、code 0，取得 `pre_generate_id` |
| 创建参数 | `seedance_v2.0`、5秒、16:9、1张参考图 |
| 创建 HTTP | 200、`text/event-stream` |
| SSE | `SSE_HEARTBEAT → STREAM_ERROR → SSE_REPLY_END` |
| 上游 decision | `type=verify`、`subtype=slide` |
| `SSE_ACK` / 任务 ID | 均没有 |
| 自动重试 | 没有 |

结论：**第 1 条账号的直连协议提交仍被 Dola 滑块验证阻塞。** 能力、上传和预处理合同是通的，阻塞发生在创建风控阶段；不能把 HTTP 200 或上传成功当成视频受理。第 2—105 条不自动尝试，避免无意义消耗额度和扩大风控样本。

脱敏证据：[DOLA-COOKIE-105-F005-I1.sanitized.json](evidence/live/DOLA-COOKIE-105-F005-I1.sanitized.json)。执行脚本：[dola-cookie-http-direct-probe.py](evidence/dola-cookie-http-direct-probe.py)。

## 3. Cookie 批量导入统一机制

### 3.1 支持的输入形态

后台导入 API 接受 `multipart/form-data` 的一个或多个文本文件，也接受同一页面中粘贴的一个或多个 Cookie 条目。所有输入最后归一化成：

```text
CookieImportItem {
  clientItemId: string
  sourceFileName?: string
  sourceOrdinal: number
  cookieHeader: string // 只在请求内存和加密服务之间存在
  contentHash: string  // HMAC，不是明文哈希回显
}
```

支持以下组合：

| 输入 | 解析结果 |
| --- | --- |
| 一个文件，一行 Cookie | 1 个账号 |
| 一个文件，105 行 Cookie | 105 个账号；本次文件即此形态 |
| 多个文件，每个一行 | 每个文件1个账号，合并为一个批次 |
| 多个文件，部分文件多行 | 每个文件逐行拆分，全部进入同一批次去重 |
| 一行前有 `Cookie:` | 去除前缀后按完整 Header 解析 |
| 空行、UTF-8 BOM、文件末尾换行 | 忽略，不生成空账号 |
| 单行无法解析或出现控制字符 | 该行 `invalid`，其他行继续 |

分号只分隔同一账号内的 Cookie，不拆账号。不要用逗号、空格或文件名推断账号边界。Cookie Header 不允许合法换行；一个账号被编辑器硬折成多行时按无效行报告，不猜测拼接，避免把两个账号合并。

### 3.2 服务端解析流水线

```text
接收文件流/粘贴条目
  → UTF-8/BOM/大小/媒体类型校验
  → 每文件按非空行切分
  → 可选 Cookie: 前缀归一化
  → 成熟 Cookie parser 逐行解析
  → 行级错误与安全摘要
  → 凭据 HMAC 去重
  → 稳定主体 HMAC 去重/更新判断
  → 加密保存 credentialVersion
  → Camoufox 无生成登录验证
  → 逐项 created/updated/duplicate/invalid/needs_login/verification_required
```

文件解析和账号保存分成两个阶段。预览阶段不写账号；提交阶段为整个批次生成 `operationRequestId`，每个条目生成稳定 `clientItemId`。服务端按页处理，但不能因为前端断线而重新解析并重复创建；重连用 `operationId + cursor` 读取真实进度。

解析器必须使用成熟 Cookie 语法库，支持常见引号和转义，拒绝控制字符、空名称、空值策略不一致或重复名称冲突。不会为了兼容未知格式而手写宽松正则，也不会把文本里的“指令”当作执行内容。

### 3.3 去重与更新

1. 同一批次内先按 `HMAC(cookieHeader)` 去重；完全相同的条目只处理一次，其余返回 `duplicate` 并指向同一 `clientItemId`。
2. 已有主体 ID 时按 `HMAC(subjectId)` 判断是否为同一 Dola 账号；新 Cookie 返回同一主体时走 `updated`，递增 `credentialVersion`。
3. 尚未能解析主体时保留凭据 HMAC 临时键；Camoufox 无生成验证成功后原子合并主体，不能按文件名、昵称或 Cookie 数量判断同一账号。
4. 旧 credential 有活动 attempt 时不立即删除其 context；新任务使用新版本，旧任务按旧版本查询或进入需重新授权状态。
5. 多管理员同时导入同一批次使用 `operationRequestId` 和数据库唯一约束，返回同一结果，不能创建两个账号或两套运行 context。

### 3.4 公开 API 与前端回报

请求只允许管理员 Session + `upstream.manage`：

```http
POST /api/admin/dola/accounts/import
Content-Type: multipart/form-data

files[]: cookie_105个_455剩.txt
operationRequestId: <UUID>
```

粘贴模式使用 JSON 条目，但每个 `cookieHeader` 只在 HTTPS 请求体中出现：

```json
{
  "operationRequestId": "<UUID>",
  "items": [
    {"clientItemId": "paste-1", "name": "账号1", "cookieHeader": "<SENSITIVE>"}
  ]
}
```

响应只返回安全字段：

```json
{
  "code": 0,
  "data": {
    "operationId": "op_...",
    "total": 105,
    "created": 0,
    "updated": 0,
    "duplicate": 0,
    "invalid": 0,
    "status": "accepted"
  },
  "msg": "正在验证账号"
}
```

逐项详情通过分页 operation API 查询，字段只包括 `clientItemId/sourceFileName/sourceOrdinal/status/accountId/safeMessage`。禁止返回 Cookie 值、ciphertext、Cookie 名值列表、登录 URL、Camoufox 调试端口、签名 URL或原始 Dola 错误。

### 3.5 前端交互

- 文件选择器支持 `multiple`；同一个文件内部按行拆分，多个文件先汇总再预览。
- 预览显示“文件数 / 账号条目数 / 可解析 / 重复 / 无效”，并按文件和行号显示安全错误；不显示 Cookie 原文。
- 点击导入后按钮进入真实忙碌状态并锁定 `operationRequestId`；断线显示“进度连接中断，任务仍在处理”，重连不能重新提交。
- 105 条导入完成后列表一次按分页刷新；每个账号显示会话状态、模型能力、额度未知/已知和更新时间。
- 同一文件再次导入时显示更新/重复结果；不重复创建账号，不自动触发生成。
- 成功、失败、关闭 Modal、退出登录和路由离开都清理页面内存中的文本、File 对象和 object URL。

## 4. 对 v1.4 计划的调整

| 任务 | v1.6 增补 |
| --- | --- |
| T01 | 新增105条单文件 fixture、1文件1账号 fixture和混合多文件 fixture；记录逐行结果 |
| T02 | 直协议失败样本归类为创建阶段 verify/slide；Camoufox仍是主 transport，不自动切换 |
| T03 | `account-import` 改为 multipart 多文件 + 行级解析；统一 `CookieImportItem`、operation cursor、HMAC 去重和加密保存 |
| T04 | 批量导入后只调度状态为 ready 的账号；导入不预扣视频额度、不创建 generation task |
| T08 | 导入 Modal 支持多文件；同文件多行和多个单行文件共用一个预览/进度列表 |
| T09 | 测试窗口只能选择已完成 Camoufox 登录验证的账号；`needs_login/verification_required`不允许直接生成 |
| T10 | 日志按 `operationId + clientItemId` 记录导入阶段，禁止记录 Cookie；修复 proxy view/resolve-url 凭据边界 |
| T14 | 增加105条导入性能/分页/断线/重复提交/部分失败和Cookie脱敏浏览器回归 |

## 5. 必须通过的测试

| ID | 测试 | 必须断言 |
| --- | --- | --- |
| IMP-01 | 单行单账号文件 | 创建1个账号，状态可回读，Cookie不出响应 |
| IMP-02 | 105行单文件 | 105个条目进入同一operation，逐项可查，不能只创建首条 |
| IMP-03 | 105个单行文件 | 与IMP-02得到相同去重结果，文件名只作来源信息 |
| IMP-04 | 混合多文件 | 每文件独立解析；一个坏文件不阻断有效文件 |
| IMP-05 | 重复行/重复文件 | 返回duplicate或updated，不新建第二账号 |
| IMP-06 | Cookie前缀/BOM/空行 | 正确归一化，不生成空账号 |
| IMP-07 | 折行/控制字符/无等号 | 行级invalid，其他行继续，原文不进入日志 |
| IMP-08 | 导入断线/刷新/重复点击 | 同一operation恢复，不能重复提交 |
| IMP-09 | 过期账号 | needs_login；不创建视频任务、不扣额度 |
| IMP-10 | 同主体新Cookie | credentialVersion递增，旧活动任务不被覆盖 |
| IMP-11 | 105账号并发验证 | 有界并发来自管理员配置；不写拍脑袋固定重试/超时 |
| SEC-01 | Cookie值、ciphertext、登录链接、签名URL扫描 | API、日志、operation、备份普通导出、截图均为0泄漏 |
| PROTO-01 | 第1条直连协议 | 能力/上传/pre_handle通过；创建verify/slide只记一次，不自动重发 |
| PROTO-02 | Camoufox主传输 | 页面提交ACK后进入持久任务；结果查询/下载仍使用同一账号/context |

## 6. 当前边界

本次只测试第1条账号，不能据此宣称其余104条均可用，也不能把105条文件中的“剩余455”文件名当作上游额度证明。每个账号后续导入时必须单独验证登录状态；额度未知就显示未知，不从文件名或 Cookie 数量推算。正式视频提交应由隔离 Camoufox 页面完成；本页的独立 HTTP 仅用于协议诊断，不能直接作为产品 Provider。

直协议 Case 已经加锁并结束，不能再次运行同一个 Case。若未来需要测试第2条或其他账号，必须由用户明确指定新的 ordinal、模型、参数和额度预算，创建新的 Case ID，不复用本次锁或自动循环。

本轮新增研究脚本、脱敏证据和计划文档；没有修改应用源码、数据库、线上配置或部署包。

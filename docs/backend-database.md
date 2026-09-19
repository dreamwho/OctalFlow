# 数据库部署与私有迁移

业务表结构以 `web/src/lib/server/database/schema.ts` 为准，数据库访问由项目 PostgreSQL executor 统一应用 `dreamyo_` 前缀。

## 私有数据迁移回执

`dreamyo_private_migration_receipts` 仅由离线迁移 CLI 在完整导入事务中创建：

| 字段                | 类型        | 用途                                                               |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| source_id           | text，主键  | 私有快照身份                                                       |
| source_digest       | text        | 原始 JSON 文件 SHA-256 摘要                                        |
| counts              | jsonb       | 导入实体数量，不包含密钥                                           |
| quarantined_records | jsonb       | 所属用户不存在的本地媒体原始登记记录，不伪造用户归属；文件继续保留 |
| imported_at         | timestamptz | 成功导入时间                                                       |

快照相同且摘要一致的重复部署不再次导入。不同快照或已有项目数据的数据库拒绝覆盖。建表、业务写入和回执在同一事务中提交或回滚。迁移必须使用本地原加密密钥；密钥独立保存在私有部署文件中，不写入回执或 Docker 镜像。

`--check` 不初始化表结构，不写业务数据。`needs_review` 任务保留原状态，不进入 Worker 自动恢复队列；其他可执行或暂停任务必须先在源系统完成或取消，再导出快照。

## 魔法代理

`dreamyo_magic_proxy_settings` 是单例配置表（`id = 'default'`）。订阅地址和节点明文以加密字段保存。GeminiAIStudio、GeminiTools、GPTAPI 与 Dola API 共用同一套魔法代理绑定，绑定模式为 `magic` 或 `chained`；Dola 同时通过相同的 Provider 入口支持通用代理引用。每个 Provider 都有独立 Mihomo 分组、监听端口和链式跳板组，启用一种来源时会自动关闭另外两种来源，不把代理密码或订阅明文返回浏览器。ChatGPT 自己的 native/magic 选择仍由 `/api/admin/chatgpt-api/proxy-selection` 维护，不能与本 Provider 绑定字段混用。

`dola_accounts` 保存 Dola Cookie 账号的脱敏业务状态；`cookie_ciphertext` 使用服务端密钥加密，`cookie_fingerprint` 只用于 HMAC 去重，列表接口不得返回任一敏感字段。`dola_api_keys`、`dola_gateway_settings` 分别保存 Dola 外部网关密钥和启用状态；`dola_request_logs` 记录请求受理、代理路由、账号鉴权、Camoufox 上游、验证、媒体查询与失败阶段，并保存脱敏请求/响应摘要、任务/验证 ID、时长比例、状态码、耗时和生命周期；Cookie、API Key、Token、参考图和视频二进制不写入日志。`dola_attempts` 固定 `account_id + credential_version + proxy_reference` 与租约序列，服务重启后按同一 attempt 恢复，不通过重发掩盖未知提交结果。代理引用来自现有通用代理管理的 `node:<id>` 或 `group:<id>`，不在 Dola 表中保存区域专用 URL 或密码。Dola 请求日志已同时支持加密 JSON Provider 与 PostgreSQL repository，后台列表使用服务端筛选、分页、聚合和详情抽屉。

Mihomo 固定声明 GeminiAIStudio、GeminiTools、ChatGPTAPI 和 DolaAPI 四个独立 group/listener，并为四者分别声明链式跳板组。Dola 的魔法/链式请求通过专用 listener 传给 Camoufox Provider；Dola 的通用代理仍只持久化 `node:<id>` 或 `group:<id>` 引用，运行时短暂解析为代理 URL。Next.js 到本地 Python 服务的内部请求保持直连。

IPWO 源设置使用独立 Tab 与 `/integration/ipwo` 契约；来源开关通过共享选择的 `native_source` 在 native 内选择 `manual` 或 `ipwo`，关闭总开关不自动改选另一来源。`GET/PATCH /integration/ipwo` 读取/保存只返回脱敏配置，读取字段为 `configured`、`has_api_url`、`protocol`、`regions` 和 `timeout_seconds`，不返回加密 `api_url`；保存时可提交 `api_url`、`protocol`、`regions` 和 `timeout_seconds`，省略或清空 `api_url` 保留已存密文。`timeout_seconds` 接受任意正整数，默认 10，不设 10–30 上限。Fake-IP 兼容沿用现有 TUN 模型而非 DoH；仅已验证的 `ipwo.net` HTTPS 子域标准 443 可解析到 `198.18.0.0/15`，Curl 固定该结果且保持 `verify=True`，其他私有/保留 DNS 结果拒绝，IPWO 返回的代理 IP 仍须 public/global，且 `198.18/15` 不得用于返回的代理 endpoint。`POST /integration/ipwo/test` 是显式临时诊断，可在共享开关关闭时使用已存配置运行，按固定阶段检查配置、IPWO、代理出口和 `ipinfo.io/json`，错误保持可操作但不暴露 URL、查询参数、令牌、上游原文或异常；不自动调用、不启用共享代理策略，也不写入节点。正常请求仍受共享 `enabled`/`mode`/`native_source` 门控。真实 Next/Python 双进程 HTTP 已验收 IPWO 配置安全保存、不回显、不自动启用，最新手机日志截图与重启 read 通过，本地 `3333` production 已启动。Python 全量测试 22 项 exit 0，仅有 2 条第三方 TestClient 弃用警告。

## ChatGPT API 原生统计与代理存储

原生 Provider 使用独立的 `chatgpt-api/chatgpt2api.db` SQLite 数据库，不把其账号或统计全表读入应用 PostgreSQL。统计沿用源项目的 `dashboard_metric_state`（投影检查点）、`dashboard_metric_hourly`（小时结果与切换汇总）和 `dashboard_metric_model_hourly`（模型成功量与耗时）三张表，按 24 小时、7 天、30 天窗口读取聚合结果。

`proxy_configuration` 保存加密后的默认出口、失败回退、代理组与节点配置；沿用源项目 repository 和引用约束，编辑已存在节点时不要求重新返回或输入代理密码。`proxy-selection` 的单一 `{enabled, mode, native_source}` 策略与 URL 同步状态属于同一 ChatGPT 代理设置契约，但 URL 同步不改变选择；不应在 Magic 关闭时隐式写回 native 默认值。备份恢复必须同时保留 Provider 数据目录与原加密密钥。

## MiniMax 音频

`dreamyo_minimax_voices` 保存用户创建的 MiniMax 或阿里云百炼音色本地映射（系统音色不落用户表）；`provider` 区分供应商，`user_id` 为空的记录仅供后台同步使用，前台个人音色查询必须按当前用户过滤。音色表同时保存供应商 `voice_name`、`description` 和 `provider_created_time`，分类由名称与介绍实时派生，不把分类规则固化成供应商字段。`dreamyo_minimax_music_records` 保存音乐生成的用户记录，`dreamyo_minimax_request_logs` 通过 `provider` 区分 MiniMax、阿里云百炼与腾讯云 TokenHub，并保存从提交、上游响应到完成/失败的请求过程日志。API Key 继续只存于系统模型渠道的加密字段，音色和音乐结果不在浏览器本地持久化。

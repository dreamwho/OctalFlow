# 数据库部署与私有迁移

业务表结构以 `web/src/lib/server/database/schema.ts` 为准，数据库访问由项目 PostgreSQL executor 统一应用 `dreamyo_` 前缀。

## 用户云存储容量账户（开发中）

`dreamyo_cloud_storage_settings` 保存新用户基础空间默认值，初始为 1 GiB。`dreamyo_cloud_storage_accounts` 在用户创建时由数据库触发器写入基础空间快照；修改默认值不会改变既有账户。`dreamyo_cloud_storage_grants` 保存有生效期的套餐权益，付费存储商品在订单中快照容量、叠加、手动续费和限购规则，支付成功后以订单 ID 唯一授予，退款时撤销；到期或撤销仅停止新增上传，不删除已存文件。同款商品可叠加时，购买数量增加同一有效期内的容量；不可叠加但可续费时，每单限一份，新权益从同款未撤销权益的最晚到期时间开始；不可续费时，只能存在一次未取消、未退款的有效购买。限购按该用户同款商品待支付、已支付及退款中订单的购买份数合计；此处不包含自动续订或自动扣款。`dreamyo_cloud_storage_reservations` 保存上传期间的容量预留，`dreamyo_cloud_storage_objects` 按用户和摘要登记实际 OSS 对象；`dreamyo_cloud_storage_object_refs` 保存每次上传形成的素材、项目、备份或作品引用。相同用户的同一文件可被多个引用共享，已用容量只计算一次实际对象，来源统计归到当前最早引用。容量事务按账户行加锁后计算已用、未过期预留及有效权益，同用户并发预留和删除须串行校验。

当前有账户、配额查询、预留核心及用户/管理员查询接口。`POST /api/cloud-storage/objects` 接受原始字节流和 `x-dreamyo-source`、`x-dreamyo-content-bytes`、`x-dreamyo-sha256`，预留后流式写入临时文件，验证摘要，上传到后台配置的 OSS，再读取 OSS 对象校验后登记用量；返回引用 ID 和 `downloadPath`。`GET /api/cloud-storage/objects/[objectId]` 按当前用户拥有的引用签发临时下载地址；`DELETE` 删除一个引用，最后一个引用删除时才移除 OSS 对象并释放容量。OSS 删除失败则数据库事务回滚，容量不释放。该链路通过模拟 OSS/数据库单元测试，存储商品也已接入订单和支付事务；PostgreSQL 实库、真实支付与 OSS 尚未联调，对账和桌面同步仍未接通，不能把这组表视为完整交付。

`GET /api/admin/cloud-storage/users/[userId]` 只允许具有用户管理或系统管理职责的管理员读取指定用户的服务端统计；用户管理弹窗展示已用、上传预留、可用空间、基础/赠送/套餐额度及素材/项目/备份/作品来源。统计按当前有效套餐权益和账户已登记对象实时计算，不采信前端上报的容量。

`dreamyo_cloud_storage_project_backups` 通过引用 ID 关联画布 ZIP 备份、用户、原项目 ID、标题与创建时间，删除最后一个引用时索引级联删除。画布项目卡的“备份到云端”沿用包含持久媒体的画布导出包；上传时除了通用容量/摘要头，还提交 `x-dreamyo-project-id` 和 URI 编码的 `x-dreamyo-project-title`。对象引用与备份索引在同一 PostgreSQL 事务写入。`GET /api/cloud-storage/backups` 按登录用户分页列出备份；`GET /api/cloud-storage/backups/[referenceId]` 按归属流式下载 ZIP；`DELETE` 删除备份引用。WEB 请求沿用 Cookie 身份；商用桌面版仅对云存储用量与备份路由使用有效设备访问令牌，Electron Main 保管令牌并代理用量读取、项目备份上传、列表、下载和删除，管理员本地版不能调用。备份弹窗显示服务端已用、总额及可用空间；恢复前校验字节数与 SHA-256，再导入为新项目，不覆盖原项目。当前仅有模拟数据库/OSS 和桌面 Main 传输测试；真实 PostgreSQL、OSS、大项目传输和双机恢复尚未验收。

## 商用桌面设备授权（开发中）

`dreamyo_desktop_device_requests` 以 SHA-256 摘要保存一次性设备凭据，并保存展示给用户核对的授权码、设备名称、待确认/已确认/已兑换状态和有效期。网页端只有当前登录的活跃云端用户可以确认；兑换须持有原始设备凭据且仅可成功一次。`dreamyo_desktop_device_sessions` 以摘要保存短时访问令牌与可轮换的刷新令牌，绑定云端用户和设备名称；刷新会替换两个摘要，退出登录记录撤销时间。原始令牌不写入数据库或请求日志。

桌面主进程只把刷新令牌经系统 `safeStorage` 加密后写入该版独立用户目录；Canvas 本地账号须先用云端访问令牌调用云端 `me` 接口确认，再建立独立的本地用户映射。当前尚未接入按执行位置区分的模型路由、云端扣费与同步，不能把设备授权视为商用桌面版已经交付。

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

## 用户角色与模型/积分策略

`app_settings.user_roles` 保存内置“普通用户”及管理员自定义的非管理员角色。角色策略包含积分消耗倍率、只记录不扣分开关，以及按模型能力分类、逻辑模型 ID 和显式排除模型组成的白名单；默认普通用户为全部模型、1:1 扣分。`users.role` 保存角色 ID，`admin` 继续使用独立的管理员职责权限。删除角色前，服务端检查是否仍有用户使用该角色；模型列表按当前用户角色过滤，模型代理与积分记账服务再次执行权限校验。只记录模式仍保留零扣分流水并受套餐次数限制。

`app_settings.model_picker_groups` 保存前端模型选择器的分类名称及顺序；逻辑模型的 `pickerGroup` 保存所属分类。公开会话只下发当前用户可用的逻辑模型与分类配置。

## 魔法代理

`dreamyo_magic_proxy_settings` 是单例配置表（`id = 'default'`）。订阅地址和节点明文以加密字段保存。GeminiAIStudio、GeminiTools、GPTAPI 与 Dola API 共用同一套魔法代理绑定，绑定模式为 `magic` 或 `chained`；Dola 同时通过相同的 Provider 入口支持通用代理引用。每个 Provider 都有独立 Mihomo 分组、监听端口和链式跳板组，启用一种来源时会自动关闭另外两种来源，不把代理密码或订阅明文返回浏览器。ChatGPT 自己的 native/magic 选择仍由 `/api/admin/chatgpt-api/proxy-selection` 维护，不能与本 Provider 绑定字段混用。

`dola_accounts` 保存 Dola Cookie 账号的脱敏业务状态；`cookie_ciphertext` 使用服务端密钥加密，`cookie_fingerprint` 只用于 HMAC 去重，列表接口不得返回任一敏感字段。`dola_api_keys`、`gemini_tools_api_keys`、`geminiai_api_keys`、`dola_gateway_settings` 分别保存各反代网关密钥与启用状态，其中 API Key 使用 `key_ciphertext` 进行 AES-256-GCM 服务端可逆加密存储，支持管理员后台实时可见与复制，同时保留 `key_hash` 供 API 鉴权快速比对；`dola_request_logs` 记录请求受理、代理路由、账号鉴权、Camoufox 上游、验证、媒体查询与失败阶段，并保存脱敏请求/响应摘要、任务/验证 ID、时长比例、状态码、耗时和生命周期；Cookie、API Key、Token、参考图和视频二进制不写入日志。`dola_attempts` 固定 `account_id + credential_version + proxy_reference` 与租约序列，服务重启后按同一 attempt 恢复，不通过重发掩盖未知提交结果。代理引用来自现有通用代理管理的 `node:<id>` 或 `group:<id>`，不在 Dola 表中保存区域专用 URL 或密码。Dola 请求日志已同时支持加密 JSON Provider 与 PostgreSQL repository，后台列表使用服务端筛选、分页、聚合和详情抽屉。

Mihomo 固定声明 GeminiAIStudio、GeminiTools、ChatGPTAPI 和 DolaAPI 四个独立 group/listener，并为四者分别声明链式跳板组。Dola 的魔法/链式请求通过专用 listener 传给 Camoufox Provider；Dola 的通用代理仍只持久化 `node:<id>` 或 `group:<id>` 引用，运行时短暂解析为代理 URL。Next.js 到本地 Python 服务的内部请求保持直连。

IPWO 源设置使用独立 Tab 与 `/integration/ipwo` 契约；来源开关通过共享选择的 `native_source` 在 native 内选择 `manual` 或 `ipwo`，关闭总开关不自动改选另一来源。`GET/PATCH /integration/ipwo` 读取/保存只返回脱敏配置，读取字段为 `configured`、`has_api_url`、`protocol`、`regions` 和 `timeout_seconds`，不返回加密 `api_url`；保存时可提交 `api_url`、`protocol`、`regions` 和 `timeout_seconds`，省略或清空 `api_url` 保留已存密文。`timeout_seconds` 接受任意正整数，默认 10，不设 10–30 上限。Fake-IP 兼容沿用现有 TUN 模型而非 DoH；仅已验证的 `ipwo.net` HTTPS 子域标准 443 可解析到 `198.18.0.0/15`，Curl 固定该结果且保持 `verify=True`，其他私有/保留 DNS 结果拒绝，IPWO 返回的代理 IP 仍须 public/global，且 `198.18/15` 不得用于返回的代理 endpoint。`POST /integration/ipwo/test` 是显式临时诊断，可在共享开关关闭时使用已存配置运行，按固定阶段检查配置、IPWO、代理出口和 `ipinfo.io/json`，错误保持可操作但不暴露 URL、查询参数、令牌、上游原文或异常；不自动调用、不启用共享代理策略，也不写入节点。正常请求仍受共享 `enabled`/`mode`/`native_source` 门控。真实 Next/Python 双进程 HTTP 已验收 IPWO 配置安全保存、不回显、不自动启用，最新手机日志截图与重启 read 通过，本地 `3333` production 已启动。Python 全量测试 22 项 exit 0，仅有 2 条第三方 TestClient 弃用警告。

## ChatGPT API 原生统计与代理存储

原生 Provider 使用独立的 `chatgpt-api/chatgpt2api.db` SQLite 数据库，不把其账号或统计全表读入应用 PostgreSQL。统计沿用源项目的 `dashboard_metric_state`（投影检查点）、`dashboard_metric_hourly`（小时结果与切换汇总）和 `dashboard_metric_model_hourly`（模型成功量与耗时）三张表，按 24 小时、7 天、30 天窗口读取聚合结果。

`proxy_configuration` 保存加密后的默认出口、失败回退、代理组与节点配置；沿用源项目 repository 和引用约束，编辑已存在节点时不要求重新返回或输入代理密码。`proxy-selection` 的单一 `{enabled, mode, native_source}` 策略与 URL 同步状态属于同一 ChatGPT 代理设置契约，但 URL 同步不改变选择；不应在 Magic 关闭时隐式写回 native 默认值。备份恢复必须同时保留 Provider 数据目录与原加密密钥。

## MiniMax 音频

`dreamyo_minimax_voices` 保存用户创建的 MiniMax 或阿里云百炼音色本地映射（系统音色不落用户表）；`provider` 区分供应商，`user_id` 为空的记录仅供后台同步使用，前台个人音色查询必须按当前用户过滤。音色表同时保存供应商 `voice_name`、`description` 和 `provider_created_time`，分类由名称与介绍实时派生，不把分类规则固化成供应商字段。`dreamyo_minimax_music_records` 保存音乐生成的用户记录，`dreamyo_minimax_request_logs` 通过 `provider` 区分 MiniMax、阿里云百炼与腾讯云 TokenHub，并保存从提交、上游响应到完成/失败的请求过程日志。API Key 继续只存于系统模型渠道的加密字段，音色和音乐结果不在浏览器本地持久化。

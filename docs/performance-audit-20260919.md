# dreamyo 全站性能审查报告（2026-09-19）

> **实施进度（2026-09-19 晚）**：A1 / A2 / A3-lite / B1 已全部实施并验证——lifecycle 已由 Worker 周期触发，generation-tasks.json 从 23.4MB（405 条，含 19.5MB 内联脏数据）清理至 1.8MB（305 条），解析耗时 66ms → 6.8ms；auth/任务读缓存与内联防御已上线。剩余 A3 完整分片与 C 阶段流式化见文末规划。

审查范围：`web/src`（Next.js Route Handler + 服务层 + 存储）、`web/scripts/generation-worker.mjs`、`.data`（文件 Provider 真实数据）。
方法：静态扫描（全表读取 / 热路径设置读取 / 大对象内联 / 循环 await / 索引比对）+ 本机实测（JSON 解析与序列化耗时基准）+ Worker 放大系数推算。

---

## 一、问题清单（按严重度排序）

### P0-1【文件 Provider】generation-tasks.json 全量读写放大（23MB × 每次任务状态推进）

**证据（实测）**：
- `.data/generation-tasks.json` 当前 23.4MB / 405 条任务；解析 66ms、序列化+写回 56ms（M 系列 SSD）。
- 单条 19.5MB 的已取消任务（2026-09-01 创建，9-08 过期，至今未清理），其 `payload.result.dataUrl` 内联 9.7MB 原始 base64（PNG edit 结果），且 `results[0].serverUrl` 为空 → 资产登记未命中，走了 `safeResults` 原始 base64 回退分支。

**放大链**：`withGenerationTaskFileMutation`（generation-task-store.ts:863）在**每次**任务 upsert、租约释放、状态推进、过期清理时执行「读 23MB → JSON.parse 66ms → 改一条 → JSON.stringify 56ms → 写 23MB」。Worker 每批 claim 最多 50 个任务，每个任务至少经历 created→submitting→submitted→polling(×N)→persisting→completed 6+ 次推进 → **一次批跑 = 300+ 次 23MB 全量读写 ≈ 36 秒纯 I/O+序列化**，且全部经 `fileMutationQueue` 串行化。这是文件 Provider 模式下任务多时「生成卡、Worker 批跑慢」的直接原因。

**风险**：随任务线性膨胀（当前 405 条 23MB，若 base64 内联未修，每月可增长数百 MB）；写放大损耗 SSD；串行队列让所有用户的任务互相阻塞。

### P0-2 生成结果把 9.7MB base64 内联进任务记录与 JSON 数据库

**证据**：上述 19.5MB 任务的 `result.dataUrl` 为 `data:image/png;base64,...`（9.77MB 字符）。链路：`completeImageResult`（image-task-runtime.ts:290）中 `writeImageGenerationLog` 返回的 `loggedAssets` 为空时回退 `safeResults`（原始 base64），随后 `result` 持久化进任务记录。同时 GeminiAI 上游直接返回 `b64_json`（10.6MB/张，见请求日志），若站内媒体登记失败即触发同一回退。

**影响**：任务文件/表被单条 10MB 级记录污染；列表查询把 payload 整行拉出；PostgreSQL 模式下同样存入 jsonb（TOAST 解压成本）；备份导出体积爆炸。

### P1-3【文件 Provider】auth.json 每请求全量读解析（无缓存）

**证据**：`getAuthSettings()`（store-settings-actions.ts:12）PostgreSQL 分支有 1 秒缓存 + 请求合并，但**文件分支直接 `readAuthDb()`** = 读 223KB + `normalizeDb`（含全部规范 化逻辑）。调用面 63 处，其中热路径包括 `/api/auth/session`、`/api/image-tasks`（创建+轮询）、agent runs、canvas 等。图片轮询每 2.5 秒一次 × 每次全量解析 auth.json。

**影响**：文件 Provider 下每次 API 调用多付 ~1-3ms CPU + 全量规范化；高并发轮询时解析线程堆积。属可控但应补齐与 PG 分支对等的缓存。

### P1-4【文件 Provider】生成日志追加 = 全量读 678KB + 全量写

**证据**：`withJsonDataFileLock(LOG_DATA_FILE…)`（generation-log-repository.ts:274-290）：每次生成完成/失败都「读全库→append→normalize→写全库」。当前 678KB 尚可（3ms），但 `create-workbench-overview-service.ts:68` 在**用户每次打开创作页**时 `readGenerationLogDb().logs.filter(userId)` 全量读 + JS 过滤——违反「禁止先读取完整数据库再在 Node 筛选」的项目规约（该规约目前只约束 PostgreSQL，文件实现同样越界）。

**影响**：日志随生成量线性增长后，每次轮询写日志与工作台首屏都会线性变慢。

### P1-5 图片结果多次 Base64↔Buffer 转换与 Sharp 重采样链

**证据**：上游 b64_json（10.6MB）→ atob/Buffer → normalizeSafeImageResult（Sharp 解码+目标尺寸重采样）→ 再 base64 内联进 result → 前端再解码。GeminiAI 10.6MB 结果在网关、任务、日志、前端至少 4 次全量物化。`MAX_INLINE_IMAGE_BYTES = 20MB` 允许超大内联直达内存。

**影响**：单请求峰值内存 40MB+；高并发 4 图任务时 Worker 单 lane 内存可达数百 MB；GC 压力与主线程阻塞。

### P2-6 心跳接口每 Worker 每 15 秒读一次全量设置

上一轮为下发 workerLanes 加入：heartbeat → `getAuthSettings()`。PG 模式有 1s 缓存可吸收；文件模式与 P1-3 叠加成 `lanes × 4次/分` 的全量解析。小问题但可顺手修。

### P2-7 `readPostgresGenerationLogDb` 无界全表扫描

`SELECT * FROM generation_logs ORDER BY created_at DESC`（repository.ts:296）——注释声明仅用于管理员备份，属允许用途；但无 LIMIT 保护，若被误用为列表将拉全表。建议加防御性断言或调用方审计。

### 已验证无问题项

- **PostgreSQL 索引**：`generation_tasks` 的 (user_id, task_type, status, updated_at)、recovery_due 部分索引、channel/upstream 唯一索引齐备，与租约/并发计数查询匹配；`generation_logs`、geminiai/dola 日志表均有 created_at/status/model 组合索引。
- **PG 并发限制**：`pg_advisory_xact_lock` + 活跃计数走索引，无锁放大。
- **设置短缓存**：PG 分支 1s TTL + in-flight 合并正确实现（admin 保存路径已按规约绕过）。
- **全量快照边界**：备份/恢复专用全表读均有事务执行器约束，符合规约。

---

## 二、分级优化方案

### 第一阶段（立即，修数据污染与放大根因）

**A1. 任务结果禁止内联原始 base64（修 P0-2）**
- `completeImageResult`：`loggedAssets` 为空时**不再回退 safeResults**，改为「重试资产登记一次；仍失败则把 base64 落临时文件并以 `file://tmp` 引用」，任务记录只存 `serverUrl/url + 尺寸 + bytes`。上传失败显式报错进入重试（`result_ready` 阶段本就只重试媒体保存），不允许把 10MB 塞进持久层。
- 写入前防御：`persistTaskRecord` 前校验序列化 payload > 512KB 即剥离内联 dataUrl（断言兜底）。
- 一次性清洗：启动时（或维护批）把存量任务 payload 中 >1MB 的 `result.dataUrl` 置空并标记 `media_lost`（文件 Provider 直接改；PostgreSQL 用 `payload = jsonb_set(...)` 定向更新，不全行重写）。

**A2. 过期任务立即清理（修 P0-1 的存量）**
- 该 19.5MB 任务已过期 11 天未清：查 data-lifecycle 维护批是否实际在跑（worker 只调 generation-tasks/run 与心跳，**没有任何组件调度 `/api/maintenance/data-lifecycle/run`**）。方案：generation-worker 新增 refund lane 同级的 lifecycle lane（默认每 5 分钟，失败退避），或在 run 批收尾时顺带触发一次 lifecycle（幂等、有界 batchSize）。
- 清理后再评估：405 条 - 过期条目后任务文件预计回到 <3MB。

**A3. 文件 Provider 任务存储改分片（修 P0-1 的增量）**
- `generation-tasks.json` 按 `task_type` 分片（`generation-tasks.image.json` 等）至少缩小 4-6 倍；更彻底：按用户哈希分桶 `tasks/{bucket}.json`，读写只锁目标桶，多用户并发不再全局串行。
- 同步把 `claimDue`/`countActive`/list 改为跨桶聚合（每桶内仍走现有 mutation 语义），保持 API 不变。
- 预期：单次状态推进的 I/O 从 23MB 降到 <1MB，Worker 批跑串行队列延迟下降一个数量级。

### 第二阶段（本周，热路径缓存与日志）

**B1. auth 文件分支补缓存（修 P1-3/P2-6）**
- 照抄 PG 分支模式：1s TTL + in-flight Promise 合并 + `setAuthSettings`/`resetClientSessionState` 时主动失效（版本号机制已有）。轮询风暴下解析次数从 `请求数` 降到 `1次/秒`。

**B2. 创作页概览去全量读（修 P1-4 用户侧）**
- `create-workbench-overview-service`：文件 Provider 增加「按 userId 过滤的轻量索引」（写日志时维护 `generation-logs.index.json`：userId→[logId, createdAt]），读取按索引定向拉详情，仍全量兜底仅限日志文件 <512KB 时。
- 日志追加路径：分片（按日期 `generation-logs.YYMM.json`），追加只读当日分片。

**B3. Worker 批内合并任务写（修 P0-1 运行时）**
- `runGenerationTaskRecoveryBatch` 文件分支：每批开始一次 `readFileTasks`，批内所有 lease/release 状态在内存聚合，批结束一次 `writeJsonDataFile`（失败回滚重读）。配合 A3 分片后单批 I/O 恒定。
- 注意保持现有「租约必须先落盘再执行」语义：claim 仍即时写，仅轮询状态推进合并。

### 第三阶段（中期，内存与大对象）

**C1. 结果管道流式化（修 P1-5）**
- GeminiAI/OpenAI `b64_json` 改「上游响应流 → 临时文件 → Sharp 文件流重采样 → 直接上传对象存储/本地媒体」，全链路不进 JS 字符串；`MAX_INLINE_IMAGE_BYTES` 降到 4MB 仅作小图快路径。
- Node heap 预期：单任务峰值 40MB+ → <8MB；4 并发 lane 稳定性显著提升。

**C2. 压测基线化**
- 用仓库内 Playwright + 本地 fixture 写一个 20 并发提交/轮询的负载脚本（不触真实上游，协议 fixture 已具备），回归 A3/B3 前后：任务推进 P95、批跑耗时、进程 RSS。把它加入发版前 Mandatory Testing 的可选档。

### 风险与顺序

- A1 涉及结果语义（资产登记失败时的用户可见行为），需按「上传失败进入 result_ready 重试」既有契约回归 e2e；A3/B3 动文件格式，需带一次性迁移（读旧文件→写分片→删旧），并按项目规约**不写旧格式兼容读**（发版一次性切换）。
- PostgreSQL 部署不受 A3/B3 影响（文件分支专用代码）；A1/C1 双Provider受益。

## 三、量化预期

| 指标 | 现状（实测/推算） | A 阶段后 | B+C 后 |
|---|---|---|---|
| 单次任务状态推进 I/O | 23MB 读+写（~120ms） | <1MB（~5ms） | 常驻内存级 |
| Worker 50 任务批纯 I/O | ~36s 串行 | <2s | <0.5s |
| 任务文件体积 | 23MB（含 19.5MB 脏数据） | <3MB | 稳态 <1MB/桶 |
| 图片单任务峰值内存 | 40MB+ | 40MB | <8MB |
| 文件模式 auth 读 | 每请求 223KB 解析 | 1次/秒 | — |

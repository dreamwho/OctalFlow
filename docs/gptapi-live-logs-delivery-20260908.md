# GPTAPI 请求日志监控

## 本次范围

- GPTAPI 请求日志支持查看详情，展示请求内容、时间、状态、阶段记录和已有的错误诊断字段。
- 生成请求在校验/排队阶段写入，进入执行、接收响应和结束时更新同一请求 ID；额度刷新也使用单条记录承载过程。
- 当前日志页自动刷新，运行中的详情自动跟随；详情关闭时中止读取，读取失败可重新连接，不重新提交任务。
- 终态不会被迟到的运行状态覆盖；运行中请求不计入成功/失败报表，完成后使用新的内部增量游标登记一次，不扫描重建历史统计。
- 不构建 Docker，不提交 Git，不调用真实上游模型或账号额度。

## 修改文件

- `services/chatgpt-api/services/log_service.py`：在执行前写入日志，累计阶段记录，处理失败和流关闭，保留同一请求身份与原始操作信息。
- `services/chatgpt-api/services/storage/call_record_repository.py`：事务更新活动记录，保护终态，并为结束记录发布新的内部统计游标。
- `services/chatgpt-api/services/call_record_service.py`：支持更新记录并对调用日志持久化内容脱敏。
- `services/chatgpt-api/services/call_view.py`：中文过程状态和运行中实时耗时投影。
- `services/chatgpt-api/services/dashboard_metrics_service.py`：未结束调用不参与完成统计。
- `services/chatgpt-api/api/ai.py`：请求校验阶段登记日志，补充校验/参考素材读取失败记录。
- `web/src/app/api/admin/chatgpt-api/[...path]/route.ts`：接通管理员只读详情接口，沿用权限和脱敏规则。
- `web/src/app/admin/chatgpt-api/components/admin-chatgpt-api-section.tsx`：日志列表自动更新，增加详情入口。
- `web/src/app/admin/chatgpt-api/components/chatgpt-log-detail.tsx`：响应式详情抽屉、运行状态跟随和连接错误恢复。
- `services/chatgpt-api/tests/test_live_call_logs.py`：隔离数据库测试提交可见、状态更新、失败、流取消与增量统计。
- `services/chatgpt-api/tests/test_runtime_contract.py`：额度刷新真实隔离接口回归改为断言单记录累计阶段。
- `web/src/app/api/admin/chatgpt-api/[...path]/route.test.ts`：详情路由授权、只读和脱敏回归。
- `web/e2e/chatgpt-api.spec.ts`：详情自动更新和桌面/390px/430px 抽屉边界回归。

## 验证状态

- Python 隔离接口与服务测试：44 项通过。
- Web 全量单元测试：2982 项通过，10 项沿用既有跳过。
- 生产构建、TypeScript 类型检查、ESLint、13 个修改源码文件 UTF-8 校验及 `git diff --check` 通过。
- Playwright 完整流程通过，覆盖运行中详情自动转为结束、列表自动更新、1440/390/430px、浅深主题、正常关闭后继续操作其他功能。已查看手机端浅色与深色详情截图。
- 本地已使用生产构建重启，3333 端口 Session 接口返回 200。

真实上游生成未测试；本次不宣称账号、代理或供应商线路已可用。进程被强制终止后的活动任务恢复不在本次实现范围。

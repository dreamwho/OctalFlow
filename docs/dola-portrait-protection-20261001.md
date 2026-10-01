# DOLA 肖像保护拒绝终态修复

## 行为

上游明确返回“出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频”时，归类为 `portrait_protection_failed`，沿用现有终态逻辑保存为失败并保留 `rawError` 原文，不再一直轮询或自动换账号、换渠道重提。

公开失败原因：**参考图中的人脸未通过肖像保护审核，请更换参考图或改用文生视频。**

Canvas 失败节点直接显示：**人脸未通过肖像保护审核**。完整说明保存在节点信息和生成日志中，刷新后继续显示失败。

识别适用于提交阶段的明确拒绝、最新助手回复、创建块失败及协议失败消息。用户提示词引用拒绝文案不作为失败证据；已有成功媒体优先，旧拒绝不能覆盖新的正常回复。

## 本轮修改文件

- `services/dola-api/src/dola_api/query.py`：为现有拒绝分类器增加肖像保护失败分类，复用现有提交、查询及持久化终态处理。
- `services/dola-api/tests/test_contracts.py`：覆盖真实拒绝原文、生成中创建块、用户引用、旧拒绝、成功媒体优先、协议错误及查询持久失败状态。
- `web/src/lib/dola-errors.ts`：统一肖像保护识别、公开文案及不自动换号的内容错误分类。
- `web/src/lib/dola-errors.test.ts`：验证文案映射、认证类字样不误触换号及正常审核信息不误判。
- `web/src/lib/server/video-task-runtime.ts`：将 DOLA 查询失败转换为明确公开原因，沿用失败日志、账号占用释放及退款逻辑。
- `web/src/lib/server/video-task-runtime.test.ts`：验证查询后终止任务、日志原因、释放及退款，且不再提交上游请求。
- `web/src/app/api/video-generation-tasks/video-generation-route.ts`：创建响应遇到肖像拒绝直接失败，不自动提交备用渠道。
- `web/src/app/api/video-generation-tasks/route.test.ts`：验证 HTTP 200 中的业务拒绝也能立即结束为失败并返回公开原因。
- `web/src/app/(user)/canvas/components/canvas-node-content.tsx`：在肖像保护失败节点中直接展示可读原因。
- `web/src/app/(user)/canvas/components/canvas-node.test.tsx`：覆盖浅色与深色失败节点文案，保留正常错误节点既有行为。
- `web/e2e/canvas.spec.ts`：覆盖生成中节点恢复、查询终止、原因落库及刷新恢复，并检查桌面、390px、430px 和浅深主题。
- `docs/dola-portrait-protection-20261001.md`：记录本次行为、文件清单和验证范围。

## 验证

针对用户提供的拒绝原文，修改前新增 Python 回归三项均失败（未返回 error 或错误类别）；修改后 DOLA 全量 126 项通过，保留两条既有 Camoufox geoip 建议警告。Web 创建、任务同步、错误分类三文件 67 项通过；Canvas 组件 40 项通过；本地 TCP 协议矩阵 159 项通过。

最终 Web 全量：703 文件通过、6 文件跳过；3524 项通过、12 项跳过。TypeScript、lint、生产构建及 `git diff --check` 通过。生产构建 ID：`CP-i3Y2QwY3xBMV2x-Q3f`，本地 3333 已重启并返回 HTTP 200。

当前生产构建 Playwright：12 项通过（38.8 秒），包含初始化 3 项、肖像失败节点回归、Canvas 编辑/连线/持久化、首尾帧与原图引用、文本/图片/视频 TCP 夹具流程及工作台参数/参考图行为。肖像回归读取失败原因的服务端保存结果，断言只查询一次、自动提交次数为零，浅深主题与 1440px/390px/430px 刷新后均无生成中状态。6 张截图及构建清单保存在 `docs/assets/dola-portrait-protection-20261001/`。

首轮新浏览器夹具漏填既有 `pollPath: "server"`，误走直接上游查询；根据实际网络记录修正测试任务身份后，以上 12 项重新运行全部通过，没有新增固定延时或重试。

全部测试使用固定隔离凭据与本地响应/协议夹具，没有再次调用真实 DOLA 生成或消耗额度；未执行全站所有页面回归或部署后真实上游复测。本地修改尚未提交、推送或部署到服务器。

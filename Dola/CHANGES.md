# 本次新增文件说明

以下为 2026-09-27 新建的独立项目与画布接口文件。`dist/`、`build/`、`node_modules/`、`.venv/`、浏览器运行时及测试缓存是本地产物，不计入源码。

| 文件 | 改动 |
| --- | --- |
| `Dola/IMPLEMENTATION_PLAN.md` | 记录可行性、浏览器方案、未知风险、阶段计划与交付门禁。 |
| `Dola/README.md` | 说明独立安装、启动、打包、API 与 MCP 接入。 |
| `Dola/VALIDATION.md` | 记录实际执行的测试、构建结果与尚未通过的真实环境验收。 |
| `Dola/CHANGES.md` | 列出本次新增源码与用途。 |
| `Dola/pnpm-workspace.yaml` | 定义独立桌面与 MCP 工作区。 |
| `Dola/pnpm-lock.yaml` | 锁定独立 JavaScript 依赖版本。 |
| `Dola/provider/.gitignore` | 忽略 Python 环境和测试缓存。 |
| `Dola/provider/pyproject.toml` | 定义可独立安装、测试和冻结的 Dola Provider。 |
| `Dola/provider/uv.lock` | 锁定独立 Python 依赖版本。 |
| `Dola/provider/src/dola_api/__init__.py` | 提供独立 Provider 包入口。 |
| `Dola/provider/src/dola_api/app.py` | 复刻现有 Dola 协议服务 HTTP 路由与启动逻辑。 |
| `Dola/provider/src/dola_api/contracts.py` | 复刻请求、任务与模型参数契约。 |
| `Dola/provider/src/dola_api/page_scripts.py` | 复刻浏览器页面脚本与提交调用。 |
| `Dola/provider/src/dola_api/protocol.py` | 复刻 Dola 签名提交及协议适配。 |
| `Dola/provider/src/dola_api/query.py` | 复刻任务和结果查询逻辑。 |
| `Dola/provider/src/dola_api/session.py` | 复刻账号、Cookie、代理与有头浏览器会话管理。 |
| `Dola/provider/src/dola_api/sse.py` | 复刻上游事件流解析。 |
| `Dola/provider/src/dola_api/task_store.py` | 复刻本地任务状态持久化。 |
| `Dola/provider/src/dola_api/uploads.py` | 复刻参考素材上传逻辑。 |
| `Dola/provider/tests/test_contracts.py` | 复刻模型与请求契约回归。 |
| `Dola/provider/tests/test_google_remote_login.py` | 复刻 Google 登录路径的服务测试。 |
| `Dola/provider/tests/test_headed_account.py` | 复刻有头账号会话测试。 |
| `Dola/provider/tests/test_session_login.py` | 复刻登录状态与 Cookie 测试。 |
| `Dola/provider/tests/test_task_store.py` | 复刻任务存储与恢复测试。 |
| `Dola/provider/tests/test_uploads.py` | 复刻素材上传测试。 |
| `Dola/desktop/.gitignore` | 排除桌面安装包、冻结运行时及依赖目录。 |
| `Dola/desktop/electron-builder.yml` | 定义 macOS 和 Windows 的桌面打包配置。 |
| `Dola/desktop/package.json` | 定义桌面构建、测试、运行及打包脚本，并将提示词素材引用模块纳入语法检查。 |
| `Dola/desktop/resources/dreamyo-mark.png` | 提供桌面界面品牌图形。 |
| `Dola/desktop/resources/dreamyo.icns` | 提供 macOS 应用图标。 |
| `Dola/desktop/resources/dreamyo.ico` | 提供 Windows 应用图标。 |
| `Dola/desktop/scripts/freeze-provider.mjs` | 冻结当前平台独立 Provider 可执行文件。 |
| `Dola/desktop/scripts/provider-entry.py` | 提供 Provider 冻结启动入口。 |
| `Dola/desktop/scripts/stage-sidecars.mjs` | 将 Provider、Camoufox 和 Mihomo 暂存到桌面包。 |
| `Dola/desktop/src/index.html` | 调整账号、创作和设置界面，加入全局等待弹层与画布式引用标记层，并增加账号分组弹窗、代理标签页及 YAML/TXT 文件导入入口。 |
| `Dola/desktop/src/main.mjs` | 加入自动登录态保存、TXT 导入、任务会话导航、网页加载通知、代理测试、下载目录与无水印取回；订阅文件通过本机选择器安全读取，网页悬浮按钮缩小并调为半透明。 |
| `Dola/desktop/src/preload.cjs` | 限制渲染页可调用的桌面 IPC。 |
| `Dola/desktop/src/proxy-runtime.mjs` | 增加四段通用代理与 Base64/URI 魔法订阅解析、请求路径回退，并识别订阅服务的限时开启提示。 |
| `Dola/desktop/src/proxy-runtime.test.mjs` | 验证代理导入、四段格式、Base64 订阅、链式配置、网络回退和限时订阅提示。 |
| `Dola/desktop/src/subscription-uri.mjs` | 从当前 Web 项目的魔法代理服务提取节点 URI 解析器。 |
| `Dola/desktop/src/watermark.mjs` | 从当前 Web 项目提取 Dola 无水印 VOD 地址解析器。 |
| `Dola/desktop/src/watermark.test.mjs` | 验证无水印查询参数与视频地址解析。 |
| `Dola/desktop/src/prompt-references.mjs` | 提取图片编号、粘贴标记识别、引用插入与点击更换、整段删除规则。 |
| `Dola/desktop/src/prompt-references.test.mjs` | 验证本轮素材编号、粘贴引用、光标插入与引用删除。 |
| `Dola/desktop/src/renderer.js` | 复刻画布图片引用能力，统一等待状态，并实现账号分组弹窗、代理标签页、节点编辑及文件导入交互。 |
| `Dola/desktop/src/store.mjs` | 持久化账号分组、默认账号命名和下载设置，避免相同 Cookie 重复写入。 |
| `Dola/desktop/src/store.test.mjs` | 验证 Cookie、密钥、默认账号名、分组与状态持久化。 |
| `Dola/desktop/src/style.css` | 调整素材与提示词样式，增加浅深色等待动画、账号弹层、代理标签及文件导入布局。 |
| `Dola/docs/screenshots/dark-workspace.png` | 记录深色工作台的实际启动画面。 |
| `Dola/docs/screenshots/light-workspace.png` | 记录浅色工作台的实际启动画面。 |
| `Dola/docs/screenshots/dark-proxy.png` | 记录代理管理页的实际启动画面。 |
| `Dola/canvas-mcp/package.json` | 定义供 zcode 使用的独立 MCP 服务依赖与脚本。 |
| `Dola/canvas-mcp/client.mjs` | 将 MCP 调用转换为受 Bearer 鉴权的画布 HTTP 请求。 |
| `Dola/canvas-mcp/client.test.mjs` | 验证鉴权头与请求身份复用。 |
| `Dola/canvas-mcp/server.mjs` | 暴露创建画布、查询任务和查询项目三个 MCP 工具。 |
| `web/src/lib/server/canvas-external-auth.ts` | 为画布外部 API 增加定时安全比较的 Bearer 鉴权。 |
| `web/src/lib/server/canvas-external-auth.test.ts` | 验证密钥缺失、错误及正确时的鉴权行为。 |
| `web/src/app/api/external/canvas/route.ts` | 增加外部画布 Run 创建、查询与节点操作落盘入口。 |

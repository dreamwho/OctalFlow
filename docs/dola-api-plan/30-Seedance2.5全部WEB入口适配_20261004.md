# Seedance 2.5 全部 WEB 入口适配（2026-10-04）

目标：DOLA Seedance 2.5 的音频和视频参考贯通 Web 选择、上传、提交、持久化与重新生成。真实生成仍未授权，本轮生成验证全部使用隔离本地 TCP fixture 和固定测试账号。

| 入口 | 处理 |
| --- | --- |
| `/create?mode=video` 与视频工作台旧路由 | 本机选择、粘贴、拖拽及分类型素材库查询支持 image/video/audio；发送前只保留 File/object URL；发送后按类型保存媒体、完整提交并登记快照，刷新后重新生成复用原 URL/storageKey |
| 图片工作台 | 保持图片引用；携带音视频后切换到不支持模型时明确阻止提交，不静默丢弃 |
| Canvas 配置节点/视频节点 | 原混合引用提交、输出快照及失败重试链路保留；首尾帧仍仅使用图片 |
| Canvas Agent | 文件筛选、附件类型、预览、音频节点创建与下载均接通；规划/执行已有三类媒体引用契约复用 |
| 统一 Agent 服务 | 原显式素材 ID、任务 references、下游视频任务三类型传递已有实现，补充混合素材自动回归；当前 `/create` 页面实际由图片/视频工作台承接 |
| 短剧 | 每个镜头增加音视频上传、来源素材/素材库选择、移除；项目保存恢复及镜头重试保留引用；三种生成模式均向视频任务传入参考 |
| 管理后台 DOLA 测试 | 沿用上一轮三类型上传和请求类型验证，复查桌面及窄屏 |
| 模型配置/逻辑别名 | 2.5 固定支持音视频，Fast 固定不支持；公开配置优先管理员指定的默认模型，修复列表首项覆盖默认模型的错误 |

## 修改文件

- `web/src/app/(user)/image/image-video-workbench.tsx`：增加类型化草稿、预览、素材库查询、上传与完整生成快照/重用。
- `web/src/app/(user)/image/image-video-workbench-references.ts`：素材转换、独立类型编号和历史引用恢复。
- `web/src/app/(user)/canvas/utils/canvas-dola.ts`：暴露 2.5 音视频参考能力。
- `web/src/app/(user)/canvas/components/canvas-agent-attachment-files.ts`：音频筛选。
- `web/src/app/(user)/canvas/components/use-canvas-agent-attachments.ts`：音频附件类型与草稿处理。
- `web/src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx`：音频上传 accept 与附件预览/消息类型。
- `web/src/app/(user)/canvas/[id]/use-canvas-media-session-actions.tsx`：Agent 上传音频时创建并引用真实音频节点。
- `web/src/components/agent/agent-media-download.ts`：音频附件下载格式。
- `web/src/app/(user)/drama/[id]/drama-shot-media-references.tsx`：镜头上传、选择、移除音视频引用。
- `web/src/app/(user)/drama/[id]/drama-storyboard-shot-card.tsx`：挂载镜头参考编辑。
- `web/src/app/(user)/drama/[id]/drama-shot-generation-utils.ts`：拆分音视频引用。
- `web/src/app/(user)/drama/[id]/drama-generation-readiness.ts`：音视频可满足普通参考模式的素材要求。
- `web/src/app/(user)/drama/[id]/page.tsx`：传入真实音视频数组。
- `web/src/lib/drama-project-contract.ts`：镜头参考字段。
- `web/src/lib/server/drama-project-service.ts`：保存镜头引用。
- `web/src/lib/model-routing-config.ts`：逻辑别名遵循 DOLA 固定能力。
- `web/src/lib/auth/session.ts`：公开默认模型优先级。
- `web/e2e/dola-admin.spec.ts`：全部 Web 入口的提交、刷新、媒体复用、桌面/390/430 回归。
- `web/src/app/(user)/image/image-video-workbench-references.test.ts`：混合快照、原文件身份与类型编号测试。
- `web/src/app/(user)/canvas/components/canvas-agent-attachment-files.test.ts`：音频与视频筛选测试。
- `web/src/app/(user)/canvas/components/canvas-agent-chat-ui.test.tsx`：三类媒体 accept 契约。
- `web/src/app/(user)/canvas/components/canvas-assistant-elements.test.ts`：同步 Agent 上传类型断言。
- `web/src/app/(user)/drama/[id]/drama-shot-generation-utils.test.ts`：音视频实际请求转换测试。
- `web/src/lib/server/drama-project-service.test.ts`：项目镜头引用持久化测试。
- `web/src/lib/model-routing-config.test.ts`：逻辑别名 2.5/Fast 能力隔离测试。
- `web/src/lib/auth/session.test.ts`：默认模型优先级测试。
- `web/src/lib/server/agent-run-execution-direct.test.ts`：统一 Agent 显式音视频引用测试。
- `web/e2e/image-video-workbench.spec.ts`：同步参考素材入口测试文案。
- `CHANGELOG.md`、`docs/backend-database.md`、`docs/content/docs/progress/pending-test.mdx`、`todo.mdx`：同步能力与待验收状态。

## 验证与交付

Web 全量 3568 项通过、14 项环境依赖跳过（`--no-file-parallelism`）；专项类型、服务、逻辑模型、公开配置和 Agent 测试通过。生产构建、类型检查、ESLint 通过。并行全量运行中部署脚本测试达到既有 5 秒超时，单独复查和串行全量均通过，没有提高超时或改动实现。

浏览器专项已验证本地草稿发送前零上传、真实混合类型提交、刷新/重新生成不重复上传、音频素材库选择/移除、Canvas Agent 音频节点、短剧镜头保存刷新与提交，并记录 1440/390/430 截图。测试旧文案/严格定位断言已按当前 UI 更新。最终浏览器回归 15 项通过（含 3 项初始化），涵盖 Canvas 编辑/连线/保存/首尾帧、文本/图片/视频/音频 API、后台两类型测试与混合 Canvas 任务、全部新 Web 入口、图片工作台主题/参数/素材交互与窄屏视频入口。截图保存于 `docs/dola-api-plan/evidence/20261004-all-web/`。

源码与文档 84 个文本文件严格 UTF-8 解码通过，仅 AGENTS.md 的检查规则本身含有乱码示例标记，应用代码没有这些标记。

用户授权仅上传测试，本轮没有向真实 Dola 提交生成；此前真实合成 MP4/MP3 上传成功不等于实际生成效果。192.168.100.223 尚未更新，必须上传并运行新 Docker 离线包后验收。


离线 Docker 包：`本次修改需上传文件_20261004`，6 个 linux/amd64 镜像、约 3.3GB；主应用镜像 ID `sha256:799b54e00cedd5c6c95ef38a3738d67b1db86b23b67787ae4cdc7cfa32b15912`。容器内生产前端含三类媒体 accept 与短剧音视频参考编辑器。包内不含真实账号、数据库或本机 .env。包内 63 个文件 SHA256 全量校验通过；全部部署文本严格 UTF-8 解码与乱码标记检查通过。

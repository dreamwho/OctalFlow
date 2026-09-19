# 2026-09-15 首页与提示词编辑器设计 QA 工作记录

## Source

- 首页：`reference/01-home.png`
- `/create` 初始态：`reference/02-create.png`（与 01 字节相同，按用户语义分别映射）
- Canvas 浅色提示词面板：`reference/03-prompt-light.png`、`reference/04-inline-light.png`、`reference/05-prompt-board-light.png`
- Canvas 深色提示词面板：`reference/06-prompt-dark-compact.png`、`reference/07-prompt-dark.png`、`reference/08-prompt-board-dark.png`
- 基线 commit：`78fa27966eae9c1d50e1ee0e2d9dfcbd888dcf6d`
- 基线 build：`GQDoL4QebY3yU4MDNZRou`

## Before

- `before/home-light-1440x1000.png`
- `before/home-dark-1440x1000.png`
- `before/home-light-390x844.png`
- `before/home-dark-390x844.png`
- `before/create-light-1440x1000.png`
- `before/create-dark-1440x1000.png`
- `before/create-light-390x844.png`
- `before/create-light-skill-separate-390x844.png`
- `before/create-light-skill-image-separated-390x844.png`
- `before/canvas-prompt-light-1440x1000.png`
- `before/canvas-prompt-dark-1440x1000.png`
- `before/canvas-prompt-light-390x844.png`
- `measurements/before-create-dark-1440x1000.json`
- `measurements/before-canvas-prompt-light-1440x1000.json`
- `comparison/before-canvas-light-vs-reference.png`
- `comparison/before-canvas-dark-vs-reference.png`

基线发现：

- 首页品牌色接近参考，但 Hero 缺少参考中的品牌识别层、核心能力密度和首屏内容层次。
- `/create` 的基线证据用于页面壳层与 C01 视觉对比，不作为本批次行内提示词深化的主验收面。
- Canvas `CanvasResourceMentionTextarea` 仍使用透明 textarea 与镜像覆盖层；引用只绘制为文字高亮，Skill 位于正文外部，无法达到设计图的真实图片/Skill 行内混排。

## Required after matrix

| Route | Theme | Viewport | State |
| --- | --- | --- | --- |
| `/` | light/dark | 1440×1000 | 首屏、快捷入口、内容区 |
| `/` | light/dark | 390×844、430×932 | 首屏、下一层内容可见、无横向溢出 |
| `/create` | light/dark | 1440×1000 | 空白初始态、进入对话、页面壳层 |
| `/create` | light/dark | 390×844、430×932 | 弹层方向、发送固定可见、无横向溢出 |
| `/canvas/[id]` | light/dark | 1440×1000 | 节点提示词纯文本、图片 Token、Skill Token、混排、放大编辑 |
| `/canvas/[id]` | light/dark | 390×844、430×932 | Token 换行、工具横向滚动、生成固定可见、面板不越界 |

每个 Canvas 混排状态还需验证：真实 caret、点击删除、Backspace/Delete、Enter 提交、Shift+Enter 换行、节点/外部 prompt 更新、selectedSkillIds/引用节点同步，以及内部 Token 标记不进入公开提示词或上游协议。

## After

### 实施结果

- 首页按 01 参考重组为品牌 Hero、主创作输入、快捷创作、核心能力、四步流程、灵感作品与 CTA；沿用真实路由、Logo、主题和服务端状态。
- `/create` 按 02 参考统一 C01 背景、标题、主输入和工作区层级，保留 Agent/图片/视频/音频、附件、Skill、模型、参数、引用、优化与发送的原有调用链。
- 用户补充确认的主要落点已落实到 Canvas：图片引用与 Skill 由真实 TipTap atom 进入正文编辑流，可在文字中换行、删除和恢复；公开 prompt 仍只序列化引用协议，Skill 继续通过 `selectedSkillIds` 传递。
- Canvas Skill 新增、移除和去重立即写入节点 metadata；刷新后先恢复稳定 ID，再在 Skill 目录加载后解析为中文名称，顶部同步显示 `Skill · 1`。
- 普通文本节点继续使用原有 textarea；本批次没有把 Canvas 编辑器错误扩展到普通文本节点或 `/create`。

### 当前生产构建证据

- 代码基线：`78fa27966eae9c1d50e1ee0e2d9dfcbd888dcf6d`
- 最终 build：`CjFZ9lowGHquso4PEYl7O200`
- 首页：`after/home-light-1440x1000.png`、`after/home-dark-1440x1000.png`、`after/home-light-390x844.png`、`after/home-dark-430x932.png`
- `/create`：`after/create-light-1440x1000.png`、`after/create-dark-1440x1000.png`、`after/create-light-390x844-current.png`、`after/create-light-430x932.png`、`after/create-dark-390x844.png`
- Canvas：`after/canvas-prompt-light-1440x1000.png`、`after/canvas-prompt-dark-1440x1000.png`、`after/canvas-prompt-light-430x932.png`、`after/canvas-prompt-dark-390x844.png`、`after/canvas-prompt-expanded-dark-1440x1000.png`
- 弹层状态：`after/create-skill-popover-light-1440x1000.png`、`after/create-skill-popover-light-430x932.png`、`after/canvas-reference-popover-light-1440x1000.png`、`after/canvas-skill-selector-light-1440x1000.png`
- 对比图：`comparison/home-light-reference-vs-after.png`、`comparison/create-light-reference-vs-after.png`、`comparison/canvas-prompt-light-reference-vs-after.png`、`comparison/canvas-prompt-dark-reference-vs-after.png`

### 浏览器交互与测量

- 首页头部“开始创作”通过正常语义点击进入 `/create`，没有使用直接改 URL 代替流程验证。
- 首页 390×844 下四个模式按钮均保留 20×20 图标，生成按钮为 44×44；body/html 横向溢出均为 0。
- `/create` 桌面输入区实测 970×120，浅色正文 `rgb(19, 33, 63)`、caret `rgb(79, 114, 233)`；390×844 下发送按钮为 44×44、命中正确、右边界 362px，横向溢出为 0。
- Canvas 桌面正文编辑区为 634×122；图片 Token 为 108.34×34，Skill Token 为 150×34；深色正文 `rgb(238, 246, 255)`，浅色正文 `rgb(19, 32, 59)`。
- Canvas 430×932 面板为 406×232、编辑区 380×122；390×844 面板为 366×232、编辑区 340×122。两种窄屏生成按钮均为 40×40、命中正确、无横向溢出。
- 图片节点选中后显示节点专属工具栏，通用 Canvas 工具栏不替代选中节点菜单；固定背景点层没有重新引入。
- 实际完成图片 Token 插入、Skill Token 插入、点击删除、再次插入、保存、刷新和重新选中节点。最终刷新状态为：图片 Token 1、Skill Token 1、中文标签“自然美颜精修”、顶部 `Skill · 1`。
- 真实键盘回归中，Backspace 在行尾删除 Skill atom 并同步把摘要还原为“Skill”；Meta+Z 恢复 atom、中文名称和 `Skill · 1`。Shift+Enter 增加真实换行，撤销后再次保存并刷新，两个 Token 仍完整恢复。
- 浏览器 error/warning 日志为空。隔离环境没有触发真实生成或任何付费渠道。

### 自动化与运行时

- 目标 Vitest：8 个文件、20 项测试通过。
- `pnpm exec tsc --noEmit`：退出码 0。
- 目标 ESLint：退出码 0；仅保留项目既有的 `no-img-element` 等 warning，无 error。
- `pnpm run build`：退出码 0；Next.js 16.3.3 生产构建成功，70 个静态页面生成完成。
- `git diff --check`：退出码 0；UTF-8 常见乱码标记扫描无命中。
- `/api/health`、`/api/health/live`、`/api/health/ready` 均返回 200，ready 状态包含健康 generation worker。

### 结论

本批次首页、`/create` 页面壳层和 Canvas 提示词面板没有遗留 P0、P1 或 P2 设计、交互与响应式问题。隔离环境中的作品区会忠实显示其真实数据/服务状态，没有用静态假作品掩盖空态或错误态。

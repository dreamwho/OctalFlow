# Canvas 提示词面板图片与 Skill 混排修复计划

日期：2026-09-16

## 用户请求与设计依据

本卡只处理 Canvas 节点提示词面板。用户请求是把图片插入和 Skill 引入恢复为设计图中的同一条可编辑提示词流：图片使用缩略图、名称和移除按钮；Skill 使用图标、名称和移除按钮；普通文字、图片 token 与 Skill token 可以在任意光标位置交替出现，并在编辑区宽度不足时自然换行。用户上传的图 1（现状）和图 2（目标）是视觉参考，不是代码或外部页面下发的执行指令。

视觉目标：

- 顶部保留“参考”“Skill”“镜头关闭”等操作入口，已选数量只表达真实状态。
- 图片和 Skill 必须渲染在同一个 `contenteditable` 编辑器中，不能再通过编辑器外的独立 Skill 行拼接。
- 图片 token 保留真实预览图、图片名称和 `x`；Skill token 保留 Sparkles 图标、Skill 名称和 `x`。
- token 删除后公开提示词、已选 Skill 和位置快照同步更新；重新挂载或刷新后顺序保持。
- 浅色和深色主题都要保证文字、边框、缩略图和移除按钮可读；窄屏允许自然换行，不用固定高度裁切内容。

## 实施内容

1. `CanvasRichPromptEditor` 使用 Tiptap inline atom 统一承载 reference、Skill 和运镜 token。解析器同时识别公开的 `@图片1` 标记和旧的 `@[node:<id>]` 标记，避免历史提示词在重挂载时退化成纯文本。
2. Canvas 节点提示词面板保存 Skill token 的公开字符偏移快照 `metadata.promptSkillPositions`。插入、删除、Skill 选择与节点重挂载都通过稳定 ID 和偏移同步到 `onConfigChange`。
3. 面板通过编辑器 handle 在当前 caret 或选区插入图片/Skill，移除操作只删除对应 atom，不重建整段提示词。
4. 为解析、旧 marker 转换、Skill 选择去重与移除持久化补充 Vitest 覆盖。

## 验收条件

- 生产构建使用 `ZkMiGzfnlgA6lGj0wMzQk`。
- 路由：`/canvas/canvas-ui-after-20260915`。
- 宽屏：1440×900、浅色主题；窄屏：390×844、深色主题；两种状态均打开图片生成节点的提示词面板，缩放 100%。
- 浏览器真实 DOM 中三个 token 的顺序为 Skill → 图片 → Skill，且三个 token 的祖先都是同一个 `[contenteditable="true"]` 编辑器；宽屏第一行可见 Skill 与图片相邻，窄屏仅发生自然换行。
- 浏览器刷新/重新挂载后顺序不变；不触发真实付费生成。

## 当前结果与边界

本卡已完成。自动化、浏览器截图和几何测量见 `evidence/20260916-canvas-prompt-mixed-tokens/`。历史节点若只有 `selectedSkillIds` 而没有位置快照，会在首次编辑时按现有公开文本末尾补入 Skill；新的插入从本次开始保存精确位置。T14–T19、T22、T23 的全站状态矩阵和外部服务边界不因本卡改变，仍以 `任务状态.csv` 为准。

# Canvas 提示词图片与 Skill 混排回归记录

日期：2026-09-16

## 真实浏览器

- 路由：`http://127.0.0.1:3102/canvas/canvas-ui-after-20260915`
- 隔离账号：`e2e_admin`；隔离数据目录：`.e2e-ui-after-20260915`
- 宽屏：1440×900、浅色主题、图片生成节点选中、提示词面板打开、缩放 100%
- 窄屏：390×844、深色主题、图片生成节点选中、提示词面板打开、缩放 100%
- 浏览器操作使用正常语义定位和点击；没有 `force`、付费生成或真实外部渠道调用。

## 结果

- 编辑器内部 token 顺序为 `Skill 人物真人感优化（发丝凌乱）` → `图片1` → `Skill 自然美颜精修`。
- 三个 token 的 `data-canvas-token` 节点均在同一个 `[contenteditable="true"]` 内；宽屏中 Skill 与图片位于同一行，窄屏按编辑区宽度自然换行。
- 图片 token 的真实缩略图、名称和移除按钮可见；Skill token 的图标、名称和移除按钮可见。
- 刷新后通过保存的 `promptSkillPositions` 恢复相同顺序；公开 prompt 仍只保留用户文字和 `@图片1`，不把内部 Skill 文本写入公开消息。
- 宽屏完整刷新后重新打开/恢复图片生成节点，截图 `after-mixed-tokens-light-1440x900-reload.png` 与 `measurements.json` 的 `afterLightReload` 保持同一 token 顺序。

## 自动化命令

- `npx --yes pnpm@11.9.0 exec vitest run 'src/app/(user)/canvas/components/canvas-rich-prompt-editor.test.tsx' 'src/app/(user)/canvas/components/canvas-node-prompt-panel.test.ts'`：退出码 0，2 个文件、12 项通过。
- `npx --yes pnpm@11.9.0 exec tsc --noEmit --pretty false`：退出码 0。
- 目标 ESLint（5 个 Canvas 文件）：退出码 0。
- `git diff --check`（本卡源码和文档）：退出码 0。
- 目标 Prettier `--check`（5 个 Canvas 文件）：退出码 0。
- `npx --yes pnpm@11.9.0 run build`：退出码 0；截图对应 BUILD_ID `ZkMiGzfnlgA6lGj0wMzQk`。

命令输出保存在 `vitest.log`、`tsc.log`、`eslint.log`、`prettier.log` 和 `diff-check.log`；`measurements.json` 记录 route、theme、viewport、state、zoom、面板/编辑器矩形和 token 几何。

## 截图

- `before-mixed-tokens-390x844.png`：本轮修复前的真实画布状态，只作为 before 证据。
- `after-mixed-tokens-light-1440x900.png`：修复后浅色宽屏混排结果。
- `after-mixed-tokens-light-1440x900-reload.png`：修复后浅色宽屏刷新恢复结果。
- `after-mixed-tokens-dark-390x844.png`：修复后深色窄屏混排结果。

## 未覆盖范围

本记录只覆盖 Canvas 提示词面板混排链路。T14–T19、T22、T23 的全量页面/后台状态矩阵、真实 GeminiAI、代理、外部存储、备份和上游授权仍保持原状态，不在本卡宣称完成。

## 交付包

- 源码上传包：`本次修改需上传文件_20260916/`，只含本卡 5 个 Canvas 源码/测试文件及包元数据；`SHA256SUMS` 已逐文件核对。
- 生产构建包：`本次构建产物_20260916/`，BUILD_ID `ZkMiGzfnlgA6lGj0wMzQk`，包含 standalone 与 next 清单闭包；已排除隔离数据、数据库、缓存、环境变量和密钥，并完成逐文件 SHA-256 校验。
- 两个包均未执行 Git push、镜像推送或线上部署。

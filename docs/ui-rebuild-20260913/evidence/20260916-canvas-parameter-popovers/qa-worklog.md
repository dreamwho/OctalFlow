# Canvas 模型参数弹出层 QA 工作记录

- 2026-09-16：冻结六张参考设计，记录 SHA256。
- 2026-09-16：确认现有图片/视频使用 `CreativeGenerationPreferences`，音频使用 `CanvasSettingsPopoverShell + AudioSettingsPanel`；真实配置写回位于 `canvas-node-prompt-panel.tsx`。
- 2026-09-16：390×844 浅色图片弹层修改前基线已保存，当前缺少标题、说明和底部应用区。
- 2026-09-16：Luna Max 完成 Canvas 专用图片、视频和音频参数弹层主体实现；保留既有配置写回、模型能力和视频引用契约。
- 2026-09-16：浅色音频“自适应”情感选中态对比不足，已改为明确的主题选中面；音频说明调整为只承诺当前模型支持的字段。
- 2026-09-16：430/390 视口发现图片和视频弹层根边框贴左侧，已移动完整 Popover 容器并复测边框、阴影和点击区域。
- 2026-09-16：真实生产浏览器完成图片、视频、音频浅深主题与 1440×900、430×932、390×844 检查；视频内部滚动 342px 后标题和应用区仍保持可见。
- 2026-09-16：图片与视频自定义尺寸、视频普通/首帧/首尾帧切换和“应用”关闭均通过；未点击生成，`paidGenerationInvoked=false`。
- 2026-09-16：最终 BUILD_ID `dK6POYeiax5lYEoGNtr-j`；目标 Vitest 8/8、TypeScript、目标 ESLint、差异检查、生产 build 和三个健康端点均通过，浏览器 warning/error 日志为空。

final result: passed

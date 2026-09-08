# GPTAPI 模型接入修复交付

## 根因与修复

通用模型渠道同步入口此前要求非空 Base URL，通用 `/api/admin/models` 也没有 GPTAPI 托管目录分支。即使协议已注册，从模型渠道向导接入仍会被地址与密钥校验阻止。另在实测时，GPTAPI 专页没有保存任何已选模型，因此没有可供逻辑模型绑定的持久化渠道。

现已增加受管理员权限保护的托管目录分支，只读取服务端既有运行时，不接受用户指定内部地址或密钥。模型能力和请求配置沿用协议注册表。通用单渠道及全部同步允许 GPTAPI 无 Base URL 请求，向导显示托管配置说明。

用户可见“ChatGPT API”改为“GPTAPI”；内部 `chatgpt-api` 协议 ID、URL、配置字段保持不变。专页按钮改为“同步至渠道与逻辑模型”，显示已选数量和未同步说明。

## 实际验收

- 使用当前管理员会话保存 `gpt-5`、`gpt-image-2` 两个模型，生成已启用 GPTAPI 渠道。
- 逻辑模型新增 `gpt-5`（文本）、`gpt-image-2-2`（图片），都绑定 GPTAPI。原 `gpt-image-2` 已被其他渠道使用，因此新图片逻辑 ID 自动避让。
- 后台刷新后 GPTAPI 渠道仍保留。原默认文本、图片、视频模型未改变。
- 通用“同步 GPTAPI 模型”实测成功读取 9 个模型。测试得到的扩展目录未再次保存，刷新后恢复上述两个已保存模型。
- 已在当前画布图片模型选择器确认新图片模型选项存在。同名图片模型可在逻辑模型页按 ID 与渠道辨认。
- 未调用 ChatGPT 生成、未进行图片生成计费、未修改代理设置、未构建 Docker、未提交或 push。
- Web 全量 2981 项通过、10 项按环境跳过；专项 48 项通过；类型检查、ESLint、生产构建及生产模式 1440/390/430px 浅深主题回归通过。本地生产服务已重启。

## 文件变更

- `web/src/lib/server/chatgpt-api-models.ts`：提供通用托管模型目录，统一 GPTAPI 渠道名称。
- `web/src/app/api/admin/models/route.ts`：新增 GPTAPI 管理目录分支，脱敏返回失败信息。
- `web/src/components/admin/use-admin-dashboard-settings-actions.tsx`：单渠道及全部同步不再要求 GPTAPI 填写 Base URL。
- `web/src/components/admin/channels/admin-channel-onboarding-drawer.tsx`：GPTAPI 向导改为托管配置提示。
- `web/src/components/admin/channels/admin-channel-workspace.tsx`：渠道卡片显示托管运行时而非地址缺失。
- `web/src/app/admin/chatgpt-api/components/admin-chatgpt-api-section.tsx`：改名并明确同步按钮、选择数量及未配置说明。
- `web/src/app/admin/chatgpt-api/components/chatgpt-statistics.tsx`：运行环境说明改名。
- `web/src/components/admin/admin-section-nav.tsx`：侧栏和页面标题改名。
- `web/src/components/admin/magic-proxy-binding-card.tsx`：代理绑定名称改名。
- `web/src/lib/channel-protocol-registry.ts`：协议显示名称改名，保留协议 ID。
- `web/src/lib/auth/store-normalizers.ts`：持久渠道归一化名称改名。
- `web/src/services/api/chatgpt-api.ts`：请求错误文案改名。
- `web/src/app/api/chatgpt-api/[...path]/route.ts`：公共接口错误说明改名，URL 不变。
- `web/src/app/api/admin/chatgpt-api/[...path]/route.ts`：管理接口错误说明改名。
- `web/src/app/api/ai/system/[channelId]/[...path]/route.ts`：站内调用错误说明改名。
- `web/src/app/api/admin/models/route.test.ts`：覆盖无地址/密钥的目录接入及错误脱敏。
- `web/src/lib/server/chatgpt-api-models.test.ts`：覆盖目录能力、去重、只读与新名称。
- `web/src/lib/channel-protocol-registry.test.ts`、`web/src/lib/auth/store-normalizers-model-capabilities.test.ts`、`web/src/app/api/ai/system/[channelId]/[...path]/route.test.ts`、`web/src/services/api/chatgpt-api.test.ts`、`web/src/components/admin/admin-section-nav.test.tsx`、`web/src/components/admin/magic-proxy-binding-card.test.tsx`：同步显示名称的回归断言。
- `web/e2e/chatgpt-api.spec.ts`：更新名称及同步按钮回归入口。
- `docs/gptapi-channel-delivery-20260908.md`：记录根因、实际配置变化与验收边界。

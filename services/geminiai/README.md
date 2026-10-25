# GeminiAI provider sidecar

This service is the isolated GeminiAI provider for dreamyo. It is derived
from `chrysoljq/aistudio-api`; see [NOTICE.md](NOTICE.md) and
[LICENSE.upstream](LICENSE.upstream) for retained MIT attribution.

Compose starts it as the internal `geminiai` service. The dreamyo app uses
`DREAMYO_GEMINIAI_URL` and `DREAMYO_GEMINIAI_API_KEY`; the latter is
also passed to the sidecar as `AISTUDIO_API_KEY`. Do not expose port 8080 on a
public host or put this credential in browser code.

The public `GET /health` endpoint is only for container health checks. Account
and generation routes require `Authorization: Bearer <key>` or `X-API-Key`:

- `/accounts`, `/accounts/active`, login start/status, import, activate, update
  and delete
- `/rotation`, `/rotation/mode`, and `/rotation/accounts`
- `/v1/models`, `/v1/chat/completions`, `/v1/images/generations`, and
  `/v1/images/edits`
- `/v1beta/models/{model}:generateContent` and `:streamGenerateContent`
- `POST /config/models` (manual text/image declarations) and
  `POST /config/models/sync` (read the current authorized AI Studio model picker)

Google account state is persisted only in the `dreamyo-geminiai-accounts`
volume at `/data/accounts`. The container starts as root only long enough to
make that private volume owner-only, then drops to the `geminiai` user. New
account directories use `0700`; account metadata, registry, and auth files use
`0600`. Raw request/response dumping remains disabled by default. The image
downloads both Camoufox and fallback CloakBrowser binaries during its build,
so a running container does not need a first-use browser download.

For a repository-local production start (`pnpm build && pnpm start`), the web
supervisor starts this provider on `127.0.0.1:18080` and persists accounts under
`web/.data/geminiai/accounts`. An explicitly configured
`DREAMYO_GEMINIAI_URL` plus `DREAMYO_GEMINIAI_API_KEY` continues to
take precedence, so Compose and remote-provider deployments are unchanged.

The provider supports text, image generation/editing, and Google Search.
Omni 视频通过本地 `POST /v1/videos` 创建任务、`GET /v1/videos/{task_id}` 查询状态，
但 Provider 内部仍操作 AI Studio 浏览器完成预热、选模型、上传、提交与下载；
这些是本站的协议入口，不能视为已接入 Google 原生视频提交协议。
提示词填写和提交时只正常关闭当前可见弹窗中的明确 Close/Close guided tour 按钮，
忽略隐藏旧按钮并逐层处理；条款页与没有已知关闭入口的遮罩明确返回需人工处理的错误。
模型和参数选择期间不启用提交弹窗处理器，以免误关用户流程所需的选择窗口。

The default browser is Camoufox, matching both migrated reference projects;
`AISTUDIO_BROWSER=chromium` remains an explicit fallback. Browser authorization
state is engine-specific: accounts previously authorized in Chromium must be
authorized once in the Provider's Camoufox window before Camoufox can use them.
The built-in image models are `gemini-nano-banana-2.1`, `gemini-3-pro-image` and
`gemini-3.1-flash-image`. `AISTUDIO_API_KEY` protects this local sidecar and is
not a Google upstream credential.

后台 GeminiAIStudio 模型目录支持“获取账号模型”“手动添加模型”和逐项“测试模型”。
自动获取只读取当前 Provider 账号的原生模型选择器，不发送提示词，也不自动接受条款；
冷启动只打开授权浏览器，不调用生成预热。手动添加需填写模型 ID、文本/图片能力和可选名称，
保存为账号持久卷内的 `/data/accounts/model-catalog.json`（本地
`web/.data/geminiai/accounts/model-catalog.json`）。重复 ID 不覆盖原声明，目录读取失败不清空已有模型。
新增文本/图片 ID 复用已实现的协议与图片配置，无需重新编译；新协议的视频、音频、实时模型仍需适配。
添加或获取仅更新候选目录，勾选“保存所选模型”后才写入站点渠道及逻辑模型。
点击模型行的“测试模型”会预选该模型，再点击“开始实测”才发送一次真实请求，可能消耗账号额度；
测试成功必须收到有效文本或图片结果，目录存在与 HTTP 连接正常不能代替生成成功。

`POST /accounts/login/start` accepts `{ "name"?: string, "headless"?: boolean,
"ui_locale"?: string }`. A Google authorization requires a browser-capable
runtime and an interactive human login; a host browser's existing session is
not automatically shared with this isolated container. In a Linux container
without `DISPLAY` or `WAYLAND_DISPLAY`, a headed (`headless: false`) request is
rejected with an actionable login-status error instead of claiming that a host
browser window was opened.

# Dola Studio 与 Dreamyo 画布外部编排

本目录包含三个独立交付单元：`desktop/` 是 macOS/Windows Electron 客户端，`provider/` 是从现有 Dola 协议服务固定的独立源码快照，`canvas-mcp/` 是给 zcode 等 Agent 使用的画布 MCP 工具。完整可行性分析、风险和开发顺序见 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)。

## 画布：API、MCP 与 Skill 的分工

- **HTTP API** 是实际执行入口。`POST /api/external/canvas` 创建或续接画布 Agent Run，`GET ?runId=` 查询并把恢复操作写入真实画布，`GET ?projectId=` 查询节点和连线。服务端复用项目鉴权、创作规划、模型与任务执行链路。
- **MCP** 把这些接口暴露为 `create_canvas_from_script`、`get_canvas_run`、`get_canvas_project`，适合 zcode 工具调用。调用方应为每次新的用户指令生成唯一 `clientRequestId`，网络重试沿用同一个 ID。
- **Skill** 只适合描述剧本拆分、镜头节奏、提示词格式等创作方法；普通 Skill 仍按项目规定由用户本轮显式选择。Skill 不能替代项目鉴权、持久化、节点连接与视频任务执行。

在主站服务端设置 `DREAMYO_CANVAS_EXTERNAL_API_KEY`（至少 32 个字符）和 `DREAMYO_CANVAS_EXTERNAL_API_USER_ID`（已有用户 ID）。MCP 进程设置 `DREAMYO_CANVAS_API_BASE_URL`（主站地址）与 `DREAMYO_CANVAS_API_KEY`（相同密钥）：

```sh
cd Dola/canvas-mcp
pnpm install
DREAMYO_CANVAS_API_BASE_URL=http://127.0.0.1:3000 DREAMYO_CANVAS_API_KEY=... pnpm start
```

请求示例：

```json
{"clientRequestId":"one-script-20260927-001","title":"海边短片","prompt":"两镜头剧本：黄昏海边，人物回头；接着以人物背影生成五秒视频。引用我选择的参考图。","assetIds":["已存在且归属于用户的资产 ID"]}
```

返回 `projectId`、`projectUrl` 和 Run；持续查询 `runId`，直到完成或失败。`assetIds` 必须是系统已登记且归属此用户的素材，不能直接传本地文件路径。需要精确的首尾帧和模型时由请求的偏好及已有 Agent 规划契约决定；如果还缺少参考图资产上传入口，先通过主站素材上传获得资产 ID。

## 桌面开发与打包

```sh
uv sync --project Dola/provider --extra browser --extra test --extra build
cd Dola/desktop
pnpm install
pnpm build && pnpm test
pnpm start
```

桌面客户端启动后，左栏创建账号并在中间的 Dola 网页手动登录；登录态由只读探针确认后自动保存。账号名可留空，默认使用 `DOLA1` 起的序号；分组需先新建，再在添加或导入时选择。可粘贴 Cookie 或直接选择 UTF-8 TXT 按行批量导入，并可单账号或全部导出。Cookie 与代理订阅/口令经操作系统安全存储加密后保存在工作空间，导出文件是用户主动获取的明文。不同账号使用独立持久浏览器分区。

账号打开、网页刷新、任务提交与查询、素材处理、代理测试、导入导出及设置保存等需要等待的操作会显示带具体进度文案的全局弹层；账号打开和任务提交在同一请求尚未完成时不会重复发起。后台任务状态同步与缩略图读取不会打断当前编辑。

桌面创作支持图片、视频、普通参考、首帧和尾帧；参考类型统一在上方设置。图片可选择、粘贴或拖入，下方只显示缩略图。素材按本轮添加顺序命名为“图片1、图片2……”；提示词输入 `@` 或 `＠` 后可在光标附近选择本轮图片，支持键盘上下选择、回车确认、Esc 关闭。直接粘贴 `@图片1` 也会识别为引用，`<Picture 1>` 会转换为对应图片引用；引用在提示词内显示缩略图，可点击更换图片，退格或 Delete 可整体删除。协议任务由同目录 Provider 运行，结果按任务 ID 存入工作空间的 `assets/generated`；默认也复制到 `downloads`，可在设置中更换默认下载目录或关闭自动下载。右栏可打开任务所属的 Dola 会话、查看状态、逐项或批量下载，提示会显示实际保存路径。视频完成后按当前 Web 端协议尝试获取无水印版本，也可手动重试。15/30 秒通过时长解锁后作为新视频任务直接按协议提交，时长写入 `chat_ability.ability_param.duration`；真实生成结果仍需账号验收。

代理页按「通用代理 / 魔法代理 / 链式代理」三个标签分别管理。通用 HTTP/SOCKS 节点也接受 `host:port:user:password`；可编辑名称、分组，并可选择替换地址和认证信息，留空新地址则保留原加密口令。可粘贴现有 `groups`/`proxy_groups` JSON 批量导入代理组与节点。魔法代理支持 HTTPS 订阅、粘贴 Clash YAML/Base64/URI 内容，以及选择 `.yaml`、`.yml`、`.txt` 文件导入；文件导入和 URL 导入相互独立。订阅请求使用与当前 Web 端相同的 Clash 客户端标识，并对常见机场地址尝试 `flag=clash` 与原地址。若订阅服务返回“请在后台开启订阅获取”，需在其后台重新开启，并在服务商给定的有效期内导入；已保存的 YAML 文件可直接导入。魔法代理页的「测试全部节点」会按顺序测试所有订阅的节点，逐项显示可用性、耗时或失败原因及整体进度；可停止后续测试。不同跳板与落地节点可组成链，通用、魔法各节点和链式出口均可单独测试到 Dola 的连通性。组 JSON 必须保留完整节点 URL；若原系统导出时已脱敏，需使用原始本地配置文件。当前通用组只保留分组名称，账号绑定的是具体节点，原项目的组轮换策略尚未移植。账号操作弹层可修改账号名称、分组和代理出口；左侧「新建分组」使用应用内弹窗，创建后可在账号添加与批量导入时选择。Mihomo 为该账号创建独立本地监听，浏览器和协议服务使用该监听。代理订阅导入成功只证明解析完成；实际出站、DNS 与 Dola 登录仍需逐账号验证。

本机 API 在 API 页手动启用并生成密钥，默认固定监听 `127.0.0.1:19527`，可修改并持久保存端口。页面显示当前 Base URL；所有接口均需 `Authorization: Bearer <key>`。路径有 `GET /v1/health`、`GET /v1/models`、`POST /v1/videos`、`GET /v1/videos/{taskId}`、`POST /v1/images/generations`、`GET /v1/images/{taskId}`。API 调用需携带已登录的 `accountId`、模型、提示词和参数。

打包必须在目标平台原生执行，先冻结 Provider，再暂存同平台、同架构的 Mihomo 与 Camoufox：

```sh
cd Dola/desktop
pnpm freeze:provider
DOLA_MIHOMO_BINARY=/path/to/mihomo DOLA_CAMOUFOX_DIR=/path/to/camoufox pnpm stage:sidecars
pnpm pack:mac  # macOS
pnpm pack:win  # Windows
```

Camoufox 目录必须包含 `version.json` 与对应平台浏览器可执行文件。暂存二进制和打包产物在 `.gitignore` 中；源码仓库不会因为引用现有项目运行时而形成运行依赖。Windows 安装包和真实登录/生成需要 Windows 实机与有权限的真实 Dola 账号验收。

## 当前验收边界

本地源码构建、单元测试、MCP 握手、Provider 冻结、未签名 Mac 包构建及包内启动、三栏界面、真实账号登录及重启持久化已经验证。一次真实 5 秒视频提交建立了上游会话，但上游返回生成失败且未扣额度，客户端同步显示失败；一次 Seedream 4.5 生图成功，4 张 PNG 已写入工作空间并在素材页显示。成功视频及其下载尚未验证。验证码、实际 15/30 秒能力、代理出口 IP 和 Windows 包安装需要对应账号、订阅与 Windows 实机。不要将界面的模型选项或示例截图视作上游授权与可用性的证明。遇到上游拒绝时客户端显示失败，不自动改用其他模型或反复提交。

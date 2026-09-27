# 2026-09-27 验收记录

## 已执行

| 范围 | 命令或方法 | 结果 |
| --- | --- | --- |
| 独立 Dola Provider | `uv run --project Dola/provider --extra browser --extra test --extra build pytest -q Dola/provider/tests` | 74 项通过，包含失败消息优先级与任务重新绑定回归 |
| 桌面代码与代理解析 | `cd Dola/desktop && pnpm build && pnpm test` | 追加后 9 项通过 |
| Mihomo 本地进程 | 真实 darwin-arm64 Mihomo 启动本地代理，检查监听和临时配置删除 | 本地监听建立；明文 YAML 已删除；未连接外部代理出口 |
| Electron 开发模式 | `pnpm start`，自动截图并检查窗口与 Provider 状态 | Provider 启动，API 监听，浅色与深色工作台、深色代理页可见，见 `docs/screenshots/` |
| 本机 API | 使用仅用于测试的工作空间与密钥请求 `GET /v1/models` | 无 Bearer 401；正确 Bearer 200 |
| 画布接口 | `cd web && pnpm typecheck && pnpm build`；生产模式 `pnpm start` 后请求 `GET /api/external/canvas` | 类型检查及生产编译通过；未授权请求 401 |
| Canvas MCP | `cd Dola/canvas-mcp && pnpm build && pnpm test`；MCP stdio 初始化和 `tools/list` | 单测通过，三个工具均可发现 |
| macOS Provider | `pnpm freeze:provider` | darwin-arm64 单文件冻结成功，健康检查 200、未授权模型路由 401 |
| macOS 客户端 | `pnpm pack:mac`，直接运行包内 `Dola Studio.app/Contents/MacOS/Dola Studio` | 未签名 DMG/ZIP 生成；包内 Provider 启动，固定 API 端口与品牌图形显示正常 |
| 真实账号登录 | 在 Dola Studio 内手动登录、保存登录态、检查登录并重启客户端 | 独立网页重启后仍登录；本地账号检查状态为 `ready`，未在日志或报告保存 Cookie |
| 真实视频提交 | 同账号提交 Seedance 2.0 Fast、16:9、5 秒任务并打开对应 Dola 对话 | 协议提交被接受，网页出现对应会话；上游随后提示“视频生成失败，生成额度未扣除。”；客户端任务由 `accepted` 同步为 `failed` 并持久化相同原因 |
| 真实图片生成与下载 | 同账号提交 Seedream 4.5、16:9 图片任务；对同一上游会话重新查询并下载 | 网页、客户端均显示 4 张；4 张 2848×1600 PNG 已写入工作空间并可在素材页看到；其中一张已打开核对实际画面，四张的本地字节数均与源地址 HEAD 长度一致。修复了误收站点图标和图片 CDN 域名遗漏 |
| 单项与批量下载 | 点击“图片 1”和“下载已完成任务” | 单项提示“已保存结果 1”，批量提示“已处理 1 个任务”；同一已下载任务不会重复生成新文件 |
| 生成素材引用 | 在素材页点击一张已生成图片的“引用到提示词”，再移除 | 创作区出现可移除的普通参考素材；未再次提交任务 |
| 任务重启恢复 | 客户端重启后查询原任务，Provider 重新绑定账号会话 | 任务可从旧 Provider 状态继续查询，未重复创建上游会话 |
| 文本编码 | 严格 UTF-8 解码并扫描 `U+FFFD`、常见中文乱码标记 | 变更相关文本文件通过 |
| 全仓空白检查 | `git diff --check` | 工作区已有的 `web/src/app/(user)/canvas/[id]/use-canvas-node-actions.tsx`、`web/src/app/(user)/canvas/utils/canvas-surface-geometry.ts` 和 `web/src/components/admin/logical-model-display-order.ts` 存在空白提示；它们不属于本次独立 Dola 项目的修改范围，未覆盖用户现有改动 |

## 尚未具备验收条件

1. 已完成一次真实 5 秒视频提交，但上游生成失败，未产生视频。因此成功视频、视频下载和参考图生成仍未通过真实验收。图片成功产出 4 张并完成本地落盘；单项及批量下载入口已针对这批图片验证，源文件完整字节哈希尚未逐项对照。未提供可用代理订阅；5/10 秒以外时长仍需按账号网页及协议核验。
2. 没有 Windows 实机，Windows 侧的打包、启动、Camoufox、Mihomo、登录、下载路径与文件权限未验证。
3. 该账号的手动登录及重启恢复已验证；验证码、Apple 登录、真实代理出口 IP/DNS、成功的视频结果与批量下载仍需对应环境做端到端检查。
4. 通用代理组轮换策略没有移植；导入时保留组名与节点，账号需显式选择节点。资源区已支持任务状态、图片缩略图和单/批下载，更多筛选与失败重试界面尚需后续补齐。
5. Mac 安装包为未签名测试构建；正式外部分发需要签名、公证和目标机器验收。

## 本机测试包

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `desktop/dist/Dola Studio-0.1.0-arm64.dmg` | 约 530 MiB | `3a9c3742c3be606c9ebeefe7396f0db7984736c7131bb09992907a9a9bbbb252` |
| `desktop/dist/Dola Studio-0.1.0-arm64-mac.zip` | 约 529 MiB | `bb1348cc2a869b83eb0d6152c4f37ffe35740a83802094eae821122da26c6c06` |

## 建议的真实验收流程

1. 绑定可控测试代理，确认浏览器与协议任务出口一致；更换代理后确认旧连接已断开，并验证链式跳板/落地路径。
2. 用真实账号继续验证参考图生图、参考图视频和首尾帧视频；记录上游会话 ID、状态、实际模型与时长，确认结果在网页和右侧资源区一致。文本生图、4 张图片落盘及失败视频状态本轮已验证。
3. 在获得上游成功视频后验证视频落盘和下载；图片单项及批量下载、文件类型和源地址 Content-Length 对照本轮已验证，完整源媒体字节哈希仍可进一步比对。
4. 在 Windows 原生环境执行 `pnpm freeze:provider`、`pnpm stage:sidecars`、`pnpm pack:win`，安装后重复上述流程。

## 追加需求的本轮验证

| 范围 | 实际结果 |
| --- | --- |
| 源码与测试 | `pnpm build && pnpm test`：9 项通过；新增默认账号命名/分组、四段通用代理、Base64 节点订阅和无水印 VOD 契约测试。 |
| 生产启动与包内启动 | `pnpm start` 与新版 macOS 应用包内可执行文件分别启动成功，Provider、API 与工作台可用。新版 DMG/ZIP 已重新生成。 |
| 账号弹窗与创作区 | Playwright 通过 Electron CDP 实际点击关闭、取消、比例选项和 30 秒选项；真实粘贴图片后生成缩略图，`@` 菜单显示本轮图片，选择后删除查询文本并出现已引用标记。 |
| 真实会话 | 当前已登录账号在新客户端仍为 `ready`；点击现有任务“查询状态”后，中央 Dola 网页打开该任务会话。未新建收费任务。 |
| 真实图片下载 | 点击已完成任务“下载”，四张既有 PNG 复制到 `~/Documents/Dola Studio/downloads`；界面显示该完整目录。旧 `assets/generated` 素材仍保留。 |
| 文本编码 | 严格 UTF-8 解码并扫描 44 个 Dola 项目文本文件，未发现替换字符或常见乱码标记。 |

尚未通过真实验收：该账号没有成功视频，因此无水印 VOD 的真实下载、15/30 秒真实生成结果仍未知；用户的魔法订阅与通用代理尚未在新界面完成实际连通性测试；Windows 安装与文件权限需要 Windows 实机。现有 Web/Provider 源码确认：15/30 秒是在解锁后将时长写入 `chat_ability.ability_param.duration`，作为新视频任务直接按协议提交。

### 创作区补充回归

- Electron CDP 读取提示词区域实际高度为 **152px**，点击展开、编辑、关闭后主输入框保留新文本；生成图标按钮的无障碍名称为“开始生成”。
- 已登录真实账号的 Dola 网页内出现两个悬浮操作按钮，坐标位于网页视图之内，浏览器视图仍占中央全宽；未占用独立的侧边竖栏。
- 1100×680 桌面尺寸下无横向溢出；添加两张图片并选择“首尾帧”后分别得到 `first_frame`、`last_frame`，`@` 菜单只显示这两张本轮素材；浅色主题可切换。

### 图片引用回归（2026-09-27）

- 对照当前 Canvas `CanvasRichPromptEditor` 与 `CanvasResourceMentionTextarea`：移植本轮图片素材编号、`@/＠` 触发、按光标定位、键盘上下/回车/Esc、粘贴 `@图片N` 和 `<Picture N>`、内联缩略图标记及整体删除；Canvas 专属的 Skill、运镜和画布节点连线不属于 Dola 图片引用。
- 独立桌面 `pnpm build && pnpm test` 通过，13 项测试全部通过；Canvas 两个相关测试文件 29 项通过。
- 生产模式启动的 Electron CDP 实测：粘贴两张图片后缩略图内无单独参考类型控件，标签分别为“图片1/图片2”；`@` 菜单两项均在输入区内，未显示原文件名；键盘选择第二项后生成一个内联缩略图标记；直接粘贴两个 `@图片N` 后两个素材均标记为已引用，展开编辑器保留两个标记。另实测 `<Picture 1>` 转换与退格整体删除。
- 1100×680 浅色界面实测无横向溢出；`@` 菜单保持在输入区内，引用标记正文与光标色可读。新版 macOS arm64 DMG/ZIP 位于 `desktop/dist/prompt-reference-20260927/`；包内启动返回 `providerReady=true`。DMG SHA-256：`8382abecc9701d17153b1591a9eeeef9c222d28cbc0d682805c893231e2b5858`；ZIP SHA-256：`5c8b9e3ae5d3ef8c7fa6fd5904ae57dde8a1945f75633b90ed2d0e06935faacd`。
- 点击提示词内的图片引用标记后，会在该标记附近打开“更换引用图片”菜单；实测从图片1换为图片2后，提示词、内联缩略图与素材已引用状态一致。

### 全局等待状态回归（2026-09-27）

- 独立桌面 `pnpm build` 语法检查通过，`pnpm test` 共 13 项通过；仅修改 Dola 桌面源码，主站无需重新构建。
- 使用独立临时工作空间执行生产构建后的 `pnpm start`，通过 Electron CDP 实际点击保存设置、添加账号、再次打开账号和内嵌 Dola 网页悬浮刷新按钮：操作开始时弹层立即出现，网页/操作结束后关闭。连续两次点击同一账号仍只复用进行中的打开请求。
- 错误路径实测：提交无效代理地址时弹层显示“正在保存代理…”，服务端返回错误后弹层关闭且界面给出错误提示。等待弹层的屏幕截图已人工检查，位置居中，背景不可重复点击；真实键盘 Esc 回归确认等待弹层不会被提前关闭。
- 修改的 4 个源码文件通过严格 UTF-8 解码与乱码标记检查。新版 macOS arm64 包内应用启动返回 `providerReady=true`；未再次发起收费的真实生成任务，Windows 仍待实机验证。
- 新版安装包：`desktop/dist/loading-20260927/Dola Studio-0.1.0-arm64.dmg`（SHA-256 `f7df2731c373bcd73230614910153a3d415d04a24d7a4cc844de69a5978cdc42`）与 `desktop/dist/loading-20260927/Dola Studio-0.1.0-arm64-mac.zip`（SHA-256 `d8328788e0f3368805696e9af7d940139c756ee807f6a0ccb1a4d272e0f4c1e5`）。

### 代理管理与账号操作回归（2026-09-27）

- 根据用户截图确认账号操作挤在左侧列表内、订阅失败信息不足、通用代理缺少编辑入口。改为贴近账号卡片的悬浮设置面板，提供名称、分组、代理出口统一保存和独立导出/删除操作；三种代理使用各自标签页，并显示各自数量。Electron 界面实测菜单可打开及 Esc 关闭，弹层未压缩账号列表；点击账号时从代理页返回工作台。
- 通用节点编辑弹窗可修改名称、分组，替换地址或认证信息为可选项。使用隔离测试工作空间实际新增四段式代理并编辑：仅改名称/分组时加密地址摘要保持不变；提供新 SOCKS5 URL 后摘要改变；工作空间文件中没有明文口令。链式代理下拉框包含通用节点与魔法订阅节点。
- 从现有 Web `magic-proxy-service.ts` 对照订阅请求的 Clash 客户端标识与机场地址 `flag=clash` 规则。桌面端改为 Electron 会话网络栈下载，依次尝试三种客户端标识和适用的 URL 候选，支持 HTML/验证页回退并给出可操作的报错；本地 YAML 在桌面界面导入成功。自动测试覆盖 HTML 首次响应、候选 URL 回退及最终验证页失败。用户截图中的完整私人订阅 URL 未在当前输入框保留，尚未对该具体链接完成真实拉取与节点连通性验收。
- `cd Dola/desktop && pnpm build && pnpm test` 通过：16/16；生产打包 `pnpm pack:mac --config.directories.output=dist/proxy-management-20260927` 通过。新包内启动返回 `providerReady=true`，代理页实际截图显示三个标签及通用节点表单。既有 Dola Studio 正占用本地 API 端口 19527，因此并行包启动时提示端口占用；不影响独立 Provider 启动。8 个相关文本文件严格 UTF-8 解码与乱码标记检查通过。
- macOS arm64 未签名测试包：`desktop/dist/proxy-management-20260927/Dola Studio-0.1.0-arm64.dmg`，SHA-256 `e9b6be29359cd13ecdd7878bdb109b96a3658fd7177c8d2e91fc1763a4fdbbda`；同目录 ZIP SHA-256 `f21d22fd6fd156dbad931d6edfbead281c4bd2e5360bb0aa2eb82cf6bb25e85e`。Windows 打包和真实代理出站仍待目标环境验证。

### 账号分组、网页控件与文件订阅回归（2026-09-27）

- 「新建分组」原先调用浏览器原生 `prompt()`，在 Electron 窗口中没有可见的可靠交互；改为应用内 Modal。生产模式 `pnpm start` 的真实窗口中创建测试分组后得到成功提示，添加账号下拉中出现该分组，重启客户端后仍存在。
- Dola 内嵌网页的返回与刷新按钮从右上角 36px 控件改为右边缘 27px 半透明控件，悬停增强对比。实际打开未登录的 Dola 网页后，两按钮可见，截图检查未占用独立布局宽度，也未覆盖中央标题和输入区。
- 魔法代理增加与当前 Web 端同样的 `.yaml`、`.yml`、`.txt` 本地文件选择和独立导入操作。通过系统文件选择器选取隔离测试 YAML 后，导入成功，魔法代理列表显示 1 个测试节点；文件名可见，口令未回显。
- 用户提供的限时订阅链接在本机第一次获取时返回 HTTP 200、`application/octet-stream`，解析出 141 个节点；稍后同一链接返回 HTTP 200、`text/html`，正文明确要求在订阅后台开启获取，并写明有效期 10 分钟。应用中的错误已改为准确说明「尚未开启或已过期，请在后台重新开启并在 10 分钟内导入」。当前无法在链接失效状态下完成真实导入或出口连通性测试；待用户重新开启后复测。完整链接、节点口令和响应内容均未写入仓库或验收文档。
- `cd Dola/desktop && pnpm build && pnpm test` 通过，19/19。Electron UI 实际点击右侧网页刷新和返回，刷新后重新载入 Dola 页面；返回在无历史页时保持当前页。9 个相关文本文件严格 UTF-8 解码与乱码标记检查通过。
- 新版 macOS arm64 未签名 DMG/ZIP 位于 `desktop/dist/subscription-file-20260927/`。DMG SHA-256：`f61fc15bfad0ca7b3a019d57d2493d3a38adf5a5ab20da9531fa423943018b2a`；ZIP SHA-256：`90553364c3df4dfb65ac6b4602ac720f5b2c240ffb0af515d148e512077c7478`。包内启动返回 `providerReady=true`，实际截图确认代理页布局；已有 Dola Studio 占用本机 API 端口 19527，故并行启动的测试包显示端口占用提示。Windows 安装仍需原生环境验收。

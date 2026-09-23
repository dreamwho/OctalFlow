# 桌面 Sidecar 暂存目录

正式安装包只从当前目标平台构建并放入已冻结的 Provider 可执行文件，不读取用户电脑上的 Python、Node 或 Docker。

- macOS arm64/x64 和 Windows x64 分别构建。
- `scripts/prepare-runtime.mjs` 逐项校验 `dola-api`、`geminiai`、`chatgpt-api`、`geminiai-browser`、`mihomo`、`ffmpeg`、`ffprobe`、`dreamina`、`video-depth`（Windows 加 `.exe`）、`video-depth-model/` 三个必需模型文件以及浏览器。GeminiTools 属于 Next 服务内的 OAuth 适配器。macOS arm64 本地预检已通过；macOS x64 与 Windows x64 尚需在目标架构逐项构建、运行和验收。
- 桌面 Mihomo 从安装包读取 `desktop/mihomo-bootstrap.yaml`，在应用私有数据目录生成仅本机监听的配置、密钥和四个独立出口；订阅文件只在私有数据目录保存，不放入安装包。桌面视频深度使用冻结的 `video-depth` 与固定模型目录，FFmpeg/FFprobe 与即梦 CLI 只从包内指定路径运行。
- 在目标平台执行 `pnpm freeze:dola`，从当前 `services/dola-api/.venv` 生成独立程序，自动用随机端口验证健康接口及未授权 401，并记录 SHA-256 到 `apps/desktop/build/freeze-dola/dola-api.sha256`；需要预先在该虚拟环境安装 PyInstaller。macOS arm64 的本地验证通过，其他平台和真实 Camoufox 请求尚未验收。
- `pnpm freeze:geminiai`、`pnpm freeze:geminiai-browser`、`pnpm freeze:chatgpt-api` 分别冻结服务与启动器；Camoufox 的 `apify_fingerprint_datapoints` 和 `language_tags` 包含运行时数据，不可仅打包源码。独立进程的 `--help` 与健康检查必须在剥离系统 Python 的 PATH 下通过。
- `pnpm freeze:video-depth` 冻结本地深度模型推理进程并使用 32×32 图片和包内模型完成一次离线推理；PyInstaller 的运行时警告也要单独复核。`pnpm stage:media-tools` 从固定的 `ffmpeg-static` 二进制发布标签取得 FFmpeg/FFprobe、该构建的 README 和许可证，用实际编码和探测验证后写 SHA-256。安装包的第三方许可证及源码提供义务须在正式商业分发前逐项核对；当前的临时可执行文件不提交 Git。
- `pnpm stage:dreamina` 从即梦官方安装源按当前原生目标平台暂存 CLI（macOS arm64/x64、Windows x64），校验 Mach-O/PE 架构，并在 `dreamina-release.json` 记录供应商版本与二进制 SHA-256；Windows 打包预检会验证清单、官方文件名和 PE x64 程序摘要一致。Windows 目标须在 Windows x64 原生环境运行此命令，禁止把 macOS/Linux 二进制改名为 `.exe`。
- `pnpm stage:mihomo` 只允许在 Windows x64 原生环境运行，从 MetaCubeX 官方 `v1.19.31` 发布包获取 Mihomo，校验官方 SHA-256、PE 架构并执行版本烟测后暂存；版本、压缩包摘要和二进制摘要写入发布清单。
- Cookie、代理凭据、运行数据库与用户素材不得进入安装包，首次启动后写入各版本独立的 `userData/data`。
- `camoufox/` 必须包含整套原生浏览器资源和根目录的 `version.json`。macOS 的入口为 `Camoufox.app/Contents/MacOS/camoufox`，还需把同一版本的 `Contents/Resources/properties.json` 放在可执行文件旁；Camoufox 自定义可执行文件协议从旁边读取它。Windows 入口为 `camoufox.exe`，其旁也必须有 `properties.json`。构建预检会逐项确认。

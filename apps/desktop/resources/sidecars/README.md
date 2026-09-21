# 桌面 Sidecar 暂存目录

正式安装包只从当前目标平台构建并放入已冻结的 Provider 可执行文件，不读取用户电脑上的 Python、Node 或 Docker。

- macOS arm64/x64 和 Windows x64 分别构建。
- Dola API、GeminiAIStudio、GPTAPI 的冻结运行文件及浏览器必须由 `scripts/prepare-runtime.mjs` 校验后进入此目录；GeminiTools 当前属于 Next 服务内的 OAuth 适配器，即梦 CLI、Mihomo、FFmpeg 和视频深度推理仍需补齐平台运行文件与启动编排，未补齐前不得发布完整安装包。
- Cookie、代理凭据、运行数据库与用户素材不得进入安装包，首次启动后写入各版本独立的 `userData/data`。
- `camoufox/` 必须包含整套原生浏览器资源和根目录的 `version.json`。macOS 的入口为 `Camoufox.app/Contents/MacOS/camoufox`，还需把同一版本的 `Contents/Resources/properties.json` 放在可执行文件旁；Camoufox 自定义可执行文件协议从旁边读取它。Windows 入口为 `camoufox.exe`，其旁也必须有 `properties.json`。构建预检会逐项确认。

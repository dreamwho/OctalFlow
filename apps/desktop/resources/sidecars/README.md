# 桌面 Sidecar 暂存目录

正式安装包只从当前目标平台构建并放入已冻结的 Provider 可执行文件，不读取用户电脑上的 Python、Node 或 Docker。

- macOS arm64/x64 和 Windows x64 分别构建。
- Dola API、GeminiAIStudio、GPTAPI、GeminiTools、即梦 CLI 的运行文件必须由 `scripts/prepare-sidecars.mjs` 校验后进入此目录。
- Cookie、代理凭据、运行数据库与用户素材不得进入安装包，首次启动后写入各版本独立的 `userData/data`。

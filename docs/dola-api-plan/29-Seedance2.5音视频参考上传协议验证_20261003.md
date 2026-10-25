# DOLA Seedance 2.5 音视频参考上传协议验证（2026-10-03）

## 结论与验收边界

Web DOLA Provider 已实现音频、视频参考上传与类型化附件；桌面 Python Provider 同步协议契约。后台通信测试窗口可选择三类素材，Canvas 中显式 @ 引用的已连接音视频节点通过普通参考进入请求。用户授权仅上传合成短素材、不提交生成；本轮真实账号测试严格遵守此范围，未调用生成接口。**上传成功不等于 Seedance 实际采用参考，也不等于视频出片成功。** 真实混合参考生成、目标服务器 Docker 部署仍待验收。Dola Studio Electron 原生文件选择 UI 不在本次 Web 改动范围。

## 根因

1. 旧上传器全部走 ImageX 图片上传，缺少 VOD 音视频上传协议。
2. 旧 attachment block 将所有参考写成 `type: 1` 图片，没有 VOD `vid` 与真实媒体类型。
3. Web DOLA 默认模型没有声明音视频参考能力，未配置请求模板时通用 payload 还会丢掉音视频 `references`。
4. 后台通信测试窗口及接口只接受 `data:image/*`，不能通过此入口选择音视频。

## 证据与协议

对照同一真实账号当前 Dola 页面、公开网页 JS（主 chunk `chat.b1724f6991.js`）与原生 VODSDK 上传，最小 HTTP 重放成功。Seedance 2.5 官方模型能力来源：[One-Take Creation, Flexible Referencing](https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5)；模型能力本身不用于证明 Dola 生成验收。

| 阶段 | 视频 | 音频 |
| --- | --- | --- |
| `/alice/resource/prepare_upload` | tenant `3` / scene `46` / resource_type `4` | tenant `3` / scene `47` / resource_type `4` |
| 签名 | SigV4 `us-east-1/vod/aws4_request` | 同视频 |
| ApplyUploadInner | Version `2020-11-19`, SpaceName, FileType `video`, IsInner `1`, FileSize | 同视频；传输类型与素材实际类型独立 |
| 二进制传输 | `/upload/v1/{StoreUri}`，POST 原始字节、Store Auth、8 位 CRC32 | 同视频 |
| CommitUploadInner | `{SessionKey, Functions: []}` | 同视频 |
| 成功判定 | 非空 Vid 且 VideoMeta.FileType `video` | 非空 Vid 且 VideoMeta.FileType `audio` |
| 生成附件 | `type: 3`, `media:{vid,media_type:2,duration,size,name}` | `type: 3`, `media:{vid,media_type:1,duration,size,name}` |

真实网页实验最初失败于 SDK 将没有 `https://` 的 upload_host 当成 Dola 相对路径；补全主机地址后，原生 SDK 与精简协议都上传成功。已上传合成 MP4（320×180、2 秒、57817 字节）及 MP3（440Hz、2 秒、16527 字节）；上游均返回有效 VID 和对应类型。证据仅保存脱敏结果与离线构造附件，不保存 Cookie、Token、签名上传授权或二进制参考素材。

- [真实协议上传结果](evidence/20261003-media-references/protocol-uploads.sanitized.json)
- [离线构造的生成附件](evidence/20261003-media-references/submission-attachments.sanitized.json)（未发送生成请求）

## 修改文件

| 文件 | 修改说明 |
| --- | --- |
| `services/dola-api/src/dola_api/uploads.py` | 按素材类型选择 ImageX/VOD，验证真实 VID 和媒体类型，沿用独立上传出口与已有资源保护。 |
| `services/dola-api/src/dola_api/session.py` | 音视频使用原生媒体附件，非 2.5 模型提交音视频明确失败。 |
| `Dola/provider/src/dola_api/uploads.py` | 同步桌面 Python Provider 的 VOD 上传契约。 |
| `Dola/provider/src/dola_api/session.py` | 同步桌面 Python Provider 的类型化附件契约。 |
| `web/src/lib/channel-protocol-registry.ts` | 仅 Seedance 2.5 开启音视频参考能力。 |
| `web/src/app/api/video-generation-tasks/video-generation-route.ts` | 无请求模板时仍完整发送 DOLA 混合参考和首尾帧参数。 |
| `web/src/components/admin/admin-dola-api-section.tsx` | Seedance 2.5 通信测试可选择音视频；换为其他模型清空不支持的素材。 |
| `web/src/app/api/admin/dola/test/route.ts` | 验证真实类型与模型能力，保留媒体类型；沿用测试窗口原有请求大小与数量保护。 |
| `web/src/lib/server/dola/service.ts`、`web/src/services/api/dola.ts` | 测试请求显式携带 image/video/audio 类型。 |
| `services/dola-api/tests/test_media_references.py` | TCP 夹具核对 Apply、二进制 CRC、Commit、附件及 HTTP200 业务失败。 |
| `Dola/provider/tests/test_media_references.py` | 同步桌面 Provider 的音视频协议 TCP 回归。 |
| `Dola/provider/tests/test_contracts.py` | 更新已上传图片的显式类型预期。 |
| `web/src/lib/channel-protocol-registry.test.ts`、`web/src/app/api/video-generation-tasks/route.test.ts` | 核对模型能力及签名混合参考不会丢失。 |
| `web/src/app/api/admin/dola/test/route.test.ts` | 核对三类测试素材与错误模型/类型的拒绝。 |
| `web/e2e/dola-admin.spec.ts`、`web/e2e/support.ts`、`web/scripts/protocol-fixture-server.mjs` | 隔离浏览器夹具核对测试窗口与 Canvas 的音视频参考传到 Provider。 |
| `CHANGELOG.md`、`docs/content/docs/progress/pending-test.mdx`、`docs/content/docs/progress/todo.mdx` | 记录实现与真实生成/部署验收边界。 |

## 验证结果

Web 全量 3559 项通过、14 项依赖环境跳过；DOLA 服务 140 项通过，桌面 Provider 111 项通过。TypeScript、ESLint、生产构建通过。浏览器回归 14 项通过（含 3 项初始化）：后台两类上传选择、1440/390/430 布局、Canvas 混合参考进入 Provider 与真实本地媒体文件，另覆盖 Canvas 节点编辑/连线/持久化/首尾帧、图片工作台生成与参考选择、视频工作台参考入口、文本/图片/视频/音频本地 API。旧 `unified creative page reaches...` 用例仍查找已替换的 `.creative-composer`，单独失败，不计入本次通过结果；同一后台测试窗口连续两次提交也未完成验收，本轮采用每个类型独立页面单次提交。

离线包包含 6 份 linux/amd64 镜像，总约 3.3GB；App 与 DOLA Provider 均重新构建。Linux 容器内的 `uploads.py`、`session.py` SHA256 与当前源码一致。源码及部署文本严格 UTF-8 检查通过，SHA256 校验 40 份文件通过（包含全部镜像、脚本、配置、报告和证据）。本地验证和打包不会更新 192.168.100.223。

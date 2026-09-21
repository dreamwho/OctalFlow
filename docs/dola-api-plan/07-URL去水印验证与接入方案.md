# URL 去水印：实测结论与可交接接入方案

日期：2026-09-16。**协议实验通过两个已有真实样本；应用解析、自动开关和 Canvas 派生节点已实施。** 用户新增参考项目 [admin0x/doubaokit](https://github.com/admin0x/doubaokit)，本次审查版本 `dcf7041c87fa3b7153edd2fddc5d7b6bd238a811`。未安装该扩展；仅阅读源码并用自写临时验证程序访问真实 Dola 返回的第一方媒体接口。没有再次生成视频。当前实现已把 `fallback_api` 三参数请求、标准 QAAB 解码和通用代理出口接入服务端；真实目标环境的再次媒体闭环仍需部署验收。

## 1. 结论及边界

可将“URL 提取上游无水印版本”作为 Dola 去水印的首选实现方式。原视频继续保留；手动右键和自动设置都使用同一解析器，手动成功后产生派生 Canvas 节点，自动模式在视频落盘前切换到无水印地址。服务端仍会校验源视频归属、上游域名和通用代理出口，不接受任意外部视频链接。

这里的输入不是任意裸 MP4 地址：需要原生成消息中的 `video.video_model` 所含 `fallback_api`，或能够使用原账号与稳定会话/creation 关联重新取得该元数据。`fallback_api` 自带签名及解码所需信息；仅拿一个已过期下载地址，尚无证据能恢复它。产品不增加“粘贴任意视频链接都保证去水印”的入口。

证据：[机器可读结果](evidence/live/url-watermark-verification.json)、[2.5 对比图](evidence/live/DOLA-P25-001-comparison.jpg)、[Fast 对比图](evidence/live/DOLA-P20F-001-comparison.jpg)。每张图左侧是原片，右侧是 URL 提取版本，分别抽查起始、中间、结尾。没有逐帧人工检查，结论不扩大为所有 Dola 视频永久有效。

| 原生成样本 | 原片规格 | 提取版本规格 | 检查结果 |
| --- | --- | --- | --- |
| 2.5 / 5秒 / 16:9 | 1280×720，121帧，视频5.041667秒，容器5.041667秒 | 相同宽高、帧数、视频与容器时长 | 0/2.5/4.9秒均无可见 Dola AI；全文件解码通过 |
| Fast / 10秒 / 9:16 | 720×1280，241帧，视频10.041667秒，容器10.08秒 | 相同宽高、帧数、视频与容器时长 | 0/5/9.9秒均无可见 Dola AI；全文件解码通过 |

提取文件 SHA-256：

- 2.5：`364a1b1c46b0cc634e15098c5c7ca1aaf048ce47282ca32ce75ae87cc24f513e`，6,184,047 字节。
- Fast：`f045f036d6049bca9129d6ed18155362f390eacc3c02deea462ec7144b24d4ba`，4,425,359 字节。

两个接口请求均 HTTP 200，媒体下载未携带 Cookie。原片是 HEVC/AAC 44100Hz，提取版是 H.264/AAC 32000Hz；因此不能宣传“字节无损”或“音频完全不变”。本机没有重新编码这两份提取文件，差异来自上游返回的另一个媒体版本。派生结果必须按真实编码信息展示和保存。

## 2. 已实测的解析链路

### 2.1 找到同一生成结果的播放信息

从原任务的 `/im/chain/single` 响应定位对应 `block_type=2074`、creation `type=2` 的 `video`。解析 JSON 字符串 `video_model`，读取 `fallback_api`。不能扫描“最近一条会话”、任意助手文本 URL 或其他用户媒体来代替原任务关联。`video_model` 是播放信息，不是 Seedance 模型 ID。

本次真实主机为 `vod-urls-mya.byteintlapi.com`。保留原 URL 已有签名字段，仅覆盖下列三个查询参数：

```ts
const url = new URL(vod.fallback_api);
url.searchParams.set('channel', 'no');
url.searchParams.set('codec_type', '8');
url.searchParams.set('logo_type', 'unwatermarked');
// 使用任务已固定的出口；不向该接口附带账号 Cookie。
const response = await transport.fetchJson(url, { signal });
```

这里是说明性伪代码，不是已经存在的项目函数。请求使用 GET。只设置 `logo_type=unwatermarked` 并不够作为结论：基线元数据已有这一值，原片仍有水印；本次验证的是三个参数的组合和实际成片。

### 2.2 读取变体与解码 URL

本次响应顶层为 `{video_info, message, code}`，在视频数据的 `video_list` 中取得 `main_url`、`vwidth/vheight`、`codec_type`、`definition` 及 `key_seed`。实际得到的 `main_url` 以 `qAAB` 开头，**不是可直接 base64 解成 HTTP 地址**。

本次两个样本用以下精确格式解码成功：

1. Base64 解码 `key_seed` 和 `main_url`，使用库处理 URL-safe 字符与填充。
2. `main_url` 解码后的前四字节为 `a8 00 01 00`；余下字节为 AES 密文。未知头部明确返回 `UNSUPPORTED_URL_TOKEN`，不盲试几十种格式。
3. `d1 = SHA512(seed[0:32])`。
4. `d2 = SHA512(d1 || protocolSalt)`，salt 的十六进制值为：

```text
4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58
```

5. 使用 `d2[0:16]` 作为 AES-128-CBC key，`d2[16:32]` 作为 IV，解密密文并由成熟库校验/移除 PKCS#7 padding，解析为 URL。
6. 使用 Node `crypto` 或 WebCrypto 等成熟实现；本次独立验证使用 `cryptography`，没有手写密码算法。不要照搬参考代码的其他未验证解密分支。
7. 校验 URL 主机、协议及重定向。样本解码到 `v16-dola.dola.com`，对应 HTTPS 下载成功。不得把账号 Cookie、STS 凭据、完整 fallback URL、key_seed 或签名播放 URL 写入公开日志。

本次每个样本只有一个可用的视频变体。多个变体时，保留列表并按源结果实际尺寸/完整时长与既有管理员画质策略选择；不要直接采用参考项目“码率数值 + 像素数”的混合分数，也不要因 `definition` 标签较高就认定文件更清晰。

### 2.3 下载与验证

流式写入任务临时文件，计算哈希，使用媒体 MIME、文件头和 FFprobe 校验。未知长度时按既有存储/资源保护合同处理，不随意添加时长或体积限制。下载过程返回真实已收字节，未知总长不编百分比。

完成后记录实际宽高、帧数、视频/容器时长、编码和音轨。视频完整可解码、同源画面无误，才保存为站内独立 `storageKey`。不能把 Dola 的签名 URL 当 Canvas 长期地址，也不能先缩放/裁切到请求比例。URL 方案是保存上游派生版本，不在本地重编码。

## 3. 接入现有任务体系的具体改动草案

当前实现文件与责任：

| 文件/模块 | 责任 |
| --- | --- |
| `web/src/lib/server/dola/watermark-url.ts` | 解析已知 VOD 结构、编译三参数 URL、请求真实无水印 VOD、使用标准库解码已验证 token、校验目标域名；无数据库逻辑 |
| `web/src/lib/server/dola/watermark-service.ts` | 用户归属、通用代理解析和服务端无水印 URL 请求 |
| `web/src/app/api/canvas/dola-watermark/route.ts`、Canvas 派生节点 | 受权源视频、手动解析和派生节点展示；不创建新的 Dola 生成任务 |
| Dola Provider 的原结果查询方法 | 根据 account/attempt/conversation/message/creation 关联刷新播放信息；不发创建请求 |
| Dola repository / 任务私有 payload | 保存稳定源关联、受控元数据引用、方法与版本；凭据和有效签名元数据加密或短期私有保存，公共 DTO 不包含 |
| 现有 Canvas 去水印拟定 API 与节点 | 沿用02/03的 sourceStorageKey、sourceTaskId、clientRequestId 和派生节点；不接收任意外部 URL |

后处理方法快照：`method: 'source-url'`、`resolverRevision: 'dola-vod-qaab-v1'`。幂等键包含 `sourceMediaIdentity + method + resolverRevision + optionsFingerprint`；不能只沿用本地算法版本导致两种方式共用错误缓存。

阶段：`resolve_source → query_original_result（仅需刷新时）→ fetch_vod → decode_url → download → inspect → persist`。沿用已有 task 执行阶段枚举和事件协议，以上是 provider detail，不随意扩展全站通用状态。URL 方法不需要 CPU 修复 sidecar；若项目以后保留本地修复，它是独立可选方法。

自动关闭：右键 **Dola 去水印** 建相邻派生节点并连线，原节点保持可用。自动开启：源视频落盘后服务器创建唯一后处理任务，页面关闭也执行；成功后派生片可优先显示，保留原片入口。客户端不展示密码派生、签名和 VOD 实现细节。

| 情况 | 行为 |
| --- | --- |
| VOD 签名过期 / CDN 403 | 使用原账号与稳定源关联重新查询同一结果；按上游有效期、错误语义和现有任务配置调度；不新建视频 |
| 原账号会话过期、媒体结果不可恢复 | `needs_login` 或明确的 `SOURCE_METADATA_UNAVAILABLE`；保留原片，管理员恢复后仅重试后处理 |
| 返回未知 token / 无有效变体 / HTML | 明确解析失败，保存脱敏结构摘要；不猜测地址、不伪造无水印成功 |
| 下载取消/Worker 崩溃 | 只清理本次临时文件并恢复同 render；已经完成的派生媒体不重复登记 |
| 检测结果不符或仍有水印 | 不把任务标“已去水印”；保留来源版本，记录质量待复核 |
| URL 提取失败 | 默认明确失败；**不静默切到局部修复并改变画质**。未来需要修复回退须有独立配置和方法记录 |

## 4. 旧本地修复工具的真实回归

[运行证据](evidence/live/watermark-real-video-check.json) 使用本轮两份真实原片，而不只是合成素材。参考脚本两个都返回 `True`，但2.5样本从121帧/5.041667秒变为119帧/4.958333秒，容器4.969002秒；短音轨与 remux 的 `-shortest` 会截掉视频尾部。Fast仍为241帧，但音轨/容器时长发生变化。进程峰值 RSS 为864,665,600字节（约825MiB）。本轮未判定其修复画面质量。

因此不把原脚本直接作为默认实现。若后续实现本地修复，需要两遍流式算法、完整帧保留、音轨处理策略和真实画质验收；修复版与 URL 版均保留原片，并且不能把脚本返回 True 当验收通过。

## 5. 代码来源与需要完成的测试

参考仓库 `background.js` 头部标注 GPL-3.0，当前仓库根未发现独立 LICENSE 文件。记录该事实；不把整个扩展、账号管理和自动注入逻辑拷入项目。按上述实测协议与标准密码库独立实现；如果未来需要直接复用代码，先明确该具体文件适用许可。

应用回归必须覆盖：已验证头部、错误 padding/损坏token、缺少key_seed、嵌套VOD JSON、过期签名、非白名单地址及重定向、输出HTML、自动/手动共用解析器、他人源媒体拒绝、通用代理出口、以及所有日志脱敏。离线用自建密钥和 URL 生成解码夹具，不提交真实 token；目标部署仍需补真实 `fallback_api` 请求、媒体下载和 Canvas 播放验收。

已有两个原视频足以复用验证 URL 方案，不消耗新的生成额度。15/30秒及更多比例的去水印覆盖，需要先有对应真实成片；其未测状态仍保留。完成集成后，还要验证真实后台开关、Canvas派生节点、下载、权限和生产部署；本报告不替代这些应用验收。

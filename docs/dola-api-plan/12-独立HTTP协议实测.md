# 独立 HTTP 协议实测：读取、上传通过，生成触发验证

日期：2026-09-16。Case：`DOLA-HTTP-F005-I1`。**本次独立HTTP生成未通过：上游要求滑块验证，未收到生成任务ID。** 不能用前面网页原生成功或HTTP200覆盖这次结果。

> 后续补充：2.5原生图生成片现已核验，见10；官方滑块入口、回调和原生自动重发已从第一方代码定位，方案见[13](13-滑块验证处理与会话恢复.md)。尚未完成一次真实挑战及独立HTTP恢复创建，本页失败结论不变。

> 新账号复测：用户后来切换账号C并授权一次相同Fast5秒单图HTTP测试，仍返回verify/slide；独立记录见[14](14-新账号HTTP复测与Canvas人工验证.md)。本页保持B账号历史边界。

> 最新环境矩阵：增加IPWO通用代理后，独立HTTP仍返回verify/slide；同一用户Cookie导入全新Camoufox context后，原生页面提交取得SSE_ACK且无滑块。因此本页独立HTTP失败结论保持，生产主transport改为Camoufox page；详见[15](15-IPWO直协议与Camoufox-Cookie会话实测.md)。

> 追加复测：用户提供的105行Cookie文件第1条账号在无IPWO的独立HTTP链路中，能力、ImageX上传和`pre_handle`通过，创建仍返回verify/slide；证据见[16](16-105账号Cookie批量导入与直协议复测.md)。其余104条没有自动尝试。

## 1. 授权与执行边界

用户指出此前通过浏览器操作生成，要求使用当前账号剩余1个额度独立测试Fast5秒。本次增加且仅执行一次`/chat/completion`创建尝试；没有自动重发，没有换号，也没有回到网页点击生成。

浏览器仅用于通过DevTools导出当前账号的授权会话头和已有请求结构。敏感HAR保存在本机0600临时文件中；导出后立即恢复DevTools默认脱敏设置。所有预检、图片上传、生成POST和SSE读取均由**独立Python进程的HTTPX客户端**完成，没有调用浏览器内`fetch`、Playwright页面执行或网页控件。

这验证的是“当前桌面会话凭据导入本机HTTP客户端”，不是从零登录、长期Cookie刷新或Linux服务器部署。使用本机当前代理出口；这些边界仍需在目标部署环境分别验收。

## 2. 逐项结果

| 步骤 | 独立协议操作 | 实际结果 |
| --- | --- | --- |
| 能力预检 | POST `/alice/slot/action_bar_v3/get_item_conf` | HTTP200、code=0；读到`seedance_v2.0`与`seedance_v2.5` |
| 登录/查询预检 | POST `/im/chain/single`，指定此前Fast原会话 | HTTP200、status_code=0；匹配原测试提示词与真实视频对象 |
| 上传准备 | POST `/alice/resource/prepare_upload` | HTTP200、code=0；返回新STS上传参数 |
| 申请上传 | imagex `ApplyImageUpload` | HTTP200；用botocore标准SigV4Auth签名，取得新上传位置 |
| 图片二进制 | POST至返回的vodupload主机 | HTTP200、code=2000；4,790字节PNG；zlib CRC32 |
| 提交上传 | imagex `CommitImageUpload` | HTTP200；新URI、960×540 |
| 图片预处理 | POST `/alice/message/pre_handle_v2_without_conv` | HTTP200、code=0；取得pre_generate_id |
| 生成创建 | POST `/chat/completion`，Fast/5秒/16:9/一图 | HTTP200，但SSE为HEARTBEAT → STREAM_ERROR → SSE_REPLY_END |
| 上游错误 | STREAM_ERROR | `error_code=710022004`，`error_msg="rate limited"` |
| 错误附带判定 | decision JSON | `code="10000"`、`from="shark_admin"`、`type="verify"`、`subtype="slide"` |
| 任务/媒体 | SSE_ACK和成片 | **未收到SSE_ACK、会话/生成任务ID或成片** |

图片与前一次成功Fast样本相同，参数保持5秒、16:9。此次使用了**HTTP客户端新上传的图片URI**，不是复用此前浏览器上传资源来代替上传验证。

上传地址由上游动态返回。本次返回`tos-myb2-share.vodupload.com`，与前次浏览器样本的`tos-myb1-share.vodupload.com`不同；不能把单台上传主机硬编码成完整协议。调研客户端第一次发现主机差异时在发送二进制前停止，核对上游返回后继续；这些上传操作没有创建视频。生产实现应按实际第一方域名合同验证，并禁止把Cookie/STS发送到无关域名。

## 3. 这次究竟证明什么

**已经证明：** 当前会话凭据可被独立HTTP客户端使用；能力读取、指定原会话查询、标准库签名上传与预处理可执行。上述Dola请求没有携带复制的`a_bogus`或`msToken`查询参数；Cookie仅发送给Dola，STS只用于imagex签名，二进制上传只使用对应上传授权。

**没有证明：** 创建视频的无浏览器协议可用。创建入口返回验证要求；不能把`rate limited`直接归类成余额不足、每日额度用完或可随意换号重试的错误。也不能据此断言所有带正常动态签名的HTTP实现都不可行——当前测试未实现官方网页当前动态签名和验证会话合同。

错误的`extra.ack`为字符串`"1"`，它是错误信封字段，**不是`SSE_ACK`事件，也不包含可查询的视频任务ID**。研究脚本在该事件后打印过初始`DISPATCH_STARTED`状态；最终报告已根据保存的真实SSE纠正为`BLOCKED_UPSTREAM_SLIDE_VERIFICATION`，不能沿用该初始状态当已受理。

独立扣量/余额端点尚未验证。因此本次只能记录“提交尝试一次，额度是否扣减未知”，不声称余额仍为1或已变0。累计B账号授权为此前3次加本次1次，4次提交尝试均已使用；新增授权前不再发送创建。

## 4. 对开发计划的必要修正

1. **T02仍是核心实施门槛。** 账号页、菜单或已登录网页成功不能代替隔离Provider生成成功。发布前必须验证生成入口的正常动态参数、授权会话和验证要求。
2. 默认`browser-session`只是待实施验证的路径，不能表述为已证明可用的反代服务。`http-session`目前仅读取/上传通过，不能作为已可用的视频提交传输公开。
3. 增加错误类别`verification_required`：保存脱敏错误码、当前账号与attempt关联，账号进入待人工验证；不标记额度耗尽，不自动切换账号/出口，不自动重发创建。
4. HTTP200后仍要检查SSE业务事件。收到STREAM_ERROR时处理其结构化decision；收到SSE_REPLY_END时若没有ACK/任务身份，不得变成生成成功或无限轮询不存在的任务。
5. 验证挑战必须通过Dola官方正常流程处理。当前只返回不透明验证数据，没有可直接打开的验证URL；不能自行构造验证链接、破解挑战或绕过验证。完成官方验证后，如要再次创建，先明确新一轮授权和剩余额度。
6. 15/30秒参数扩展方法仍按11实施；当前阻塞发生在生成入口，修改时长或换模型不能被当作修复滑块验证的办法。

## 5. 复核与交接材料

- [本次脱敏证据](evidence/live/DOLA-HTTP-F005-I1.sanitized.json)：预检、完整功能参数、上传阶段、SSE错误、授权次数和已执行源码SHA-256。
- [账号提交账本](evidence/live/account-b-budget.json)：第四次明确授权及单次创建状态。
- `evidence/http-probe-source/probe.py.txt`：独立HTTP客户端、当前会话导入、能力与原会话查询。
- `evidence/http-probe-source/upload_prepare.py.txt`：申请新的上传会话。
- `evidence/http-probe-source/upload.py.txt`：botocore签名、二进制POST、commit和pre_handle。
- `evidence/http-probe-source/submit.py.txt`：生成完整请求、新身份与资源关联、独占创建锁和SSE读取。

上述`.py.txt`是**实际执行脚本的源码快照**，不是生产Provider，保留了固定研究路径和当时状态打印行为。仅用于审查与对照；不能直接重新运行`--dispatch`。新的实现应采用02的持久attempt/CAS和本页的错误终态合同，不能照搬本次实验的固定账号账本假设。会话/图片URI、签名和原始SSE不会作为凭据写入方案或Git。

本次新增/更新：本页、README最新状态、02错误/传输边界、04的T02与T04测试要求、05协议验收项、08缺口表、本次脱敏证据、四份研究源码快照、账号预算及捕获/文档检查清单。只做协议实验与文档，没有实施Dola渠道应用代码、修改数据库或部署。

## 6. 本轮文件清单

以下路径相对于`docs/dola-api-plan/`，另有注明者除外。

| 文件 | 改动 |
| --- | --- |
| `README.md` | 更新v1.1入口与独立HTTP真实结论、4次授权账本及接手顺序。 |
| `02-架构与数据契约.md` | 增加verification_required和HTTP200业务错误处理，收紧传输可用性结论。 |
| `03-界面与Canvas交互.md` | 更新计划版本与当前协议阻塞说明。 |
| `04-实施任务清单.md` | 将滑块验证/无ACK状态纳入T02实现门槛与测试。 |
| `05-测试验收与部署.md` | 增加本次真实SSE错误夹具和不得误判成功的断言。 |
| `08-协议缺口与补测交接.md` | 更新独立上传通过、生成验证阻塞及4/4授权状态。 |
| `10-双模型基线与比例验证.md` | 增加指向本次HTTP试验的后续历史说明。 |
| `12-独立HTTP协议实测.md` | 新增执行边界、逐项结果、错误分析、计划修正和交接报告。 |
| `evidence/live/DOLA-HTTP-F005-I1.sanitized.json` | 保存预检/上传/单次创建与verify/slide业务错误白名单证据。 |
| `evidence/live/account-b-budget.json` | 登记第四次明确授权、实际提交与扣量未知状态。 |
| `evidence/live/capture-manifest.json` | 登记新增捕获哈希和敏感临时文件清理。 |
| `evidence/live/document-validation.json` | 保存39份文档、JSON示例、源码哈希/AST与865项敏感值对照检查。 |
| `evidence/http-probe-source/probe.py.txt` | 保存实际HTTP预检客户端的无凭据源码快照。 |
| `evidence/http-probe-source/upload_prepare.py.txt` | 保存实际上传准备脚本的源码快照。 |
| `evidence/http-probe-source/upload.py.txt` | 保存标准SigV4签名、二进制上传及图片预处理脚本快照。 |
| `evidence/http-probe-source/submit.py.txt` | 保存单次创建保护、请求组装和SSE读取脚本快照。 |
| `docs/content/docs/progress/todo.mdx`（项目根相对） | 同步独立生成尚未通过与计划待实施状态。 |

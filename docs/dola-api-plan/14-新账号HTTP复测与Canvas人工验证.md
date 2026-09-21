# 新账号独立 HTTP 复测与 Canvas 人工验证方案

日期：2026-09-16。计划v1.3历史补充；最新传输结论见[15](15-IPWO直协议与Camoufox-Cookie会话实测.md)。用户提出在Canvas视频节点遇到滑块时弹出验证层人工处理，并明确授权更换账号后再试一次；当前应用已按本页的受限控制边界接入同页 Camoufox 验证。

**本页历史结果：新账号独立HTTP仍触发滑块；一次创建已执行，未重发。** 后续Cookie+Camoufox直连Case已取得SSE_ACK且无滑块，故生产主路径改为Camoufox page transport。Canvas弹层仍作为未来挑战的异常恢复功能；“官方挑战可在受限视图操作并恢复同一任务”尚未实测，不能标已解决。

## 1. 新账号实测

Case：`DOLA-HTTP-C-F005-I1`，匿名账号C。与此前B账号的`DOLA-HTTP-F005-I1`保持Fast/5秒/16:9/单图及同一种HTTP提交方式。新账号在用户浏览器登录；本轮只从其当前网络请求导入会话，所有能力读取、查询、上传、预处理和创建都由独立Python HTTPX执行，没有点击网页生成。

新旧请求中的账号身份Cookie及会话Cookie均不同；以当前账号已有主会话查询作预检，未拿B账号会话冒充新账号成功。Cookie值、账号名称和上游身份不写入公开证据。新账号重新上传自有参考图，不复用B账号图片URI。

| 步骤 | 结果 |
| --- | --- |
| 新账号身份 | 当前请求身份与此前B账号不同；已有会话查询成功 |
| 能力配置 | HTTP200、code0，读到`seedance_v2.0`和`seedance_v2.5` |
| 上传准备 | HTTP200、code0，取得新上传授权 |
| Apply / 二进制POST / Commit | 全部成功；新图960×540；二进制4,790字节 |
| pre_handle | HTTP200、code0，取得预处理结果 |
| 创建参数 | Fast `seedance_v2.0`，5秒，16:9，一张参考图 |
| 创建HTTP状态 | 200 |
| SSE | SSE_HEARTBEAT → STREAM_ERROR → SSE_REPLY_END |
| 业务错误 | 710022004，`rate limited`，decision `type=verify / subtype=slide` |
| 任务受理 | 没有SSE_ACK或生成任务ID |
| 扣量 | UNKNOWN，没有独立额度端点证明已扣或未扣 |
| 追加动作 | 无自动重发、无换号继续尝试、无生成媒体 |

请求仍未携带复制的`a_bogus/msToken`查询参数；Cookie中可能包含会话token，不能表述为所有token都没有。未实现当前网页动态签名；本次保持该边界以对照上次结果。

**本次历史实验当时只能得出：换账号没有消除独立HTTP提交方式遇到的验证要求。** 两个样本不能定位究竟是签名、设备/会话一致性、出口、请求特征或其他风控条件造成。后续15已经取得一次Camoufox ACK无滑块样本，但仍不能推断所有账号长期免验证。现在真正出现挑战时，Provider 会保留原页面并由任务所有者通过租约完成指针操作，验证通过后继续同一任务轮询。

[本次脱敏记录](evidence/live/DOLA-HTTP-C-F005-I1.sanitized.json) · [C账号1/1预算](evidence/live/account-c-budget.json) · [实际执行源码快照](evidence/http-c-probe-source/submit.py.txt)

四份`http-c-probe-source/*.py.txt`是研究快照，固定临时路径和已用掉的独占锁不得照搬生产；不能重跑`--dispatch`。原B账号4/4账本保持原状，C账号独立1/1，不混淆账号额度与请求次数。

## 2. Canvas弹层是否可行

可以作为产品方案：

```text
Canvas视频任务 → 独立HTTP创建 → 收到verify/slide
  → 暂停原任务、固定账号与attempt、创建verification记录
  → 当前任务所有者打开受限的官方挑战弹层
  → 人工完成滑块 → Provider取得真实官方结果
  → 同步原会话并核实原请求状态
  → 已受理则继续查询；明确可恢复且有授权才由唯一责任方恢复创建
  → 原任务/原视频节点更新结果
```

画布提交请求早已异步转成持久任务，不把HTTP响应一直悬挂到用户验证完成。任务状态事件携带不透明`verificationId`和可操作状态，前端按同一taskId更新原视频节点。

当前用户正停留在该画布且只有一个待处理挑战时，打开一次验证Modal；用户关闭后节点保留“完成验证”入口，不能每个SSE事件都反复弹窗。多任务同时遇到验证时只展示一个活动弹层，其余按实际待处理状态排队。刷新/重连从服务端恢复待验证状态，不再自动发送生成。

前端只能显示官方挑战区域。不能把`decision.detail`当成URL塞进iframe，也不能仅复制滑块HTML/图片自行拼一个验证组件。没有可直接打开的验证URL时，由Provider在绑定账号的真实浏览器环境中加载官方组件，使用13的受限图像/输入桥接。

因此“平时HTTP提交、必要时弹层人工验证”属于**浏览器辅助验证的HTTP渠道**，不承诺完全无浏览器。验证成功不等于独立HTTP创建必然恢复；仍需真实证明当前设备、登录态和官方动态参数可以延续。

## 3. 从管理员验证扩展到任务所有者

此项更新13早先“普通用户只等待管理员”的默认产品行为。Canvas任务所有者可以操作自己的任务挑战；管理员继续有后台处理入口。若官方界面无法可靠限制在挑战区域，退回“等待管理员处理”，禁止直接向用户开放整个账号浏览器。

约束和接口：

| 项目 | 实施要求 |
| --- | --- |
| 归属 | 每次请求校验当前用户Session、generationTask所属用户、当前Canvas项目权限、verification和attempt关联；不能仅凭verificationId放行 |
| 路由 | 在`/api/dola/requests/:requestId/verification`下提供GET状态及POST open/input/close/reconcile/resume，GET frames；没有账号列表/凭据/聊天记录权限 |
| 后台入口 | 原`/api/admin/dola/verifications/**`保留管理员职责校验；两种路由调用同一验证service |
| 可见范围 | 仅挑战框及必要状态，不返回Cookie、SDK原始数据、会话URL、浏览器调试地址或整页截图 |
| 可操作范围 | pointer仅在当前挑战区域有效；只接受验证所需键盘动作，不能操作地址栏、浏览器快捷键、账号菜单或导航 |
| 裁剪与坐标 | Provider输出真实挑战边界和viewportRevision；输入绑定同一revision并映射坐标；边界变化/挑战消失立即停止转发，不能点击到后面的聊天页面 |
| 控制权 | 同一挑战只允许一个有效控制租约；同账号其他用户不收到该视图，也不能抢占控制；管理员接管时撤销旧租约 |
| 任务恢复 | 原requestId、generationTaskId和Canvas节点不变；恢复创建作为新attempt关联原失败attempt；计费沿用同一业务任务 |
| 会话与隐私 | 原始challenge仅在Provider内存或加密短存，控制token仅前端内存；退出/换用户/项目失权立即断开 |
| 自动重发 | 13的resumeOwner互斥规则不变；用于HTTP验证的回调不得同时调用官方消息retry handler |

受限视图仍需在真实Dola挑战中验证，不能只用自己的假滑块或iframe mock作为上线依据。无法满足裁剪、归属和操作隔离时，不开放普通用户处理。

## 4. 追加任务和验收

- **T02-V**：先证明有效挑战能在原会话渲染、人工操作和取得官方成功；再验证独立HTTP恢复。当前只取得真实错误，尚未渲染或完成该挑战。
- **T03/T05**：verification增加request归属读取投影，提供任务状态事件；保留同业务任务、独立attempt、控制租约和未知结果核对。
- **T07**：Canvas视频节点已接入待验证状态和“完成验证”Modal；截图按 viewport 映射指针动作，关闭后不重发，处理完成后原节点回到轮询状态。
- **T08/T09**：管理员账号、日志和测试窗口仍可处理同一challenge，并准确展示操作者和恢复状态。
- **T13/T14**：测试越权、同账号多用户、控制转移、裁剪与pointer越界、退出/重连、页面变化、重复successCb、官方/后端双重重发；每项校验真实创建POST计数和业务计费次数。

拟新增`web/src/app/api/dola/requests/[requestId]/verification/**/route.ts`；Canvas页面私有组件放`web/src/app/(user)/canvas/components/`，用现有任务订阅与API服务入口，不创建第二套Canvas任务store。后台和Canvas共享协议/服务，界面保留各自布局。13中的service/repository复用，不再新增一套验证数据表。

后续真实验证若会恢复创建，必须纳入新的明确预算。本次用户授权的是新账号一次提交，已用完；不能把“人工验证弹层方案”当成无限恢复提交的授权。代码层已完成恢复桥接，真实挑战通过仍需用户在有额度时主动验收。

## 5. 本轮文件清单

| 路径（相对项目根） | 改动 |
| --- | --- |
| `docs/dola-api-plan/14-新账号HTTP复测与Canvas人工验证.md` | 新增本次HTTP结果、Canvas弹层权限和实施验收合同。 |
| `docs/dola-api-plan/13-滑块验证处理与会话恢复.md` | 将任务所有者受限验证纳入流程，后台处理作为保留入口。 |
| `docs/dola-api-plan/README.md` | 更新v1.3入口和新账号复测结论。 |
| `docs/dola-api-plan/02-架构与数据契约.md` | 补充普通用户的任务绑定验证接口及权限边界。 |
| `docs/dola-api-plan/03-界面与Canvas交互.md` | 增加Canvas受限官方验证弹层和原节点恢复行为。 |
| `docs/dola-api-plan/04-实施任务清单.md` | 把受限Canvas验证纳入T02-V、T07及跨用户验收。 |
| `docs/dola-api-plan/05-测试验收与部署.md` | 追加账号C真实fixture与Canvas验证权限/交互验收。 |
| `docs/dola-api-plan/08-协议缺口与补测交接.md` | 更新B/C独立预算和两次HTTP验证阻塞事实。 |
| `docs/dola-api-plan/12-独立HTTP协议实测.md` | 增加指向账号C复测的后续说明，不覆盖B账号原始记录。 |
| `docs/dola-api-plan/evidence/live/DOLA-HTTP-C-F005-I1.sanitized.json` | 保存新账号预检、上传、一次创建与真实验证错误。 |
| `docs/dola-api-plan/evidence/live/account-c-budget.json` | 记录新账号1/1授权尝试及禁止自动重发。 |
| `docs/dola-api-plan/evidence/http-c-probe-source/probe.py.txt` | 保存新账号会话与能力预检源码。 |
| `docs/dola-api-plan/evidence/http-c-probe-source/upload_prepare.py.txt` | 保存新账号上传准备源码。 |
| `docs/dola-api-plan/evidence/http-c-probe-source/upload.py.txt` | 保存标准签名上传与预处理源码。 |
| `docs/dola-api-plan/evidence/http-c-probe-source/submit.py.txt` | 保存单次提交保护、SSE业务错误分类及私有挑战隔离源码。 |
| `docs/dola-api-plan/evidence/live/capture-manifest.json` | 登记新捕获哈希及敏感原件清理。 |
| `docs/dola-api-plan/evidence/live/document-validation.json` | 更新文档、示例、源码哈希/AST和脱敏检查。 |
| `docs/content/docs/progress/todo.mdx` | 同步v1.3和Canvas人工验证待实施状态。 |

仅新增研究脚本快照、文档和脱敏证据；未修改应用源码、数据库、线上配置或现有Google AI Studio运行环境。

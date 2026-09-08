# IPWO 与统计报表交付核查（2026-09-08）

## 结论

- 已补齐此前审计指出的统计报表缺项：运行环境快照、调用活跃度热力图，并增加模型请求分布。沿用原项目时间桶及运行环境采样，不使用模拟业务数据。界面使用本项目 React / Ant Design 写法，不声明逐像素复刻。
- IPWO 尚未通过真实可用性验收。当前本机网络的真实测试已证明 API 提取成功、代理 TCP 端口可连接，但 HTTP CONNECT 隧道被中止，未取得目标 HTTP 响应。不能以日志开发完成代替线路可用。

## 真实 IPWO 证据与边界

本轮共执行三次单 IP 提取，没有修改用户保存的代理模式、开关、协议或凭据，没有调用 ChatGPT 生成，没有启用魔法代理串联。

1. 原测试路径：API 提取成功，ipinfo.io 在代理出口阶段返回 curl 56。
2. 独立对照：TCP 连接成功；同一代理访问 ipinfo.io 与 example.com，均返回 curl 56 / Proxy CONNECT aborted。
3. 协议对照：同一出口使用 HTTP 仍中止隧道，SOCKS5 返回 curl 97 握手失败。该结果不足以确定白名单、运营网络或供应商节点中哪项是唯一根因。

诊断现将该异常明确归类为“代理隧道连接被中止”，保留错误码且不输出 API 链接、代理地址或凭据。TLS 证书校验保持开启，不自动更换线路或重试。

[IPWO 官方海外网络说明](https://docs.ipwo.net/huan-jing-zhun-bei/hai-wai-wang-luo-huan-jing-shuo-ming) 明确要求海外网络环境。下一步需要已获授权的海外服务器验收入口及正确 IP 白名单，或供应商确认当前出口授权与节点可用；不要在聊天中提供密码。

## 报表行为

- 运行环境：应用 CPU、应用/系统/容器内存、数据盘、实例、系统/内核/架构、Python 版本、CPU 容量、启动时间、运行时长及网络吞吐快照。
- 保留原项目平台支持边界：macOS 下部分内存与网络采样不支持时显示“—”；首次 CPU/网络采样没有差分时不伪造零值。
- 调用活跃度：按当前 24 小时 / 7 天 / 30 天范围显示真实请求时间桶，支持悬停、键盘聚焦、点击查看次数。
- 模型请求分布：仅汇总成功及部分成功请求，显示数量和占比；保留原有结果趋势、成功率、账号切换统计及模型耗时表。
- 管理员权限仍由现有管理桥控制；额度刷新请求不混入生成统计。

## 验证

- Python 全量 39 项通过，含实际内部路由、运行环境采样、缓存、容器限额及脱敏错误分类；2 条第三方弃用警告。
- Web 全量 2978 项通过，10 项按环境跳过；生产构建、类型检查、ESLint 通过。
- 生产模式浏览器回归通过：1440 / 390 / 430px、浅深主题、运行环境、活跃度点击详情、七个 Tab 及原有代理互斥流程。
- 本地 3333 生产服务重启、健康接口 HTTP 200。不构建 Docker、不提交或 push、不制作服务器部署包。
- 没有执行真实 ChatGPT 生成及完整 Canvas/图片/视频业务回归；这不属于此次两项任务的实测范围。

## 修改文件

- `services/chatgpt-api/services/runtime_environment_service.py`：移植原生资源采样。
- `services/chatgpt-api/utils/container_runtime.py`：移植容器识别。
- `services/chatgpt-api/api/integration.py`：统计接口附带运行环境快照。
- `services/chatgpt-api/services/ipwo_proxy_service.py`：明确 CONNECT aborted 的安全错误说明。
- `services/chatgpt-api/UPSTREAM-SOURCE-MANIFEST.sha256`：登记新增来源文件校验和。
- `services/chatgpt-api/tests/test_runtime_environment.py`：覆盖真实采样语义和限额。
- `services/chatgpt-api/tests/test_runtime_contract.py`：验证统计路由的新字段。
- `services/chatgpt-api/tests/test_ipwo_proxy_service.py`：验证中止错误分类与脱敏。
- `web/src/services/api/chatgpt-api.ts`：运行环境响应类型。
- `web/src/app/admin/chatgpt-api/components/chatgpt-statistics.tsx`：补齐运行环境、活跃度和模型分布展示。
- `web/e2e/chatgpt-api.spec.ts`：统计控件及响应式回归。
- `docs/chatgpt-api-integration.md`：同步已补齐的报表范围。
- `docs/ipwo-statistics-delivery-20260908.md`：交付结果、实测证据与未完成条件。

# Luna 原子任务卡

执行者默认Luna，按依赖顺序逐项执行。不需要新建其他任务或子代理。文件列表是允许修改的责任边界；目录项需先解析到实际文件并填入台账。现有多人/用户工作区改动必须保留。每卡开工前再读所属AGENTS，明确“本卡修改→相关测试→生产构建重启→浏览器证据”的批次。任务卡已按依赖执行并持续回写 `任务状态.csv`：截至 2026-09-15，T00–T13、T20–T21、T24–T25 有实际通过证据；T14–T18、T22、T23 仍为 IN_PROGRESS，T19 为 BLOCKED。当前 Playwright 发现 218 条/18 个文件，完整隔离 E2E 为 201 通过、17 跳过；内容库分页/编辑/删除/加载/失败状态、Canvas 生命周期回归和短剧音频/整集合成 fixture 回归已补充。未完成卡片不得引用默认矩阵或外部错误态代替有效业务状态。V2.1新增必读06及配色令牌计划.json；所有UI任务均须通过A17，不能只完成生成按钮替换。

## T00 冻结工作区和可恢复备份

- 依赖：无。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`AGENTS.md`；`web/package.json`；`web/playwright.config.ts`。
- 操作顺序：记录pwd -P、Git HEAD、全部tracked/untracked差异和当前服务端口/进程cwd；保留Docker/代理等既有修改。创建带时间戳的前端源码和public资源备份，保存路径与SHA256；敏感配置单独本地保管，报告只写是否存在，不输出值。备份解压到临时目录并比对抽样文件，不覆盖当前工作区。
- 验证与产物：交付baseline.json、backup-manifest；有当前服务构建身份与还原方法；禁止把旧origin差异全部认定为本次修改。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T01 建立当前8项失败基线

- 依赖：T00。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/e2e/support.ts`；`web/e2e/home.spec.ts`；`web/e2e/canvas.spec.ts`；`web/e2e/installation.spec.ts`。
- 操作顺序：读取已有测试安装/登录/fixture流程，准备隔离数据目录和空闲端口；以当前源码生产构建启动。匿名首页、登录/create、Canvas节点各复现对应截图状态；记录真实视口、主题、URL、currentSrc、焦点与DOM边界；保存失败基线。使用正常点击输入，不能force。
- 验证与产物：D01–D07各有复现截图和测量JSON或明确无法复现原因；旧用户截图保留，不能覆盖；当前无法复现不等于用户反馈已解决。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T02 清点资源和所有生成调用点

- 依赖：T00。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/components/ui/dreamyo-icon.tsx`；`web/src/components/layout/site-logo.tsx`；`web/src/app/home/home-agent-hero.tsx`；`web/src/components/generation-action-button.tsx`。
- 操作顺序：先核对B01/C01有效参考及manifest；旧08仅历史。读236项素材表，核对源文件尺寸、Alpha、本体留白、烘焙文字；将每项标为采用/派生/设计参考/不适用并写理由。扫描所有GenerationActionButton和自定义生成/发送按钮，补全调用点清单；扫描SiteLogo及直接logo img、docs资源。
- 验证与产物：调用点覆盖首页独立Send、Agent两种布局、Canvas/短剧/弹窗；资源每项有语义和目标尺寸，不能因表有行就算已使用。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T03 B01生成按钮资源定稿

- 依赖：T02。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/public/brand/dreamyo/generation/（新增）`。
- 操作顺序：按02规格C处理用户B01，先找同源拆分文件；没有则使用图像编辑工具分离无文字底板与白星圆点，保留原始风格。保留原图与产物哈希；白星不得沿用magic.png。将各产物置于36/40/44px按钮真实大小及DPR1/2检查，宽按钮检查无拉伸。
- 验证与产物：新增资源真实透明、白星清晰、没有烘焙字残留；产物与B01并排比较合格。资源未合格不得进入按钮推广任务。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T04 Logo透明资源与回退链

- 依赖：T01, T02。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/components/layout/site-logo.tsx`；`web/src/components/layout/site-logo.test.tsx`；`web/src/app/home/home.module.css`；`web/public/brand/dreamyo/`。
- 操作顺序：定位D01的实际src和资源；拆开外层尺寸class与img，消除重复drop-shadow。检查默认透明Logo在五种底色上效果，必要时从同源干净母图派生。修正通用/深色配置选择顺序与各自失败回退；检查导航、侧栏、助手、后台和docs是否走同一契约。
- 验证与产物：A01通过；用真实自定义通用/深色两个不同fixture图测试，404只影响对应资源；主题切换、刷新和原始Alpha均检查。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T05 按C01重建语义配色并收敛样式所有权

- 依赖：T01。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/lib/app-theme.ts`；`web/src/lib/canvas-theme.ts`；`web/src/app/globals.css`；`web/src/app/styles/global-product-design.css`；`web/src/app/styles/global-generation-actions.css`；`web/src/app/styles/global-canvas-overrides.css`。
- 操作顺序：先按06和配色令牌计划.json把C01映射到Ant/Canvas/页面/状态，产出首页、/create、Canvas、后台四个同源配色样例。列出同一控件所有颜色/尺寸/优先级来源；按02规格把主题值放回既有拥有者。将生成按钮规则归一至global-generation-actions；从global-product-design删除其按钮尺寸/颜色重复覆盖及toolbar PNG放大规则，保留真实跨页样式。不要删除未理解的业务样式。
- 验证与产物：样式来源表可解释最终规则；无跨页新增48px/min-height46强制覆盖；antd、Tailwind、CSS Modules全部以最终computed style验证。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T06 实现生成按钮变体和状态

- 依赖：T03, T05。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/components/generation-action-button.tsx`；`web/src/components/generation-action-button.test.ts`；`web/src/app/styles/global-generation-actions.css`。
- 操作顺序：沿原组件增加compact/standard密度，保留appearance/block与真实ButtonProps。接入B01底板和白星；文字DOM、aria-label独立。ready/loading/running/cancellable/disabled只有一个主状态图标；消除antd自动spinner与手工图标重复。实现36/40/44规格及focus-visible，禁止hover扩大布局。
- 验证与产物：A03/A04通过；测试点击、禁用不触发、运行停止回调、状态图标数量及文本可访问；把源码字符串断言改为真实渲染/行为，不写expect源码包含某PNG来代替视觉。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T07 背景资源与浅色轻动效

- 依赖：T02, T05。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/home/home-agent-hero.module.css`；`web/src/app/home/home-agent-hero.tsx`；`web/src/app/(user)/create/create-studio.module.css`；`web/src/app/(user)/create/page.tsx`。
- 操作顺序：/create/page.tsx第665行附近直接挂载landingBackdrop与particle-infinity.mp4；在此处切换主题背景资源。浅色采用按C01蓝青薄荷淡紫层次、且通过清晰度检查的同源背景，去除dark粒子视频+白veil合成；深色单独保留可读版本。只在背景层使用不超过两层轻位移/透明动画；加入reduced-motion、不可见暂停及资源失败静态降级。
- 验证与产物：A07通过；浅色首帧、动态三个时点、失败与减少动态截图均清晰；不得用CSS画出替代品牌插画或删去所有背景装作完成。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T08 修复/create输入与所有弹层

- 依赖：T05, T06, T07。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/(user)/create/create-studio.module.css`；`web/src/app/(user)/create/components/creative-composer.tsx`；`web/src/components/creative-composer-styles.ts`。
- 操作顺序：移除D02无主题限定!important正文；分别定义文本/placeholder/caret/selection/focus。生成参数图标用Settings2，保留Lightbulb/Orbit语义。替换两处实际发送布局为44px新按钮；工具左侧横滚，发送独立。保留四类型、附件角色、模型Skill和优化提示词全部行为，检查Portal主题。
- 验证与产物：A02/A04/A08；中文IME、编辑选择、提交、附件缩略图、四模式和各参数弹层正常；草稿水合/新对话不回归；不点击真实付费上游。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T09 首页浅色完整面板重建

- 依赖：T04, T05, T06, T07。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/home/home-agent-hero.module.css`；`web/src/app/home/home-agent-hero.tsx`；`web/src/app/home/home-header.tsx`；`web/src/app/home/home.module.css`；`web/src/app/home/home-data.ts`。
- 操作顺序：默认--hero-panel/soft/text/muted/line改为浅色，dark完整覆盖。逐一修复建议词、Skill/模型picker、模式选择、快捷入口、footer CTA；首页独立Send改共享B01按钮。小控件图标统一线性；大插画不冒充工具。按02规格处理移动首屏密度。品牌中文文案按旧计划映射核对，不擅改用户内容。
- 验证与产物：A02/A03/A07/A09；匿名首页两主题、刷新与登录后承接草稿通过；Skill/模型弹层与快捷板不得仍为深色；保留下方正常滚动。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T10 Canvas dock统一单色工具图标

- 依赖：T05。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/(user)/canvas/components/canvas-toolbar.tsx`；`web/src/app/styles/global-product-design.css`。
- 操作顺序：将dock的image/video/audio PNG改回同套Lucide图标，与Type/Hand等统一18px和笔画。保留provider logo例外；清理仅给dock图片加22px的CSS。检查选中、hover、disabled、tooltip、暗浅与移动命中区域。
- 验证与产物：A05；每个工具有明确语义名称；新建图片/视频/音频节点和撤销重做可操作，操作与图标对应。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T11 Canvas紧凑/整行生成按钮与裁切

- 依赖：T06, T10。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx`；`web/src/app/(user)/canvas/components/canvas-config-node-panel.tsx`；`web/src/app/(user)/canvas/components/canvas-config-composer.tsx`；`web/src/app/(user)/canvas/components/canvas-interior-design-node-panel.tsx`；`web/src/app/(user)/canvas/components/canvas-node-angle-dialog.tsx`；`web/src/app/(user)/canvas/components/canvas-node-upscale-dialog.tsx`；`web/src/app/(user)/canvas/components/canvas-node-mask-edit-dialog.tsx`；`web/src/app/(user)/canvas/components/canvas-storyboard-dialog.tsx`。
- 操作顺序：节点提示底栏改56px border-box、上下≥6px，按钮icon compact40px flex:none；成本外置中性摘要。配置节点使用44px block白星+开始生成，移除按钮内CreditSymbol重复图形。所有生成弹窗/节点调用显式密度；逐层测overflow和屏幕尺度，不直接全站overflow-visible。
- 验证与产物：A03/A04/A10；小节点/长模型名/字数提示/关联连线/缩放时按钮四角可见；开始/停止/失败重试走原逻辑且只发一次fixture请求。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T12 Canvas媒体外缘选中框

- 依赖：T01, T05。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/(user)/canvas/components/canvas-node.tsx`；`web/src/app/(user)/canvas/components/canvas-node-content.tsx`；`web/src/lib/canvas-theme.ts`；`web/src/app/(user)/canvas/components/canvas-node.test.tsx`。
- 操作顺序：按02规格E用实际媒体壳外缘取代百分比内缩；统一圆角、区分媒体裁切层/外侧边框/端口工具层。保留批次节点展开、标题、尺寸拖动与连线事件。所有装饰pointer-events:none，不能改变保存的节点坐标/媒体真实宽高。
- 验证与产物：A06/A10；横竖方图与不同节点尺寸的四边差≤1屏幕CSS px；测笔画不是只测svg根；选择、拖动、连线、resize后立即drag及刷新恢复通过。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T13 8项专项对照复核

- 依赖：T04, T08, T09, T10, T11, T12。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/e2e/canvas.spec.ts`；`web/e2e/home.spec.ts`；`docs/ui-rebuild-20260913/evidence/`。
- 操作顺序：逐D01–D08保存同主题/视口/节点尺度的after和combined比较图，记录computed style、currentSrc、输入焦点、边框实测与按钮命中。截图4必须还原提示输入面板，不可用配置节点按钮代替；图7必须匿名首页，不可用/create代替。
- 验证与产物：八项分别PASS且A01–A10及A17的适用项全部有证据；任何一项失败回对应任务修复，不传播通过状态。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T14 全局品牌入口与认证静态页

- 依赖：T04, T05。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/components/layout/`；`web/src/app/login/`；`web/src/app/register/`；`web/src/app/forgot-password/`；`web/src/app/install/`；`web/src/app/announcements/`；`web/src/app/privacy/`；`web/src/app/terms/`；`web/src/app/not-found.tsx`；`web/src/app/global-error.tsx`；`web/src/app/(user)/error.tsx`。
- 操作顺序：逐页面矩阵检查外壳、表单、错误、Logo、favicon、浅深主题、真实文本输入和内部滚动。认证页使用匿名上下文，安装页使用未初始化fixture。用户工作区抽屉与头像fallback一致；error/404可返回真实路径。
- 验证与产物：A01/A02/A08/A11；登录/注册重定向不能算表单已验收；法定主体和第三方归属不作品牌替换。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T15 内容库与个人账户全覆盖

- 依赖：T05。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/(user)/assets/page.tsx`；`web/src/app/(user)/prompts/page.tsx`；`web/src/components/my-prompts/my-prompts-page.tsx`；`web/src/app/(user)/works/page.tsx`；`web/src/app/(user)/community/page.tsx`；`web/src/app/(user)/me/page.tsx`；`web/src/app/(user)/profile/page.tsx`；`web/src/app/(user)/help/page.tsx`；`web/src/app/u/[username]/page.tsx`；`web/src/app/share/[slug]/page.tsx`；`web/src/app/(user)/billing/`。
- 操作顺序：按列表/卡片模板逐页检查标题、搜索、筛选、空/加载/失败/有效数据、preview和Modal。付费/订单在fixture实例验证；作品分享使用真实fixture记录，不硬猜slug。图标分类和正文颜色一致，手机卡片紧凑。
- 验证与产物：A08/A11/A12；瀑布流首行从左到右、最短列填充；真实媒体比例、下载/引用/分类正确；完整记录NOT_APPLICABLE的重定向。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T16 短剧完整生产与生成图标

- 依赖：T06, T11。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/app/(user)/drama/`；`web/src/app/(user)/drama/[id]/drama-project-sections.tsx`；`web/src/app/(user)/drama/[id]/drama-generation-panel.tsx`；`web/src/app/(user)/drama/[id]/drama-asset-editor-drawer.tsx`；`web/src/app/(user)/drama/[id]/drama-review-panel.tsx`；`web/src/app/(user)/drama/[id]/drama-scene-structure.tsx`。
- 操作顺序：短剧所有共享生成按钮显式compact/standard；剧本/审核/分镜/生成四阶段与项目资产主题统一；按规范保留桌面集列表和右侧设置、全局Agent入口。分析/审核/重试等动作按真实语义保留覆盖图标，不一律改白星。
- 验证与产物：A03/A04/A08/A12；1672/1440及390/430操作阶段与抽屉，生成阻塞/单镜头重试、资产归属和保存刷新不回归。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T17 后台模板与品牌设置验证

- 依赖：T04, T05。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/components/admin/admin-dashboard.tsx`；`web/src/components/admin/admin-section-nav.tsx`；`web/src/components/admin/admin-site-preview.tsx`；`web/src/app/styles/global-admin-theme.css`；`web/src/app/styles/global-admin-responsive.css`；`web/src/lib/app-theme.ts`。
- 操作顺序：按02规格G落实壳/看板/列表/配置四模板，真实现有六分组不因任务再改业务归属。品牌设置预览用深浅两种实际背景，保存/删除/失败回退纳入真实持久化测试。页面私有布局保留当地，主题集中配置。
- 验证与产物：A01/A08/A13；四模板两主题桌面手机各一份证据，Drawer≤视口，公开ID和权限正确，所有模板可复制到剩余分区。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T18 后台经营商品财务分区逐项落实

- 依赖：T17。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/components/admin/`；`web/src/app/admin/billing/`；`web/src/app/admin/generation-operations/`。
- 操作顺序：使用页面矩阵中经营分析/商品运营/财务管理的全部section逐项打开，分别验证数据、筛选、创建/编辑/详情、loading/错误、金额与状态。先定位admin-dashboard的惰性映射到实际私有文件，记录后编辑，不让单个模块导入整个后台。
- 验证与产物：A13；每个分区独立证据，不允许以六组导航可见替代全部页面；保存删除检查立即/API/刷新/服务端四状态。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T19 后台上游系统内容分区逐项落实

- 依赖：T17。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/components/admin/`；`web/src/app/admin/`；`web/src/components/admin/admin-local-media-storage.tsx`。
- 操作顺序：逐上游配置、系统管理、内容运营及辅助页面，处理单色工具图标、短字段网格、长密钥字段、列表与Drawer。权限/脱敏/真实用户ID不变；媒体源图不可直接作为列表src。没有第三方授权只验未授权状态并标明业务数据状态缺口。
- 验证与产物：A13；36个section全部有矩阵状态，真实不可用项BLOCKED；站点设置删除不被并发保护误判而恢复。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T20 命名、文案、元数据与文档站复核

- 依赖：T04, T14, T15, T16, T18, T19。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/src/lib/page-titles.ts`；`web/src/lib/page-titles.test.ts`；`web/src/lib/site-brand.ts`；`web/src/app/layout.tsx`；`web/src/app/manifest.ts`；`web/src/lib/server/site-metadata.ts`；`docs/src/`；`docs/public/`；`README.md`；`package.json`；`Dockerfile`；`docker-compose.yml`；`.github/workflows/`。
- 操作顺序：覆盖旧计划全部品牌与部署契约，扫描项目归属旧词及文件名、环境变量/内部头/镜像引用，输出例外清单。逐页面同时读取document.title和主要标题；后台section标题分别对比真实label。区分配置自定义名、用户内容、第三方品牌；核对图标请求和文档独立构建。外部Git/镜像是否改名用read-only事实记录。
- 验证与产物：A11/A14；每个旧名命中有归属/动作；禁止更改Git历史/用户项目标题以造零命中；外部镜像已发布需有实际摘要和可拉取证据。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T21 将关键验收写成真实回归测试

- 依赖：T13。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/e2e/ui-rebuild.spec.ts（新增）`；`web/playwright.config.ts`；`web/e2e/support.ts`；`web/src/components/generation-action-button.test.ts`；`web/src/components/layout/site-logo.test.tsx`；`web/src/lib/canvas-theme.test.ts`。
- 操作顺序：实现04手册A01–A17关键行为断言并注册新spec到chromium/mobile testMatch；现配置不自动运行ui-rebuild.spec.ts，必须显式更新。先用--list确认用例被发现。按fixture真实请求与浏览器矩形断言，保留失败trace；测试不能修改页面CSS来制造目标效果。
- 验证与产物：新spec出现在三个目标项目测试列表；有首次失败到修复通过的记录；禁用force/waitForTimeout和仅源码字符串断言作为验收。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T22 全视口主题与状态矩阵完成

- 依赖：T14, T15, T16, T18, T19, T20, T21。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/e2e/ui-rebuild.spec.ts（新增）`；`web/e2e/responsive.spec.ts`；`docs/ui-rebuild-20260913/视口主题验收.csv`。
- 操作顺序：实际设置7组视口并验证innerWidth与visualViewport；用户路由与后台分区各两主题截图。核心组件增加states、Canvas zoom、DPR、减少动态。长列表滚动到下半部打开弹窗，不能只截首屏。逐格记录URL/状态/截图/测量JSON/日志及结论。
- 验证与产物：A01–A17；矩阵没有空格或无理由跳过；新增路由同步补行；任意BLOCKED则不允许宣称全量通过。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T23 完整质量与运行门禁

- 依赖：T22。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`web/package.json`；`web/scripts/release-check.mjs`；`docs/package.json`。
- 操作顺序：按04手册运行测试、lint、typecheck、格式和diff检查、生产build、E2E及docs检查。check:release若在audit早退，后续检查独立跑并记录；不得把历史18条漏洞/163文件直接复制成当前结果。以实际端口设置内部origin启动生产服务，验证health/live/ready、静态资源、worker心跳。
- 验证与产物：A14/A15；区分通过/失败/跳过及基线问题，不掩盖生产readiness失败；无来源截图不能标PASS。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T24 只打包本次实际修改与资源闭包

- 依赖：T23。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`本次修改需上传文件_YYYYMMDD/（执行日生成）`。
- 操作顺序：基于T00差异边界列本次真实修改，必要已完成品牌依赖单独说明，不把origin以来代理/后端无关提交自动打入。按AGENTS删除同名旧包重建；保留项目目录、派生资源、manifest、SHA256和废弃资源清单。排除配置secret、数据库、测试账号、用户截图及设计母图。核对容器/standalone完整引用与回滚备份。
- 验证与产物：A16；包与当前源码逐字节一致；所有引用资源存在；部署源包需附build/start步骤，不能冒充已编译覆盖即用包；未执行线上部署须明确。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。

## T25 交付与对旧结论纠正

- 依赖：T24。
- 输入：02设计规格、01问题证据、04验收手册及当前代码。
- 文件责任：`design-qa.md`；`docs/ui-rebuild-20260913/交付报告.md（执行时新增）`；`docs/ui-rebuild-20260913/任务状态.csv`。
- 操作顺序：逐D01–D08报告before/after与几何和交互证据；其余路由、后台、品牌/命名提供覆盖数。列每个实际改动文件+一句说明、测试日志、未验项和外部发布状态；持续保存当前生产预览信息，不把测试实例停机后只给死链。所有PASS有可打开证据。
- 验证与产物：报告不宣称保证零BUG；只有证据覆盖部分可称通过；总任务存在BLOCKED时明确未完整交付。
- 必须保留：当前事件、数据、权限和状态语义；不回滚既有修改。
- 失败处理：保持本卡IN_PROGRESS或注明外部原因BLOCKED；修复/补证据后再置PASS，下游不能引用未通过结果。
- 交接记录：实际文件差异、命令及退出码、截图路径、测量结果、未决项，写回任务状态.csv；不可只填“已优化”。


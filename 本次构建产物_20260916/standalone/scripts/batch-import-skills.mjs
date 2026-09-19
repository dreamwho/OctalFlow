import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const sourceRoot = "/Users/dream/Desktop/AI开发/生图生视频Skill工作台";
const definitions = [
    {
        id: "skill-drama-pipeline",
        name: "短剧全流程导演",
        description: "把小说或剧情需求依次拆成大纲、角色、场景道具、剧本、分镜和视频投产包，并在各阶段执行连续性与质量检查。",
        plannerSummary: "用户需要小说改短剧、漫剧一键生产、全流程拆解、角色场景分镜联动或整集视频规划时使用。",
        instructions: lines(
            "先确认总集数、单集时长、题材、改编幅度和必须保留的角色或情节；信息不足时采用明确标注的默认值。",
            "大纲阶段输出改编取舍、角色分档、主场景、叙事道具、爽点时间轴和分集梗概，关键取舍必须能回指用户素材。",
            "控制角色与场景规模：合并功能重复的人物，主场景数量随集数增长，优先用同一场景的时段或状态变体保持一致性。",
            "每集必须有可见的开场钩子、核心冲突或爽点、结尾悬念；连续三集内不得出现无有效推进的剧情真空。",
            "角色阶段沿用大纲中的稳定角色标识与重要度，不重新改写上游已经确认的角色清单和人物弧。",
            "为主要角色建立外形锚点、服装状态、性格动作、说话方式、音色和角色设定图，并检查同批角色的可辨识差异。",
            "场景阶段为每个空间建立三至五个可画、可认、可核对的一致性锚点，以及剧情实际需要的光照时段变体。",
            "叙事道具只保留会被特写、跨集复用或承载剧情的对象，并为其尺度、状态变体和白底无手设定图建立约束。",
            "剧本按动作节拍与台词交替组织；台词应口语化且符合人物，每场至少一个可生成动作节拍，单集时长控制在目标的合理容差内。",
            "把每集钩子落实为前三个节拍内可拍的具体画面，把结尾悬念落实为最后一个动作或台词，不只写抽象标签。",
            "分镜先按不跨场的剧情段拆成每段九至十五秒，再把段内切成二至五秒镜头；每个剧本节拍必须被一个镜头按顺序认领。",
            "正反打、关键动作特写、建立镜头和反应镜头按叙事目的使用；同一镜头原则上不超过三名主要人物。",
            "每个生成段必须绑定场景基准图、出镜角色设定图、必要道具图和对应光照状态，引用丢失时阻止生成并指出缺失项。",
            "分镜图先验证第一段的完整镜头组，确认画风、角色一致性和构图后再批量生成后续镜头。",
            "每段生成前检查时长、台词容纳、镜头切点、角色场景道具引用、画风一致性和上游状态；失败项必须精确到集、场、段或镜头。",
            "用户选择一键生成时仍保留阶段数据和质量门，自动通过合格阶段；需要人工判断或存在阻塞时停在对应阶段，不用模糊成功状态掩盖问题。",
        ),
        keywords: ["短剧", "漫剧", "小说改编", "角色", "场景", "剧本", "分镜", "镜头", "一键生成"],
        workspaces: ["image", "video", "canvas", "drama"],
        defaultConfig: { size: "16:9", quality: "high", vquality: "1080", count: 1, videoSeconds: 15 },
        file: "短剧全流程skills-main.zip",
        sourcePath: "skills/novel-outline + novel-characters + novel-art + novel-script + novel-storyboard/SKILL.md",
        license: "Apache-2.0",
    },
    {
        id: "skill-character-casting",
        name: "角色选角与定妆",
        description: "从剧本和人物小传建立可信的真人选角、面部身份锚点、服装状态与角色三视图，降低塑料感和人物漂移。",
        plannerSummary: "需要生成角色基准图、选角方向、定妆照、人物三视图或跨镜头身份一致性时使用。",
        instructions: lines(
            "先从剧情提取角色年龄区间、地域与时代背景、职业阶层、人物弧、关系压力和可见生活痕迹，再决定外形。",
            "选角应服务人物而不是追求统一精致：保留年龄纹理、毛孔、轻微不对称、疲态或风吹日晒等可信细节。",
            "为每名角色建立稳定的面部身份锚点，包括脸型、眉眼距离、鼻口比例、发际线、发型和辨识度最高的局部特征。",
            "同批主要角色必须在轮廓、年龄感、气质、发型和服装色块上可快速区分，避免换装后认不出。",
            "服装与妆发必须由时代、职业、经济状况、场景状态和剧情阶段共同决定，并记录可复用的状态变体。",
            "先生成中性光线、中性表情、无遮挡的面部与半身基准图，再生成正面、侧面、背面的全身三视图。",
            "三视图与半身像必须保持同一张脸、协调身体比例、同一套服装结构和一致的年龄痕迹。",
            "角色图中避免蜡像皮肤、过度磨皮、同质化网红脸、夸张美容妆、无依据的奢华服装和随机配饰。",
            "需要戏剧状态图时只改变表情、姿态、妆发损耗或服装状态，不改变面部身份和基础身材。",
            "交付前检查角色是否符合素材证据、是否与其他角色撞脸、是否能被场景与分镜作为稳定参考图复用。",
        ),
        keywords: ["选角", "角色", "定妆", "人物设定", "三视图", "真人感", "一致性"],
        workspaces: ["image", "canvas", "drama"],
        defaultConfig: { size: "16:9", quality: "high", count: 3 },
        file: "character-casting-选角skill.zip",
        sourcePath: "character-casting-studio-skill-main/SKILL.md",
        license: "本地来源未声明",
    },
    {
        id: "skill-cinema-dna-21x9",
        name: "电影感宽画幅生图",
        description: "把场景与分镜画面优化为具有叙事压力、视线流、光影层次和真实镜头质感的 21:9 电影剧照。",
        plannerSummary: "需要电影感场景图、21:9 宽画幅、叙事构图、人物关系压力、光影或去除 AI 塑料感时使用。",
        instructions: lines(
            "先明确画面要表达的人物关系、冲突压力和观众第一眼应看到的信息，再选择景别与构图。",
            "用前景、中景、后景建立空间纵深，并让遮挡、门框、窗框、家具或环境线条参与叙事，而不是只做装饰。",
            "人物站位、头部朝向和视线应形成清晰的视线流；关系紧张时用距离、边缘压迫和负空间表达。",
            "光线必须有可解释来源，主光、环境光和轮廓光服务剧情时段与情绪，不使用无来源的均匀棚拍亮光。",
            "色彩先确定主导色温与叙事色，再用小面积对比色引导注意力，避免全画面堆叠高饱和色。",
            "宽画幅不是把主体缩小居中；根据对话、追逐、孤立或环境压迫选择偏置构图、对称构图或横向动线。",
            "镜头质感应保留真实镜头的景深、焦点层级、适度高光滚降、空气透视和材质细节，避免过度锐化与假 HDR。",
            "人物皮肤、织物、墙面、金属和地面要有各自材质响应，禁止塑料皮肤、无纹理表面和统一反光。",
            "连续场景图必须复用场景锚点、角色基准图、服装状态和光照状态，只改变当前镜头的动作与取景。",
            "交付前检查叙事焦点、视线方向、主体边缘、透视、手部、面部、光源逻辑和画面中是否存在无意义的视觉噪声。",
        ),
        keywords: ["电影感", "宽画幅", "光影", "构图", "镜头", "场景", "剧照", "叙事"],
        workspaces: ["image", "canvas", "drama"],
        defaultConfig: { size: "21:9", quality: "high", count: 1 },
        file: "cinema-dna-21x9x3-main (电影感生图).zip",
        sourcePath: "cinema-dna-21x9x3-main/SKILL.md",
        license: "本地来源未声明",
    },
    {
        id: "skill-ai-micro-expressions",
        name: "人物微表情表演",
        description: "根据剧情因果、心理压力与克制程度设计可见但不过度的眼神、嘴角、呼吸、停顿和细小动作。",
        plannerSummary: "人物需要复杂情绪、克制表演、微表情、反应镜头或细微动作时间线时使用。",
        instructions: lines(
            "先写清触发事件、角色即时判断、不能公开表达的情绪和当前行为目标，表情必须由剧情因果产生。",
            "用心理压力、外显强度、控制程度三个维度确定表演范围，避免只写高兴、悲伤、愤怒等抽象情绪词。",
            "把情绪拆成眼神焦点、眨眼频率、眉间张力、嘴角控制、下颌紧绷、呼吸变化和肩颈姿态等可见信号。",
            "每个镜头只保留一至三个主导信号，其他细节作为轻微辅助，避免所有五官同时夸张变化。",
            "微表情按时间线组织为触发、迟滞、泄露、压回和余波；短镜头优先选择最能讲清转折的两个阶段。",
            "对白表演要区分说出口的内容与真实意图，停顿、吞咽、移开视线或重新对焦应服务潜台词。",
            "反应镜头优先捕捉听到信息后的第一反应，再表现角色重新控制表情，避免从头到尾保持单一表情。",
            "镜头越近，动作幅度越小；特写使用细微眼神与肌肉变化，中景再加入手部、肩颈和身体重心。",
            "保持角色面部身份、年龄纹理和既定气质，不因情绪强烈而改变脸型、五官比例或皮肤质感。",
            "负面约束包括夸张抽搐、卡通表情、无原因流泪、持续瞪眼、机械眨眼、嘴型失控和情绪与台词不一致。",
        ),
        keywords: ["微表情", "表演", "情绪", "眼神", "潜台词", "反应镜头", "人物"],
        workspaces: ["image", "video", "canvas", "drama"],
        defaultConfig: { size: "16:9", quality: "high", count: 1, videoSeconds: 5 },
        file: "181.AI表情skill/AI表情SKILL/seedance-prompt-单skill整合版本.zip",
        sourceLabel: "181.AI表情skill",
        sourcePath: "AI表情SKILL/seedance-prompt-单skill整合版本.zip · seedance-prompt-master/SKILL.md",
        license: "本地来源未声明",
    },
    {
        id: "skill-seedance-director",
        name: "视频导演与控镜",
        description: "从剧本与参考素材编排镜头、运镜、动作、光线、声音和连续性，生成可执行的视频导演提示词。",
        plannerSummary: "需要视频镜头设计、运镜、动作编排、角色一致性、灯光、声画关系或长剧情分段时使用。",
        instructions: lines(
            "先判断任务是文生视频、图生视频、首尾帧、续写还是多参考生成，并只使用当前模式真实提供的素材。",
            "先固定主体身份、场景锚点、时间、服装状态和画面目标，再设计镜头运动与动作时间线。",
            "镜头描述按景别、机位、镜头焦段、主体动作、摄影机运动、光线变化和结束状态组织，避免只堆风格词。",
            "动作必须符合身体惯性、空间位置和前后镜头连续性；复杂动作拆成可观察的起势、过程、落点与余波。",
            "角色一致性依靠参考图、稳定面部锚点、服装和姿态约束，不用重复堆叠人名或模糊的保持一致。",
            "镜头运动应有叙事目的：推进揭示信息、拉远表达疏离、横移跟随行动、环绕强化关系，避免无目的炫技。",
            "光线要交代来源、方向、软硬、色温和随动作发生的变化；同场连续镜头保持同一时段与主光逻辑。",
            "多镜头序列先建立空间与方向，再安排正反打、反应镜头和动作衔接，遵守视线与运动轴线。",
            "对白镜头明确说话人、语言、语气、节奏与可见嘴部动作；环境声、动作声和配乐分层描述。",
            "长剧情按模型允许时长拆段，每段有清晰起点、转折和可承接的结束状态，下一段从上一段可见状态继续。",
            "负面约束针对身份漂移、肢体畸变、背景跳变、无动机镜头、过量慢动作、字幕水印和音画错位。",
            "交付前检查参考素材角色分工、镜头时间线、首尾状态、主体遮挡、动作可执行性、声音归属和跨段连续性。",
        ),
        keywords: ["视频导演", "运镜", "镜头", "光影", "动作", "连续性", "首尾帧", "声音"],
        workspaces: ["video", "canvas", "drama"],
        defaultConfig: { size: "16:9", vquality: "1080", videoSeconds: 10 },
        file: "seedance-2.0-main.zip",
        sourcePath: "seedance-2.0-main/SKILL.md + skills/*/SKILL.md",
        license: "MIT",
    },
    {
        id: "skill-minimax-h3-prompt",
        name: "MiniMax H3 视频提示词",
        description: "把分镜、参考图、对白、环境声与配乐整理成适配 MiniMax H3 的分段多模态视频提示词。",
        plannerSummary: "已确定用 MiniMax H3 生成视频，需要把图片引用、镜头切点、对白和声音编译为投产提示词时使用。",
        instructions: lines(
            "先判断是纯文本生成、单图驱动、多图分镜、首尾帧还是包含音视频参考，并为每份参考素材明确唯一用途。",
            "提示词先写整体多模态描述，再按时间顺序写每个镜头，镜头切点必须由实际分镜秒数累计得到。",
            "每个镜头独立描述画面主体、动作、镜头运动、构图变化、光线和切换时刻，禁止把多镜头混成一段散文。",
            "多图输入按出现顺序建立图片引用，并说明哪张图负责角色、场景、构图或首尾状态，避免模型自行猜测。",
            "角色与场景的静态外观交给参考图，文字重点描述这一段发生的动作、表情、镜头变化和声画节奏。",
            "对白逐字保留，明确说话人、语言和表演状态；不要把台词改写成旁白或让非说话角色错误开口。",
            "环境声描述空间持续声与事件声，动作声与画面发生时刻对齐，非画内配乐单独描述情绪和进入退出位置。",
            "使用镜头切换时，前一镜结束状态与后一镜开场状态要在动作、视线、位置和光线方向上可连续。",
            "提示词避免暴露内部字段解释、系统规则或素材文件名，只输出模型可执行的自然语言与必要结构。",
            "负面约束聚焦人物漂移、肢体错误、背景跳变、字幕水印、口型错位、重复动作和无依据的新人物新道具。",
            "生成前核对总时长、镜头切点、图片引用顺序、逐字对白、声景与配乐字段，以及每个镜头是否都能在分配秒数内完成。",
        ),
        keywords: ["视频提示词", "多模态", "分镜", "切点", "对白", "声景", "配乐", "H3"],
        workspaces: ["video", "canvas", "drama"],
        defaultConfig: { size: "16:9", vquality: "1080", videoSeconds: 15 },
        file: "MiniMax-H3-skills(1).rar",
        sourcePath: "h3-prompt-writing/SKILL.md + references/base-en.txt + references/ref-en.txt",
        license: "MIT",
    },
    {
        id: "skill-fantasy-poster",
        name: "社交内容海报",
        description: "把主题、平台、受众与核心文案转化为信息层级清晰、视觉焦点明确的社交媒体海报。",
        plannerSummary: "需要社交平台海报、活动视觉、内容封面或图文传播主视觉时使用。",
        instructions: lines(
            "先确认发布平台、画幅、目标受众、传播目标、核心文案和必须出现的品牌元素。",
            "只保留一个主视觉焦点与一个核心信息，辅助信息按阅读顺序降级，避免所有元素同等抢眼。",
            "根据主题选择合适的视觉隐喻、场景或主体，不用与内容无关的奇幻装饰堆满画面。",
            "构图为标题、主体、行动信息和安全边距预留真实空间，不能依赖生成模型准确绘制大段文字。",
            "色彩建立主色、辅助色和强调色的比例，保证前景文字区域与背景有足够对比。",
            "需要人物或产品时优先使用参考图保持身份与外观，海报风格不能改变核心对象的结构。",
            "同一活动的横版、竖版和方版应共享视觉锚点、色彩和主体，只重新编排版式。",
            "生成画面提示词描述不含最终排版文字的视觉底图；文案、标识和按钮由界面或后期排版完成。",
            "交付前检查移动端缩略图可读性、主体裁切、安全边距、文字区域噪声和品牌一致性。",
        ),
        keywords: ["社交海报", "内容封面", "活动", "主视觉", "排版", "传播"],
        workspaces: ["image", "canvas"],
        defaultConfig: { size: "9:16", quality: "high", count: 1 },
        file: "fantasy-skill社交内容海报.zip",
        sourcePath: "fantasy-skill/SKILL.md",
        license: "MIT",
    },
    {
        id: "skill-real-vlog",
        name: "真人感 Vlog 导演",
        description: "基于多张参考图（人物/道具/场景）自动识别人设立场与环境，生成无滤镜、原生手机直出、手持呼吸感运镜的结构化 Vlog 提示词与视频。",
        plannerSummary: "需要真人感日常 Vlog、手机前置自拍、去 AI 塑料感、多图引用场景剧情动线或 Seedance 2.5 视频生成时使用；完整一天类 Vlog 默认规划 6 个分镜。",
        instructions: lines(
            "批量读取上传图片并分为人物图、道具图和场景图三类，记录主体特征、环境布局与人物间空间关联。",
            "从人物图深度分析推导实际年龄感、性格倾向（元气活泼/清冷慵懒/温柔知性等）与生活方式，动作描写必须贯穿人设，禁止千人一面。",
            "生成分镜图时，用户明确数量则严格遵循；用户未指定时，单一事件规划 4 个分镜，包含“一天、日常、全流程、跟拍”语义的完整 Vlog 默认规划 6 个分镜，不得少于 6 个。",
            "完整一天类 6 个分镜依次覆盖开场钩子、晨间准备、核心工作一、核心工作二或外出转场、生活化细节、晚间收束；每个分镜必须拥有独立的场景、动作、道具和构图提示词。",
            "严格按【画面质感与参数】【人物说明】【道具说明】【画面情绪风格说明】【画面内容及视频动线及场景说明】组织每个分镜或视频段。",
            "画面质感要求 iPhone 原生相机自拍直出、不磨皮不滤镜、保留真实皮肤纹理与毛孔、仅用现场环境光、手持带轻微颠簸与变焦卡顿。",
            "参考人物图默认只锁定人物身份、年龄感、发型与稳定外观；各分镜必须优先执行自身场景、动作、道具、构图与光线，除非用户明确要求，否则不得复制参考图的背景、动作或构图。",
            "道具与场景严格依据实际图片提取，无道具图则整段省略；用户明确提供的每个场景图必须在至少一个分镜或 capture 中引用。",
            "视频 capture 数量按目标时长确定：10秒4段、15秒5至6段、20秒6至8段、25至30秒8至10段；不得再按输入参考图数量压缩完整日常的叙事覆盖。",
            "运镜与节奏采用全片硬切快切（单镜头2-4秒）、穿插1-2秒手机视角空镜头过渡喘气，拒绝慢动作与广告感。",
            "计划中必须公开本轮调用的 Skill 名称与分镜数量；默认9:16竖版，并在执行前让用户可查看参考图分类、目标模型和公开提示词摘要，一键生成模式直接按计划执行。",
        ),
        keywords: ["真人感", "Vlog", "自拍", "生活记录", "原生相机", "Seedance", "去塑料感", "多图分镜"],
        workspaces: ["video", "image", "canvas", "drama"],
        defaultConfig: { size: "9:16", quality: "high", vquality: "1080", count: 1, videoSeconds: 15 },
        file: "真人感vlog-SKILL-V1.2/真人感vlog-SKILL-V1.2.md",
        sourcePath: "真人感vlog-SKILL-V1.2/真人感vlog-SKILL-V1.2.md",
        license: "本地来源未声明",
    },
];

function lines(...items) {
    return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

async function archiveHash(path) {
    return createHash("sha256")
        .update(await fs.readFile(path))
        .digest("hex");
}

async function run() {
    const authPath = resolve(process.cwd(), ".data/auth.json");
    const current = JSON.parse(await fs.readFile(authPath, "utf8"));
    if (!current.settings || typeof current.settings !== "object") throw new Error("本地认证数据缺少 settings 配置");
    const imported = [];
    for (const definition of definitions) {
        const sourceFile = join(sourceRoot, definition.file);
        const stat = await fs.stat(sourceFile).catch(() => null);
        if (!stat?.isFile()) throw new Error(`缺少 Skill 来源文件：${sourceFile}`);
        const hash = await archiveHash(sourceFile);
        imported.push({
            id: definition.id,
            name: definition.name,
            description: definition.description,
            plannerSummary: definition.plannerSummary,
            instructions: definition.instructions,
            enabled: true,
            keywords: definition.keywords,
            workspaces: definition.workspaces,
            action: "generate",
            requiresReference: false,
            defaultConfig: definition.defaultConfig,
            sourceUrl: `local://${encodeURIComponent(definition.sourceLabel || basename(sourceFile))}`,
            sourceRepository: definition.sourceLabel || basename(sourceFile),
            sourcePath: definition.sourcePath,
            sourceVersion: `local-${hash.slice(0, 12)}`,
            sourceCommit: hash,
            sourceContentHash: hash,
            license: definition.license,
        });
    }

    const importedIds = new Set(imported.map((skill) => skill.id));
    current.settings.agentSkills = [...(Array.isArray(current.settings.agentSkills) ? current.settings.agentSkills.filter((skill) => !importedIds.has(skill.id)) : []), ...imported];
    const output = `${JSON.stringify(current, null, 2)}\n`;
    if (/\uFFFD|锟斤拷/.test(output)) throw new Error("Skill 配置包含乱码，已停止写入");
    await fs.mkdir(dirname(authPath), { recursive: true });
    const temporaryPath = `${authPath}.skill-import-${process.pid}`;
    await fs.writeFile(temporaryPath, output, "utf8");
    await fs.rename(temporaryPath, authPath);
    console.log(JSON.stringify({ authPath, imported: imported.map(({ id, name, sourcePath }) => ({ id, name, sourcePath })) }, null, 2));
}

run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});

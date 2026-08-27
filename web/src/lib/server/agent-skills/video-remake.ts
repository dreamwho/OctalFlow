import type { AgentSkill } from "@/lib/auth/store-types";

export const VIDEO_REMAKE_SKILL_PREFIX = "video-remake-";
export const VIDEO_REMAKE_MAX_SEGMENT_SECONDS = 15;
export const VIDEO_REMAKE_COMPOSE_TASK_ID = "video-remake-final-compose";

const sharedInstructions = `这是“结构与节奏复刻”工作流，不是原片克隆。必须使用用户本轮上传的参考视频，先提取时长、镜头边界、叙事节拍、景别变化、机位运动、转场、表演节奏和声音结构，再建立全新的角色、场景、道具、品牌与声音资产。
禁止复用或近似克隆原作者的人脸、声纹、品牌、Logo、水印、音乐、字幕样式和高度独创的台词或画面表达；只允许弱参考其结构、节奏和通用镜头语法。
先规划角色基准图、场景基准图和关键分镜图，再规划视频片段。所有图片任务必须先于视频片段完成，并作为真实参考传给后续视频任务。
视频必须按镜头语义边界拆分，不得机械等分。优先在硬切、转场完成、动作结束、对白停顿、视线或场景切换处断开，避免在一句话、一个动作或同一运镜中间切段。
每个视频片段最长 ${VIDEO_REMAKE_MAX_SEGMENT_SECONDS} 秒；每段分别填写准确时长、起止动作、景别、机位、镜头运动、转场入口/出口、人物站位、视线、服装、道具、光线和与前后段的连续性。
相邻片段必须串联依赖：后一段引用前一段结果和既有角色/场景基准，明确动作接点、屏幕运动方向、轴线、构图、光线与声音接点。
MiniMax H3 视频提示词使用英文并遵循完整 Ref2VA 六段结构：subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape、non_diegetic_music；参考视频只标记为节奏和剪辑结构的 weak_reference。
所有片段完成后必须生成“复刻成片”合成任务，按时间顺序自动拼接为一个完整视频。`;

function remakeSkill(id: string, name: string, description: string, genreRules: string, keywords: string[]): AgentSkill {
    return {
        id,
        name,
        description,
        plannerSummary: `${description} 自动重建资产、语义分段、批量生成并合成成片。`,
        instructions: `${sharedInstructions}\n${genreRules}`,
        enabled: true,
        workspaces: ["video", "canvas", "drama"],
        action: "edit",
        requiresReference: true,
        defaultConfig: { vquality: "720", videoSeconds: 15, remakeMaxSegmentSeconds: VIDEO_REMAKE_MAX_SEGMENT_SECONDS, remakeCompose: true },
        keywords,
        sourceVersion: "1.0.0",
        license: "OctalFlow Built-in",
    };
}

export const VIDEO_REMAKE_SKILLS: AgentSkill[] = [
    remakeSkill(
        "video-remake-universal",
        "通用爆款复刻",
        "适配常见短视频，复刻结构、节奏与镜头语法并生成全新内容。",
        "先识别最接近的内容类型，再选用对应的叙事和镜头策略；无法确认时采用清晰的钩子—展开—证明—收束结构，不得虚构原片细节。",
        ["爆款复刻", "视频复刻", "通用复刻", "参考视频", "一键复刻", "结构复刻", "节奏复刻"],
    ),
    remakeSkill(
        "video-remake-vlog",
        "VLOG 复刻导演",
        "复刻真人 VLOG 的日程结构、环境声、生活化表演和节奏。",
        "按时间推进和地点变化组织镜头，保留自然停顿、手持呼吸感、工作细节与环境声；通常需要开场钩子、过程细节、转场桥段、情绪停留和收束，不得只生成三张概念分镜。",
        ["VLOG复刻", "真人VLOG", "设计师VLOG", "日常VLOG", "探店VLOG", "旅行VLOG"],
    ),
    remakeSkill(
        "video-remake-drama",
        "短剧复刻导演",
        "复刻短剧的冲突曲线、表演节拍、镜头反应和场面调度。",
        "按场景、冲突升级、对白轮次、反应镜头和悬念点拆分；先建立角色关系与空间轴线，所有对白逐句完整保留为新写内容，并为正反打、视线和动作接点设置依赖。",
        ["短剧复刻", "剧情复刻", "漫剧复刻", "反转短剧", "情感短剧"],
    ),
    remakeSkill(
        "video-remake-talking-head",
        "口播复刻导演",
        "复刻口播视频的信息层级、语速节拍、B-roll 与字幕节点。",
        "先重写原创口播稿，再按语义句、重音、停顿和画面证明点切段；主讲人使用全新选角与声音，B-roll 只服务于当前论点，禁止复制原文措辞、声纹和字幕模板。",
        ["口播复刻", "知识口播", "商业口播", "观点视频", "数字人口播"],
    ),
    remakeSkill(
        "video-remake-product",
        "种草广告复刻",
        "复刻产品种草、测评和品牌短片的卖点节奏与展示镜头。",
        "按痛点钩子、产品出场、使用证明、细节特写、结果对比和行动召唤组织；所有品牌、包装、Logo、音乐与宣称必须替换为用户自己的资产和可验证信息。",
        ["种草复刻", "产品测评", "品牌广告", "TVC复刻", "电商视频", "产品短片"],
    ),
    remakeSkill(
        "video-remake-tutorial",
        "教程拆解复刻",
        "复刻教程、科普与操作演示的信息步骤和视觉解释节奏。",
        "按前置条件、步骤、关键操作、错误示例、结果验证和总结拆分；每段只承载一个可验证操作，画面必须能看清手部、界面或工具状态，不得省略关键步骤。",
        ["教程复刻", "科普复刻", "操作演示", "知识视频", "教学视频"],
    ),
];

export function isVideoRemakeSkillId(id: string) {
    return id.startsWith(VIDEO_REMAKE_SKILL_PREFIX);
}

export const QWEN_AUDIO_VOICE_CLONE_MODELS = [
    "qwen-audio-3.0-tts-flash",
    "cosyvoice-v3-plus",
    "qwen3-tts-vc-2026-01-22",
] as const;

export const QWEN_AUDIO_VOICE_DESIGN_MODELS = [
    "qwen-audio-3.0-tts-plus",
    "cosyvoice-v3.5-plus",
    "qwen3-tts-vd-2026-01-26",
] as const;

/** Models from the current Bailian channel that support non-realtime TTS. */
export const QWEN_AUDIO_TTS_MODELS = [
    "qwen-audio-3.0-tts-flash",
    "qwen-audio-3.0-tts-plus",
    "cosyvoice-v3-flash",
    "cosyvoice-v3-plus",
    "cosyvoice-v3.5-plus",
    "qwen3-tts-flash",
    "qwen3-tts-instruct-flash",
    "qwen3-tts-vc-2026-01-22",
    "qwen3-tts-vd-2026-01-26",
] as const;

export const QWEN_AUDIO_MODELS = Array.from(new Set([...QWEN_AUDIO_TTS_MODELS, ...QWEN_AUDIO_VOICE_CLONE_MODELS, ...QWEN_AUDIO_VOICE_DESIGN_MODELS]));

export type QwenAudioVoiceCatalogEntry = {
    model: string;
    scene: string;
    voiceName: string;
    voiceParam: string;
    feature: string;
    age: string;
    gender: string;
    language: string;
    previewUrl?: string;
};

const QWEN_AUDIO_SYSTEM_VOICES: QwenAudioVoiceCatalogEntry[] = [
    { model: "qwen-audio-3.0-tts-plus", scene: "社交陪伴（旗舰音色）", voiceName: "龙安灵心", voiceParam: "longanlingxin", feature: "知心温暖音", age: "25岁", gender: "女", language: "中文（普通话）、英文" },
    { model: "qwen-audio-3.0-tts-plus", scene: "社交陪伴（旗舰音色）", voiceName: "龙安鲁风", voiceParam: "longanlufeng", feature: "明亮开朗音", age: "25岁", gender: "男", language: "中文（普通话）、英文" },
    { model: "qwen-audio-3.0-tts-flash", scene: "社交陪伴（精品中文）", voiceName: "龙安风悦", voiceParam: "longanfengyue", feature: "自然亲切音", age: "30岁", gender: "女", language: "中文（普通话）、英文" },
    { model: "qwen-audio-3.0-tts-flash", scene: "社交陪伴（精品中文）", voiceName: "龙安元妃", voiceParam: "longanyuanfei", feature: "高傲妃子音", age: "30岁", gender: "女", language: "中文（普通话）、英文" },
    { model: "qwen-audio-3.0-tts-flash", scene: "社交陪伴（精品中文）", voiceName: "龙安灵希", voiceParam: "longanlingxi", feature: "可爱甜美音", age: "25岁", gender: "女", language: "中文（普通话）、英文" },
    { model: "qwen-audio-3.0-tts-flash", scene: "社交陪伴/语音助手（精品英文）", voiceName: "loongJohn", voiceParam: "loongjohn", feature: "沉稳亲切美音", age: "28岁", gender: "男", language: "英文" },
    { model: "cosyvoice-v3-plus", scene: "社交陪伴", voiceName: "龙安洋", voiceParam: "longanyang", feature: "阳光大男孩", age: "20–30岁", gender: "男", language: "中文（普通话）、英文" },
    { model: "cosyvoice-v3-plus", scene: "社交陪伴", voiceName: "龙安欢", voiceParam: "longanhuan", feature: "欢脱元气女", age: "20–30岁", gender: "女", language: "中文（普通话）、英文" },
    { model: "qwen3-tts-flash", scene: "通用语音合成", voiceName: "Cherry", voiceParam: "Cherry", feature: "明快爽朗女", age: "-", gender: "女", language: "中文、英文" },
    { model: "qwen3-tts-flash", scene: "通用语音合成", voiceName: "Serena", voiceParam: "Serena", feature: "通透灵动女", age: "-", gender: "女", language: "中文、英文" },
    { model: "qwen3-tts-flash", scene: "通用语音合成", voiceName: "Ethan", voiceParam: "Ethan", feature: "清朗明快男", age: "-", gender: "男", language: "中文、英文" },
    { model: "qwen3-tts-flash", scene: "通用语音合成", voiceName: "Chelsie", voiceParam: "Chelsie", feature: "娇俏软糯女", age: "-", gender: "女", language: "中文、英文" },
    { model: "qwen3-tts-instruct-flash", scene: "通用语音合成", voiceName: "Cherry", voiceParam: "Cherry", feature: "明快爽朗女", age: "-", gender: "女", language: "中文、英文" },
    { model: "qwen3-tts-instruct-flash", scene: "通用语音合成", voiceName: "Serena", voiceParam: "Serena", feature: "通透灵动女", age: "-", gender: "女", language: "中文、英文" },
    { model: "qwen3-tts-instruct-flash", scene: "通用语音合成", voiceName: "Ethan", voiceParam: "Ethan", feature: "清朗明快男", age: "-", gender: "男", language: "中文、英文" },
    { model: "qwen3-tts-instruct-flash", scene: "通用语音合成", voiceName: "Chelsie", voiceParam: "Chelsie", feature: "娇俏软糯女", age: "-", gender: "女", language: "中文、英文" },
];

const qwenAudioFlashVoices: Array<[string, string, string, string]> = [
    ["龙安小昕", "longanxiaoxin", "知性亲和女", "中文（普通话）、英文"],
    ["龙安欢（V3.6）", "longanhuan_v3.6", "欢脱元气女", "中文（普通话）、英文"],
    ["龙杰力豆（V3.6）", "longjielidou_v3.6", "阳光顽皮男", "中文（普通话）、英文"],
    ["龙泡泡（V3.6）", "longpaopao_v3.6", "飞天泡泡音", "中文（普通话）、英文"],
    ["龙火火（V3.6）", "longhuohuo_v3.6", "热情活力音", "中文（普通话）、英文"],
    ["龙川叔（V3.6）", "longchuanshu_v3.6", "沉稳亲切男", "中文（普通话）、英文"],
    ["loongmary", "loongmary", "自然亲切英文女", "英文"],
    ["loongeva", "loongeva_v3.6", "知性英文女", "英文"],
];

const qwen3VoiceNames: Array<[string, string]> = [
    ["Cherry", "阳光积极、亲切自然小姐姐"], ["Serena", "温柔小姐姐"], ["Ethan", "标准普通话、阳光温暖男声"], ["Chelsie", "二次元虚拟女友"],
    ["Momo", "撒娇搞怪，逗你开心"], ["Vivian", "拽拽可爱的小暴躁"], ["Moon", "率性帅气的月白"], ["Maia", "知性与温柔"], ["Kai", "舒缓沉浸男声"], ["Nofish", "不会翘舌音的设计师"],
    ["Bella", "喝酒不打醉拳的小萝莉"], ["Jennifer", "品牌级电影质感美语女声"], ["Ryan", "节奏张力男声"], ["Katerina", "御姐音色"], ["Aiden", "美语大男孩"], ["Eldric Sage", "沉稳睿智的老者"],
    ["Mia", "温顺如春水"], ["Mochi", "聪明伶俐的小大人"], ["Bellona", "声音洪亮、吐字清晰"], ["Vincent", "沙哑烟嗓"], ["Bunny", "萌属性小萝莉"], ["Neil", "专业新闻主持人"], ["Elias", "严谨叙事女声"], ["Arthur", "质朴沧桑男声"],
    ["Nini", "软糯甜美女声"], ["Seren", "温和舒缓助眠声"], ["Pip", "调皮童真男声"], ["Stella", "甜美少女音"], ["Bodega", "热情西班牙大叔"], ["Sonrisa", "热情开朗拉美大姐"], ["Alek", "冷峻温暖俄语男声"], ["Dolce", "慵懒意大利大叔"],
    ["Sohee", "温柔开朗韩国欧尼"], ["Ono Anna", "鬼灵精怪青梅竹马"], ["Lenn", "理性叛逆德国青年"], ["Emilien", "浪漫法国大哥哥"], ["Andre", "磁性沉稳男声"], ["Radio Gol", "足球解说男声"], ["Jada", "沪上阿姐"], ["Dylan", "北京胡同少年"],
    ["Li", "南京话瑜伽老师"], ["Marcus", "陕西话沉稳男声"], ["Roy", "闽南语市井男声"], ["Peter", "天津相声捧哏"], ["Sunny", "川妹子"], ["Eric", "四川成都男子"], ["Rocky", "粤语在线陪聊"], ["Kiki", "甜美港妹"],
];

const cosyVoiceV3FlashCatalog: Array<[string, string, string, string, string, string]> = [
    ["社交陪伴（标杆音色）", "龙安洋", "longanyang", "阳光大男孩", "20–30岁", "中文（普通话）、英文"], ["社交陪伴（标杆音色）", "龙安欢（V3）", "longanhuan_v3", "欢脱元气女", "20–30岁", "中文（普通话、广东话、东北话、河南话、湖南话、陕西话、山东话、四川话、安徽话）、英文"],
    ["童声（标杆音色）", "龙呼呼", "longhuhu_v3", "天真烂漫女童", "6–10岁", "中文（普通话）、英文"], ["智能玩具/儿童故事机", "龙泡泡", "longpaopao_v3", "飞天泡泡音", "6–15岁", "中文（普通话）、英文"], ["智能玩具/儿童故事机", "龙杰力豆", "longjielidou_v3", "阳光顽皮男", "10岁", "中文（普通话）、英文"], ["智能玩具/儿童故事机", "龙仙", "longxian_v3", "豪放可爱女", "12岁", "中文（普通话）、英文"], ["智能玩具/儿童故事机", "龙铃", "longling_v3", "稚气呆板女", "10岁", "中文（普通话）、英文"], ["消费电子-儿童有声书", "龙闪闪", "longshanshan_v3", "戏剧化童声", "6–15岁", "中文（普通话）、英文"], ["消费电子-儿童有声书", "龙牛牛", "longniuniu_v3", "阳光男童声", "6–15岁", "中文（普通话）、英文"],
    ["方言", "龙嘉欣", "longjiaxin_v3", "优雅粤语女", "30–35岁", "中文（粤语）、英文"], ["方言", "龙嘉怡", "longjiayi_v3", "知性粤语女", "25–30岁", "中文（粤语）、英文"], ["方言", "龙安粤", "longanyue_v3", "欢脱粤语男", "25–35岁", "中文（粤语）、英文"], ["方言", "龙老铁", "longlaotie_v3", "东北直率男", "25–30岁", "中文（东北话）、英文"], ["方言", "龙陕哥", "longshange_v3", "原味陕北男", "25–35岁", "中文（陕西话）、英文"], ["方言", "龙安闽", "longanmin_v3", "清纯萝莉女", "18–25岁", "中文（闽南话）、英文"],
    ["出海营销", "loongkyong", "loongkyong_v3", "韩语女", "25–30岁", "韩语"], ["出海营销", "Riko", "loongriko_v3", "二次元霓虹女", "18–25岁", "日语"], ["出海营销", "loongtomoka", "loongtomoka_v3", "日语女", "30–35岁", "日语"], ["出海营销", "loongabby", "loongabby_v3", "美式英文女", "30–35岁", "美式英语"], ["出海营销", "loongandy", "loongandy_v3", "美式英文男", "30–35岁", "美式英语"], ["出海营销", "loongannie", "loongannie_v3", "美式英文女", "30–35岁", "美式英语"], ["出海营销", "loongava", "loongava_v3", "美式英文女", "35–40岁", "美式英语"], ["出海营销", "loongbeth", "loongbeth_v3", "美式英文女", "35–40岁", "美式英语"], ["出海营销", "loongbetty", "loongbetty_v3", "美式英文女", "35–40岁", "美式英语"], ["出海营销", "loongcally", "loongcally_v3", "美式英文女", "25–30岁", "美式英语"], ["出海营销", "loongcindy", "loongcindy_v3", "美式英文女", "30–35岁", "美式英语"], ["出海营销", "loongdavid", "loongdavid_v3", "美式英文男", "35–40岁", "美式英语"], ["出海营销", "loongdonna", "loongdonna_v3", "美式英文女", "35–40岁", "美式英语"], ["出海营销", "loongemily", "loongemily_v3", "英式英文女", "35–40岁", "英式英语"], ["出海营销", "loongeric", "loongeric_v3", "英式英文男", "35–40岁", "英式英语"], ["出海营销", "loongluna", "loongluna_v3", "英式英文女", "35–40岁", "英式英语"], ["出海营销", "loongluca", "loongluca_v3", "英式英文男", "25–30岁", "英式英语"], ["出海营销", "loongtomoya", "loongtomoya_v3", "日语男", "30–35岁", "日语"], ["出海营销", "Yuuna", "loongyuuna_v3", "日语女", "18–25岁", "日语"], ["出海营销", "Yuuma", "loongyuuma_v3", "日语男", "20–25岁", "日语"], ["出海营销", "Jihun", "loongjihun_v3", "韩语男", "25–30岁", "韩语"], ["出海营销", "loongindah", "loongindah_v3", "印尼女", "22–27岁", "印尼语"],
    ["诗词朗诵", "龙飞", "longfei_v3", "热血磁性男", "30–35岁", "中文（普通话）、英文"], ["电话销售", "龙应笑", "longyingxiao_v3", "清甜推销女", "20–25岁", "中文（普通话）、英文"], ["客服", "龙应询", "longyingxun_v3", "年轻青涩男", "20–25岁", "中文（普通话）、英文"], ["客服", "龙应静", "longyingjing_v3", "低调冷静女", "25–35岁", "中文（普通话）、英文"], ["客服", "龙应聆", "longyingling_v3", "温和共情女", "25–30岁", "中文（普通话）、英文"], ["客服", "龙应桃", "longyingtao_v3", "温柔淡定女", "25–30岁", "中文（普通话）、英文"], ["语音助手", "龙小淳", "longxiaochun_v3", "知性积极女", "25–30岁", "中文（普通话）、英文"], ["语音助手", "龙小夏", "longxiaoxia_v3", "沉稳权威女", "25–30岁", "中文（普通话）、英文"], ["语音助手", "YUMI", "longyumi_v3", "正经青年女", "20–25岁", "中文（普通话）、英文"], ["语音助手", "龙安昀", "longanyun_v3", "居家暖男", "30–35岁", "中文（普通话）、英文"], ["语音助手", "龙安温", "longanwen_v3", "优雅知性女", "25–35岁", "中文（普通话）、英文"], ["语音助手", "龙安莉", "longanli_v3", "利落从容女", "25–35岁", "中文（普通话）、英文"], ["语音助手", "龙安朗", "longanlang_v3", "清爽利落男", "20–25岁", "中文（普通话）、英文"], ["语音助手", "龙应沐", "longyingmu_v3", "优雅知性女", "25–30岁", "中文（普通话）、英文"],
    ["社交陪伴", "龙安台", "longantai_v3", "嗲甜台湾女", "20–25岁", "中文（普通话）、英文"], ["社交陪伴", "龙华", "longhua_v3", "元气甜美女", "20–25岁", "中文（普通话）、英文"], ["社交陪伴", "龙橙", "longcheng_v3", "智慧青年男", "20–25岁", "中文（普通话）、英文"], ["社交陪伴", "龙泽", "longze_v3", "温暖元气男", "25–30岁", "中文（普通话）、英文"], ["社交陪伴", "龙哲", "longzhe_v3", "呆板大暖男", "25–30岁", "中文（普通话）、英文"], ["社交陪伴", "龙颜", "longyan_v3", "温暖春风女", "30–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙星", "longxing_v3", "温婉邻家女", "20–25岁", "中文（普通话）、英文"], ["社交陪伴", "龙天", "longtian_v3", "磁性理智男", "30–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙婉", "longwan_v3", "细腻柔声女", "20–30岁", "中文（普通话）、英文"], ["社交陪伴", "龙嫱", "longqiang_v3", "浪漫风情女", "30–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙菲菲", "longfeifei_v3", "甜美娇气女", "20–25岁", "中文（普通话）、英文"], ["社交陪伴", "龙浩", "longhao_v3", "多情忧郁男", "30–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙安柔", "longanrou_v3", "温柔闺蜜女", "20–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙寒", "longhan_v3", "温暖痴情男", "30–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙安智", "longanzhi_v3", "睿智轻熟男", "25–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙安灵", "longanling_v3", "思维灵动女", "20–30岁", "中文（普通话）、英文"], ["社交陪伴", "龙安雅", "longanya_v3", "高雅气质女", "25–35岁", "中文（普通话）、英文"], ["社交陪伴", "龙安亲", "longanqin_v3", "亲和活泼女", "20–25岁", "中文（普通话）、英文"],
    ["有声书", "龙妙", "longmiao_v3", "抑扬顿挫女", "25–30岁", "中文（普通话）、英文"], ["有声书", "龙三叔", "longsanshu_v3", "沉稳质感男", "25–45岁", "中文（普通话）、英文"], ["有声书", "龙媛", "longyuan_v3", "温暖治愈女", "35–40岁", "中文（普通话）、英文"], ["有声书", "龙悦", "longyue_v3", "温暖磁性女", "30–35岁", "中文（普通话）、英文"], ["有声书", "龙修", "longxiu_v3", "博才说书男", "25–35岁", "中文（普通话）、英文"], ["有声书", "龙楠", "longnan_v3", "睿智青年男", "25–30岁", "中文（普通话）、英文"], ["有声书", "龙婉君", "longwanjun_v3", "细腻柔声女", "20–30岁", "中文（普通话）、英文"], ["有声书", "龙逸尘", "longyichen_v3", "洒脱活力男", "20–30岁", "中文（普通话）、英文"], ["有声书", "龙老伯", "longlaobo_v3", "沧桑岁月爷", "60岁以上", "中文（普通话）、英文"], ["有声书", "龙老姨", "longlaoyi_v3", "烟火从容阿姨", "60岁以上", "中文（普通话）、英文"], ["短视频配音", "龙机器", "longjiqi_v3", "呆萌机器人", "20–30岁", "中文（普通话）、英文"], ["短视频配音", "龙猴哥", "longhouge_v3", "经典猴哥", "20–25岁", "中文（普通话）、英文"], ["短视频配音", "龙黛玉", "longdaiyu_v3", "娇率才女音", "15–25岁", "中文（普通话）、英文"], ["直播带货", "龙安燃", "longanran_v3", "活泼质感女", "30–40岁", "中文（普通话）、英文"], ["直播带货", "龙安宣", "longanxuan_v3", "经典直播女", "30–40岁", "中文（普通话）、英文"], ["新闻播报", "龙硕", "longshuo_v3", "博才干练男", "25–30岁", "中文（普通话）、英文"], ["新闻播报", "龙书", "longshu_v3", "沉稳青年男", "20–25岁", "中文（普通话）、英文"], ["新闻播报", "Bella3.0", "loongbella_v3", "精准干练女", "25–30岁", "中文（普通话）、英文"],
];

for (const [name, id, feature, language] of qwenAudioFlashVoices) QWEN_AUDIO_SYSTEM_VOICES.push({ model: "qwen-audio-3.0-tts-flash", scene: "社交陪伴/通用语音", voiceName: name, voiceParam: id, feature, age: "-", gender: feature.includes("女") ? "女" : "男", language });
for (const model of ["qwen3-tts-flash", "qwen3-tts-instruct-flash"]) for (const [name, feature] of qwen3VoiceNames) QWEN_AUDIO_SYSTEM_VOICES.push({ model, scene: "通用语音合成", voiceName: name, voiceParam: name, feature, age: "-", gender: /女|小姐姐|少女|大姐|欧尼|闺蜜/.test(feature) ? "女" : "男", language: "中文、英文及模型支持语种" });
for (const [scene, name, id, feature, age, language] of cosyVoiceV3FlashCatalog) QWEN_AUDIO_SYSTEM_VOICES.push({ model: "cosyvoice-v3-flash", scene, voiceName: name, voiceParam: id, feature, age, gender: /女|童|萝莉/.test(feature) ? "女" : "男", language });

export function qwenAudioSystemVoices(model?: string) {
    const normalized = model?.trim().toLowerCase();
    return QWEN_AUDIO_SYSTEM_VOICES.filter((voice) => !normalized || voice.model.toLowerCase() === normalized).map((voice) => ({ ...voice }));
}

export function qwenDefaultAudioVoice(model: string) {
    const normalized = model.trim().toLowerCase();
    if (/^qwen3-tts-(?:vc|vd)-/i.test(normalized)) return "";
    return qwenAudioSystemVoices(model)[0]?.voiceParam || "";
}

export function isQwenAudioModel(model: string) {
    return QWEN_AUDIO_MODELS.includes(model as (typeof QWEN_AUDIO_MODELS)[number]);
}

export function isQwenVoiceCloneModel(model: string) {
    return QWEN_AUDIO_VOICE_CLONE_MODELS.includes(model as (typeof QWEN_AUDIO_VOICE_CLONE_MODELS)[number]);
}

export function isQwenVoiceDesignModel(model: string) {
    return QWEN_AUDIO_VOICE_DESIGN_MODELS.includes(model as (typeof QWEN_AUDIO_VOICE_DESIGN_MODELS)[number]);
}

export function qwenAudioModelFamily(model: string) {
    if (/^qwen-audio-/i.test(model)) return "Qwen-Audio-TTS";
    if (/^cosyvoice-/i.test(model)) return "CosyVoice";
    if (/^qwen3-tts-/i.test(model)) return "Qwen-TTS";
    return "阿里云百炼";
}

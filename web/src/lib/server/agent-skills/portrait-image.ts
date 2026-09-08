export const PORTRAIT_IMAGE_SKILLS = [
    {
        id: "portrait-realism-messy-hair",
        name: "人物真人感优化（发丝凌乱）",
        description: "基于人物参考图生成带自然凌乱发丝、真实皮肤纹理与电影感微距光影的人像特写。",
        plannerSummary: "严格保持参考人物身份，以凌乱发丝、真实肤质和极浅景深完成电影感微距人像优化。",
        enabled: true,
        workspaces: ["image", "canvas"],
        nodeModes: ["image"],
        action: "edit",
        requiresReference: true,
        previewImageUrl: "/skills/previews/portrait-realism-messy-hair.jpg",
        defaultConfig: { quality: "high", count: 1, promptOptional: true },
        keywords: ["人物", "真人感", "发丝", "凌乱发丝", "微距", "肖像", "皮肤纹理", "电影感", "人像优化"],
        instructions: `主体特写微距肖像，严格以上传的参考图像作为身份来源，零偏差。构图为正脸，在尽可能近的微距距离下进行裁剪，保持整张脸在画面内。
超真实的皮肤纹理，可见毛孔和自然的微细节，水润清新的肤色，精细描绘的睫毛带有清晰的眼神光，眼神亲密而平静。凌乱的几缕头发自然地垂落在脸部，部分遮住眼睛。嘴唇柔软，呈自然的粉红色，带有微妙的纹理，没有浓妆。
光线柔和、散射，具有电影感，带有冷蓝色调和柔和的环境阴影，在没有强烈对比的情况下塑造深度。照片级真实感，电影级原始照片质量，超高细节，8K 真实感，使用 100mm 微距镜头以 f/2.8 拍摄的极限微距照片，景深极浅，焦点锐利地落在眼睛上，鼻部和嘴唇平滑地虚化。`,
    },
    {
        id: "portrait-realism",
        name: "人物真人感优化",
        description: "基于人物参考图生成真实皮肤纹理、自然妆感与电影级微距光影的人像特写。",
        plannerSummary: "严格保持参考人物身份，以真实肤质、自然妆感和极浅景深完成电影感微距人像优化。",
        enabled: true,
        workspaces: ["image", "canvas"],
        nodeModes: ["image"],
        action: "edit",
        requiresReference: true,
        previewImageUrl: "/skills/previews/portrait-realism.jpg",
        defaultConfig: { quality: "high", count: 1, promptOptional: true },
        keywords: ["人物", "真人感", "微距", "肖像", "皮肤纹理", "电影感", "人像优化", "自然妆感"],
        instructions: `主体特写微距肖像，严格以上传的参考图像作为身份来源，零偏差。构图为正脸，在尽可能近的微距距离下进行裁剪，保持整张脸在画面内。
超真实的皮肤纹理，可见毛孔和自然的微细节，水润清新的肤色，精细描绘的睫毛带有清晰的眼神光，眼神亲密而平静。嘴唇柔软，呈自然的粉红色，带有微妙的纹理，没有浓妆。
光线柔和、散射，具有电影感，带有冷蓝色调和柔和的环境阴影，在没有强烈对比的情况下塑造深度。照片级真实感，电影级原始照片质量，超高细节，8K 真实感，使用 100mm 微距镜头以 f/2.8 拍摄的极限微距照片，景深极浅，焦点锐利地落在眼睛上，鼻部和嘴唇平滑地虚化。`,
    },
    {
        id: "character-storyboard-12-grid",
        name: "人物分镜12格",
        description: "基于同一参考图生成 3 种机位高度 × 4 种景别的十二格人物分镜矩阵。",
        plannerSummary: "严格保持参考主体和场景，只改变机位高度与景别，输出三行四列的十二格连续分镜。",
        enabled: true,
        workspaces: ["image", "canvas"],
        nodeModes: ["image"],
        action: "edit",
        requiresReference: true,
        previewImageUrl: "/skills/previews/character-storyboard-12-grid.jpg",
        defaultConfig: { quality: "high", count: 1, promptOptional: true },
        keywords: ["人物", "分镜", "12格", "十二格", "镜头矩阵", "景别", "机位", "远景", "中景", "特写", "超特写"],
        instructions: `以上传的参考图为唯一参考基准，在同一场景下生成 12 格分镜矩阵，采用 3 种机位高度 × 4 种景别的固定逻辑。保持主体、环境、服装或产品设计、光线方向、时间、氛围、色调及整体风格与参考图完全一致。不重新设计场景，不新增道具、人物、动作或剧情元素，画面之间仅允许机位高度和取景距离发生变化。
按清晰的 3 行 4 列排列 12 个镜头。三行机位高度分别为：平视中性视角、低角度仰拍、高角度俯拍。四列景别分别为：远景、中景、特写、超特写。
远景：展现主体与环境的空间关系。中景：展现姿态肢体语言与空间互动。特写：聚焦面部、上半身或关键动作区域。超特写：突出具有表现力的细节，如眼睛、手部、武器、物体纹理或其他重要局部。
平视镜头稳定、客观；仰拍镜头增强气场、力量感或紧张感；俯拍镜头营造空间俯瞰感、脆弱感或视觉掌控感。`,
    },
] as const;

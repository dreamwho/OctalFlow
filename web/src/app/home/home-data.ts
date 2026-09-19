import type { SiteFriendLink, SiteSocialSettings } from "@/lib/auth/store-types";
import type { CreateAgentMode } from "@/lib/create-agent-prompt";
import { WORK_CATEGORIES } from "@/lib/work-publication-options";
import type { PublicGalleryItem } from "@/services/api/work-governance";

export type HomeSiteSettings = {
    title: string;
    logoUrl: string;
    seoDescription: string;
    footerCopyright: string;
    termsUrl: string;
    privacyUrl: string;
    friendLinks: SiteFriendLink[];
    socials: SiteSocialSettings;
    announcementBar?: { enabled: boolean; text: string; href: string };
};

export type HomeNavigationItem = {
    label: string;
    href: string;
    action: "link" | "protected" | "billing";
};

export const HOME_NAVIGATION = [
    { label: "首页", href: "/", action: "link" },
    { label: "无限画布", href: "/canvas", action: "protected" },
    { label: "短剧", href: "/drama", action: "protected" },
    { label: "作品广场", href: "/gallery", action: "link" },
    { label: "定价", href: "/billing/plans", action: "billing" },
    { label: "公告中心", href: "/announcements", action: "link" },
] as const satisfies readonly HomeNavigationItem[];

export const HOME_CREATION_MODES = [
    {
        id: "agent",
        label: "智能模式",
        description: "自动理解需求，规划模型与参数",
        icon: "agent",
        examples: ["生成一张科幻城市概念图", "制作一段产品宣传视频", "为电商产品生成详情页", "创作一个短剧分镜脚本"],
    },
    {
        id: "image",
        label: "AI 绘图",
        description: "从文字生成与编辑图片",
        icon: "image",
        examples: ["生成电影感的未来城市概念图", "为美妆新品制作竖版宣传海报", "为电商产品生成详情页", "把参考图改成清透夏日广告"],
    },
    {
        id: "video",
        label: "AI 视频",
        description: "文生视频与图生视频",
        icon: "video",
        examples: ["制作一段 10 秒新品发布短片", "生成竖屏咖啡品牌氛围广告", "让镜头缓慢向前推进", "制作一段产品功能演示视频"],
    },
    {
        id: "audio",
        label: "AI 音频",
        description: "配音、旁白与音效生成",
        icon: "audio",
        examples: ["生成温暖自然的品牌介绍旁白", "制作沉稳的发布会开场音频", "将文案转换为轻快女声配音", "为短片生成自然男声旁白"],
    },
] as const;

export type HomeCreationMode = CreateAgentMode;

export const HOME_STEPS = [
    { number: "01", title: "描述想法", description: "用自然语言输入你的创意需求", icon: "grid" },
    { number: "02", title: "选择工具", description: "从多种 AI 模型与工具中选择", icon: "edit" },
    { number: "03", title: "生成创作", description: "AI 快速生成多样化结果", icon: "rocket" },
    { number: "04", title: "优化下载", description: "调整细节，导出你的作品", icon: "share" },
] as const;

export const HOME_ADVANTAGES = [
    { title: "场景化创作模板", description: "覆盖真实创作流程与多种场景", icon: "layers" },
    { title: "多模型协同", description: "按任务智能匹配能力", icon: "network" },
    { title: "长任务不中断", description: "稳定续取创作进度", icon: "history" },
    { title: "企业级存储", description: "可靠保存创作资产", icon: "cloud" },
] as const;

export const HOME_GALLERY_TABS = [
    { id: "all", label: "精选" },
    ...(["视觉设计", "插画", "摄影", "视频", "短剧", "品牌内容"] as const).map((category) => ({ id: category, label: category })),
] as const;

export type HomeGalleryTab = "all" | (typeof WORK_CATEGORIES)[number];

export function homeGalleryMatches(item: PublicGalleryItem, tab: HomeGalleryTab) {
    const mediaType = item.preview?.mediaType;
    if (mediaType !== "image" && mediaType !== "video") return false;
    return tab === "all" || item.category === tab;
}

export function homeGalleryTypeLabel(item: PublicGalleryItem) {
    return item.category;
}

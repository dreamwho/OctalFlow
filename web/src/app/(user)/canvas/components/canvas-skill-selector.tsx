"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, Tooltip } from "antd";
import { Check, Sparkles, Clapperboard, Film, User, Smile, Palette, Video, Search } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AgentSkillSummary } from "@/services/api/agent-skills";
import { AgentSkillPreview } from "@/components/agent-skill-preview";

type Props = {
    skills: AgentSkillSummary[];
    loading?: boolean;
    selectedSkillIds?: string[];
    onSelect: (skill: AgentSkillSummary) => void;
    trigger?: ReactNode;
};

export const CANVAS_SKILL_CATEGORIES = [
    { key: "all", label: "全部技能", icon: Sparkles },
    { key: "drama", label: "短剧导演", icon: Clapperboard },
    { key: "vlog", label: "真人Vlog", icon: Video },
    { key: "casting", label: "角色定妆", icon: User },
    { key: "cinema", label: "电影画幅", icon: Film },
    { key: "expression", label: "微表情", icon: Smile },
    { key: "video", label: "AI 视频", icon: Video },
    { key: "poster", label: "视觉海报", icon: Palette },
];

export function canvasSkillMatchesCategory(skill: AgentSkillSummary, category: string) {
    if (category === "all") return true;
    const combined = `${skill.id} ${skill.name} ${skill.description || ""} ${(skill.keywords || []).join(" ")}`.toLowerCase();
    if (category === "drama") return combined.includes("drama") || combined.includes("短剧") || combined.includes("导演") || combined.includes("分镜");
    if (category === "vlog") return combined.includes("vlog") || combined.includes("自拍") || combined.includes("生活记录");
    if (category === "casting") return combined.includes("casting") || combined.includes("选角") || combined.includes("角色") || combined.includes("人物") || combined.includes("肖像");
    if (category === "cinema") return combined.includes("cinema") || combined.includes("电影") || combined.includes("21:9");
    if (category === "expression") return combined.includes("expression") || combined.includes("表情") || combined.includes("情绪");
    if (category === "video") return combined.includes("seedance") || combined.includes("minimax") || combined.includes("h3") || combined.includes("视频") || combined.includes("动效");
    if (category === "poster") return combined.includes("fantasy") || combined.includes("海报") || combined.includes("社交");
    return false;
}

export function CanvasSkillSelector({ skills, loading = false, selectedSkillIds = [], onSelect, trigger }: Props) {
    const [open, setOpen] = useState(false);
    const [activeTab, setActiveTab] = useState("all");
    const [searchQuery, setSearchQuery] = useState("");
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    const visibleCategories = useMemo(() => CANVAS_SKILL_CATEGORIES.filter((category) => category.key === "all" || skills.some((skill) => canvasSkillMatchesCategory(skill, category.key))), [skills]);

    useEffect(() => {
        if (!visibleCategories.some((category) => category.key === activeTab)) setActiveTab("all");
    }, [activeTab, visibleCategories]);

    const filteredSkills = useMemo(() => {
        let list = skills;
        if (activeTab !== "all") list = list.filter((skill) => canvasSkillMatchesCategory(skill, activeTab));
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase();
            list = list.filter((s) => `${s.name} ${s.description || ""} ${(s.keywords || []).join(" ")}`.toLowerCase().includes(q));
        }
        return list;
    }, [skills, activeTab, searchQuery]);

    const handleSelectSkill = (skill: AgentSkillSummary) => {
        onSelect(skill);
        setOpen(false);
    };

    const dialogContent = (
        <div className="flex max-h-[min(640px,calc(100dvh-48px))] min-h-0 select-none flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} data-canvas-skill-dialog>
            <div
                data-canvas-skill-toolbar
                className="flex shrink-0 items-center gap-3 border-b px-4 py-3 pr-14 max-[720px]:flex-col max-[720px]:items-stretch max-[720px]:gap-2"
                style={{ borderColor: theme.toolbar.border }}
            >
                <div className="hide-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Skill 分类">
                    {visibleCategories.map((cat) => {
                        const Icon = cat.icon;
                        const isActive = activeTab === cat.key;
                        return (
                            <button
                                key={cat.key}
                                type="button"
                                role="tab"
                                aria-selected={isActive}
                                onClick={() => setActiveTab(cat.key)}
                                className="flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                                style={{ background: isActive ? theme.toolbar.activeBg : "transparent", color: isActive ? theme.toolbar.activeText : theme.node.muted }}
                            >
                                <Icon className="size-3" />
                                <span>{cat.label}</span>
                            </button>
                        );
                    })}
                </div>
                <label className="flex h-9 w-[min(340px,38vw)] shrink-0 items-center gap-2 rounded-lg border px-3 text-sm max-[720px]:w-full" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                    <Search className="size-4 shrink-0 opacity-50" />
                    <input
                        type="search"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索 Skill"
                        aria-label="搜索 Skill"
                        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-gray-400"
                        style={{ color: theme.node.text }}
                    />
                    {selectedSkillIds.length ? <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-[10px] opacity-65 dark:bg-white/10">已选 {selectedSkillIds.length}</span> : null}
                </label>
            </div>

            <div className="thin-scrollbar grid min-h-0 flex-1 grid-cols-1 content-start items-start gap-3 overflow-y-auto p-4 sm:grid-cols-2 lg:grid-cols-3">
                {loading ? (
                    <div className="col-span-full py-12 text-center text-xs opacity-50">加载技能库中...</div>
                ) : filteredSkills.length === 0 ? (
                    <div className="col-span-full py-12 text-center text-xs opacity-50">未找到匹配的 Skill 技能</div>
                ) : (
                    filteredSkills.map((skill) => {
                        const selected = selectedSkillIds.includes(skill.id);
                        return (
                        <div
                            key={skill.id}
                            onClick={() => handleSelectSkill(skill)}
                            className="group cursor-pointer rounded-xl border p-2.5 text-left transition hover:border-cyan-500 hover:bg-cyan-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                            style={{ borderColor: selected ? "#22d3ee" : theme.toolbar.border, background: selected ? "rgba(34,211,238,0.09)" : theme.toolbar.panel }}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    handleSelectSkill(skill);
                                }
                            }}
                        >
                            <AgentSkillPreview skill={skill} className="mb-2 aspect-[16/9] h-auto" />
                            <div className="mb-1 flex items-center justify-between gap-1">
                                <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-cyan-600 group-hover:underline dark:text-cyan-300">
                                    <Sparkles className="size-3.5 shrink-0" />
                                    <span className="line-clamp-1">{skill.name}</span>
                                </div>
                                {selected ? <Check className="size-4 shrink-0 text-cyan-600 dark:text-cyan-300" /> : <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] opacity-55 dark:bg-white/10">{skill.promptMode === "optional" ? "提示词可选" : "需补充提示词"}</span>}
                            </div>
                            {skill.description && <p className="line-clamp-2 text-xs leading-relaxed opacity-70">{skill.description}</p>}
                        </div>
                        );
                    })
                )}
            </div>
        </div>
    );

    return (
        <>
            <span
                className="inline-flex"
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen(true);
                }}
            >
                {trigger || (
                    <Tooltip title="Skill 技能参考库">
                        <button
                            type="button"
                            className="flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition hover:border-[#5b5ce2] hover:text-[#5b5ce2]"
                            style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel, color: theme.node.text }}
                        >
                            <Sparkles className="size-3.5 text-[#5b5ce2]" />
                            <span>Skill{selectedSkillIds.length ? ` · ${selectedSkillIds.length}` : ""}</span>
                        </button>
                    </Tooltip>
                )}
            </span>
            <Modal
                open={open}
                onCancel={() => setOpen(false)}
                footer={null}
                centered
                width="min(1000px, calc(100vw - 24px))"
                className="canvas-skill-modal"
                classNames={{ container: "border border-[#d9e4ee] dark:border-[#4d6478]" }}
                styles={{
                    container: {
                        padding: 0,
                        overflow: "hidden",
                        background: theme.toolbar.panel,
                        boxShadow: "0 0 0 1px rgba(8,145,178,.08), 0 24px 72px rgba(8,145,178,.16), 0 18px 54px rgba(15,23,42,.22)",
                    },
                    body: { padding: 0 },
                }}
            >
                {dialogContent}
            </Modal>
        </>
    );
}

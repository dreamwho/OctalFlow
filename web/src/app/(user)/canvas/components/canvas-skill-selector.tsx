"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Popover, Tooltip } from "antd";
import { Check, Sparkles, Clapperboard, Film, User, Smile, Palette, Video, Search } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AgentSkillSummary } from "@/services/api/agent-skills";

type Props = {
    skills: AgentSkillSummary[];
    loading?: boolean;
    selectedSkillIds?: string[];
    onSelect: (skill: AgentSkillSummary) => void;
};

const CATEGORIES = [
    { key: "all", label: "全部技能", icon: Sparkles },
    { key: "drama", label: "短剧导演", icon: Clapperboard },
    { key: "vlog", label: "真人Vlog", icon: Video },
    { key: "casting", label: "角色定妆", icon: User },
    { key: "cinema", label: "电影画幅", icon: Film },
    { key: "expression", label: "微表情", icon: Smile },
    { key: "video", label: "AI 视频", icon: Video },
    { key: "poster", label: "视觉海报", icon: Palette },
];

export function CanvasSkillSelector({ skills, loading = false, selectedSkillIds = [], onSelect }: Props) {
    const [open, setOpen] = useState(false);
    const [activeTab, setActiveTab] = useState("all");
    const [searchQuery, setSearchQuery] = useState("");
    const [popoverPlacement, setPopoverPlacement] = useState<"topLeft" | "bottomLeft">("topLeft");
    const [popoverMaxHeight, setPopoverMaxHeight] = useState(420);
    const [popoverOffsetX, setPopoverOffsetX] = useState(0);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        if (!open) return;
        let frame = 0;
        const clampOverlay = () => {
            const overlay = document.querySelector<HTMLElement>(".canvas-skill-popover");
            if (!overlay) return;
            const viewport = window.visualViewport;
            const viewportLeft = viewport?.offsetLeft ?? 0;
            const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
            const rect = overlay.getBoundingClientRect();
            const correction = rect.left < viewportLeft + 12 ? viewportLeft + 12 - rect.left : rect.right > viewportRight - 12 ? viewportRight - 12 - rect.right : 0;
            if (Math.abs(correction) > 0.5) setPopoverOffsetX((value) => value + correction);
        };
        const scheduleClamp = () => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                frame = window.requestAnimationFrame(clampOverlay);
            });
        };
        const updateGeometry = () => {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const viewport = window.visualViewport;
            const viewportTop = viewport?.offsetTop ?? 0;
            const viewportLeft = viewport?.offsetLeft ?? 0;
            const viewportWidth = viewport?.width ?? window.innerWidth;
            const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
            const spaceAbove = Math.max(0, rect.top - viewportTop - 12);
            const spaceBelow = Math.max(0, viewportBottom - rect.bottom - 12);
            const placement = spaceAbove >= 220 || spaceAbove >= spaceBelow ? "topLeft" : "bottomLeft";
            const available = placement === "topLeft" ? spaceAbove : spaceBelow;
            const overlayWidth = Math.max(0, Math.min(704, viewportWidth - 24));
            const desiredLeft = Math.min(Math.max(rect.left, viewportLeft + 12), viewportLeft + viewportWidth - overlayWidth - 12);
            setPopoverPlacement(placement);
            setPopoverMaxHeight(Math.max(120, Math.min(520, available - 44)));
            setPopoverOffsetX(desiredLeft - rect.left);
            scheduleClamp();
        };
        updateGeometry();
        const viewport = window.visualViewport;
        viewport?.addEventListener("resize", updateGeometry);
        viewport?.addEventListener("scroll", updateGeometry);
        window.addEventListener("resize", updateGeometry);
        return () => {
            window.cancelAnimationFrame(frame);
            viewport?.removeEventListener("resize", updateGeometry);
            viewport?.removeEventListener("scroll", updateGeometry);
            window.removeEventListener("resize", updateGeometry);
        };
    }, [open]);

    const filteredSkills = useMemo(() => {
        let list = skills;
        if (activeTab !== "all") {
            list = list.filter((s) => {
                const combined = `${s.id} ${s.name} ${s.description || ""} ${(s.keywords || []).join(" ")}`.toLowerCase();
                if (activeTab === "drama") return combined.includes("drama") || combined.includes("短剧") || combined.includes("导演");
                if (activeTab === "vlog") return combined.includes("vlog") || combined.includes("真人感") || combined.includes("自拍") || combined.includes("生活记录");
                if (activeTab === "casting") return combined.includes("casting") || combined.includes("选角") || combined.includes("角色");
                if (activeTab === "cinema") return combined.includes("cinema") || combined.includes("电影") || combined.includes("21:9");
                if (activeTab === "expression") return combined.includes("expression") || combined.includes("表情") || combined.includes("情绪");
                if (activeTab === "video") return combined.includes("seedance") || combined.includes("minimax") || combined.includes("h3") || combined.includes("视频");
                if (activeTab === "poster") return combined.includes("fantasy") || combined.includes("海报") || combined.includes("社交");
                return true;
            });
        }
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

    const popoverContent = (
        <div className="flex w-[min(680px,calc(100vw-48px))] select-none flex-col overflow-hidden p-2" style={{ maxHeight: popoverMaxHeight }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
                <div>
                    <p className="text-sm font-semibold">使用 Skill</p>
                    <p className="text-[11px] opacity-55">选择后由默认文本模型融合到本次生成提示词</p>
                </div>
                {selectedSkillIds.length ? <span className="rounded-full bg-black/5 px-2 py-1 text-[11px] opacity-65 dark:bg-white/10">已选 {selectedSkillIds.length}</span> : null}
            </div>
            <div className="mb-2 flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                <Search className="size-3.5 opacity-50" />
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索技能名称或描述..."
                    className="w-full bg-transparent outline-none placeholder:text-gray-400"
                    style={{ color: theme.node.text }}
                />
            </div>

            {/* 分类快捷筛选 */}
            <div className="thin-scrollbar mb-2 flex items-center gap-1 overflow-x-auto pb-1">
                {CATEGORIES.map((cat) => {
                    const Icon = cat.icon;
                    const isActive = activeTab === cat.key;
                    return (
                        <button
                            key={cat.key}
                            type="button"
                            onClick={() => setActiveTab(cat.key)}
                            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition"
                            style={{
                                background: isActive ? "#5b5ce2" : "rgba(128,128,128,0.1)",
                                color: isActive ? "#fff" : theme.node.text,
                            }}
                        >
                            <Icon className="size-3" />
                            <span>{cat.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* 技能列表 */}
            <div className="thin-scrollbar grid min-h-0 flex-1 grid-cols-1 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-2 lg:grid-cols-3">
                {loading ? (
                    <div className="py-6 text-center text-xs opacity-50">加载技能库中...</div>
                ) : filteredSkills.length === 0 ? (
                    <div className="py-6 text-center text-xs opacity-50">未找到匹配的 Skill 技能</div>
                ) : (
                    filteredSkills.map((skill) => {
                        const selected = selectedSkillIds.includes(skill.id);
                        return (
                        <div
                            key={skill.id}
                            onClick={() => handleSelectSkill(skill)}
                            className="group min-h-[74px] cursor-pointer rounded-lg border p-2 text-left transition hover:border-[#5b5ce2] hover:bg-[#5b5ce2]/5"
                            style={{ borderColor: selected ? "#5b5ce2" : theme.toolbar.border, background: selected ? "rgba(91,92,226,0.08)" : theme.toolbar.panel }}
                        >
                            <div className="flex items-center justify-between gap-1 mb-1">
                                <div className="flex items-center gap-1.5 font-medium text-xs text-[#5b5ce2] group-hover:underline">
                                    <Sparkles className="size-3" />
                                    <span className="line-clamp-1">{skill.name}</span>
                                </div>
                                {selected ? <Check className="size-3.5 text-[#5b5ce2]" /> : <span className="text-[10px] opacity-40">{skill.workspaces?.join("/") || "all"}</span>}
                            </div>
                            {skill.description && <p className="line-clamp-2 text-[11px] leading-relaxed opacity-70 mb-1">{skill.description}</p>}
                        </div>
                        );
                    })
                )}
            </div>
        </div>
    );

    return (
        <Popover content={popoverContent} trigger="click" open={open} onOpenChange={setOpen} placement={popoverPlacement} align={{ offset: [popoverOffsetX, 0] }} overlayClassName="canvas-skill-popover">
            <Tooltip title="Skill 技能参考库">
                <button
                    ref={triggerRef}
                    type="button"
                    className="flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition hover:border-[#5b5ce2] hover:text-[#5b5ce2]"
                    style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel, color: theme.node.text }}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpen(!open);
                    }}
                >
                    <Sparkles className="size-3.5 text-[#5b5ce2]" />
                    <span>Skill{selectedSkillIds.length ? ` · ${selectedSkillIds.length}` : ""}</span>
                </button>
            </Tooltip>
        </Popover>
    );
}

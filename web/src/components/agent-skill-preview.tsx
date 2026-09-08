"use client";

import { Popover } from "antd";

import { cn } from "@/lib/utils";
import type { AgentSkillSummary } from "@/services/api/agent-skills";

type Props = {
    skill: Pick<AgentSkillSummary, "name" | "previewImageUrl">;
    className?: string;
};

export function AgentSkillPreview({ skill, className }: Props) {
    if (!skill.previewImageUrl) return null;
    return (
        <Popover
            trigger="hover"
            placement="rightTop"
            arrow={false}
            mouseEnterDelay={0.16}
            overlayClassName="agent-skill-preview-popover"
            content={
                <div className="w-[min(420px,calc(100vw-48px))] overflow-hidden rounded-xl bg-[#f3f4f6] dark:bg-[#11151b]">
                    <img src={skill.previewImageUrl} alt={`${skill.name}效果预览`} className="max-h-[320px] w-full object-contain" loading="lazy" draggable={false} />
                    <div className="border-t border-black/10 px-3 py-2 dark:border-white/10">
                        <p className="text-xs font-semibold text-[#20242a] dark:text-[#f3f5f7]">{skill.name}</p>
                        <p className="mt-0.5 text-[11px] leading-4 text-[#737d89] dark:text-[#919ba7]">效果预览 · 实际结果以参考素材和生成模型为准</p>
                    </div>
                </div>
            }
        >
            <span className={cn("relative block h-20 w-full overflow-hidden rounded-md border border-black/10 bg-[#eef0f2] dark:border-white/10 dark:bg-[#11151b]", className)} data-agent-skill-preview>
                <img src={skill.previewImageUrl} alt={`${skill.name}预览`} className="size-full object-contain transition duration-200 group-hover:scale-[1.02]" loading="lazy" draggable={false} />
                <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/65 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm">悬停预览</span>
            </span>
        </Popover>
    );
}

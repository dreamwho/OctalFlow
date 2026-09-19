"use client";

import { Check, Download, Ellipsis, Frame, Pencil, Share2, Trash2, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Button, Dropdown, Input } from "antd";
import { useState } from "react";

import { useCanvasStore, type CanvasProjectSummary } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import { exportCanvasProjects } from "../utils/canvas-export";

function formatUpdatedAt(value: string) {
    return new Date(value)
        .toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        .replace(/\//g, "-");
}

export function CanvasProjectCard({ project }: { project: CanvasProjectSummary }) {
    const { message } = App.useApp();
    const router = useRouter();
    const searchParams = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const loadProject = useCanvasStore((state) => state.loadProject);
    const [exporting, setExporting] = useState(false);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const open = () => router.push(`/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`);
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        stopEditing();
    };
    const exportProject = async () => {
        if (exporting) return;
        setExporting(true);
        try {
            const detail = await loadProject(project.id);
            await exportCanvasProjects([detail]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布导出失败");
        } finally {
            setExporting(false);
        }
    };

    return (
        <article className="group cursor-pointer" onClick={() => !editing && open()} data-testid="canvas-project-card">
            <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-2xl border border-border bg-accent/40 transition group-hover:border-foreground/25">
                <Frame className="size-10 text-stone-400/70 dark:text-stone-500/70" aria-hidden="true" />
                <span className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/25 to-transparent opacity-0 transition group-hover:opacity-100" aria-hidden="true" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
                {editing ? (
                    <Input
                        className="min-w-0 flex-1"
                        size="small"
                        value={editingTitle}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && saveTitle()}
                        autoFocus
                    />
                ) : (
                    <h2 className="min-w-0 truncate text-base font-semibold" title={project.title}>
                        {project.title}
                    </h2>
                )}
                {editing ? (
                    <div className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
                        <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={saveTitle} aria-label="保存名称" />
                        <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label="取消重命名" />
                    </div>
                ) : (
                    <Dropdown
                        trigger={["click"]}
                        placement="bottomRight"
                        styles={{ root: { padding: 0, background: "transparent", boxShadow: "none", border: 0 } }}
                        dropdownRender={() => (
                            <div
                                className="min-w-[136px] rounded-xl border border-white/10 bg-[#1a1b1f]/[0.98] p-1 shadow-[0_18px_44px_rgba(0,0,0,0.65)] backdrop-blur-xl"
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                <button
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-zinc-200 transition hover:bg-white/[0.08]"
                                    onClick={() => startEditing(project.id, project.title)}
                                >
                                    <Pencil className="size-3.5 text-zinc-400" />
                                    <span>重命名</span>
                                </button>
                                <button
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-zinc-200 transition hover:bg-white/[0.08]"
                                    onClick={() => void exportProject()}
                                >
                                    <Download className="size-3.5 text-zinc-400" />
                                    <span>{exporting ? "导出中..." : "导出画布"}</span>
                                </button>
                                <button
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-zinc-200 transition hover:bg-white/[0.08]"
                                    onClick={() => router.push(`/works?sourceType=canvas&sourceId=${encodeURIComponent(project.id)}`)}
                                >
                                    <Share2 className="size-3.5 text-zinc-400" />
                                    <span>发布作品</span>
                                </button>
                                <div className="mx-2 my-1 border-t border-white/[0.08]" />
                                <button
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-red-400 transition hover:bg-red-500/10"
                                    onClick={() => setDeleteIds([project.id])}
                                >
                                    <Trash2 className="size-3.5" />
                                    <span>删除</span>
                                </button>
                            </div>
                        )}
                    >
                        <button
                            type="button"
                            className="grid size-7 cursor-pointer place-items-center rounded-lg bg-white/[0.06] text-zinc-400 transition hover:bg-white/[0.12] hover:text-white md:opacity-0 md:group-hover:opacity-100"
                            aria-label={`管理 ${project.title}`}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <Ellipsis className="size-4" />
                        </button>
                    </Dropdown>
                )}
            </div>
            <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">更新于 {formatUpdatedAt(project.updatedAt)}</p>
        </article>
    );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Button, Input, Pagination } from "antd";
import { Download, FileUp, Plus, Search } from "lucide-react";

import { readZip } from "@/lib/zip";
import { APP_EXPORT_ID } from "@/lib/storage-keys";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/app/(user)/canvas/components/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/app/(user)/canvas/components/canvas-project-card";
import type { CanvasExportFile } from "@/app/(user)/canvas/export-types";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useCanvasUiStore } from "@/app/(user)/canvas/stores/use-canvas-ui-store";
import { resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { useUserStore } from "@/stores/use-user-store";
import { exportCanvasProjects } from "@/app/(user)/canvas/utils/canvas-export";

export function CanvasLibraryClient() {
    const { message } = App.useApp();
    const router = useRouter();
    const searchParams = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const [creating, setCreating] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [keyword, setKeyword] = useState("");
    const siteTitle = usePublicSessionStore((state) => resolveSiteTitle(state.payload?.settings?.site?.title));
    const userId = useUserStore((state) => state.user?.id || "");
    const hydrated = useCanvasStore((state) => state.hydrated);
    const hydratedUserId = useCanvasStore((state) => state.hydratedUserId);
    const syncError = useCanvasStore((state) => state.syncError);
    const hydrate = useCanvasStore((state) => state.hydrate);
    const projects = useCanvasStore((state) => state.summaries);
    const total = useCanvasStore((state) => state.summaryTotal);
    const page = useCanvasStore((state) => state.summaryPage);
    const pageSize = useCanvasStore((state) => state.summaryPageSize);
    const loadProject = useCanvasStore((state) => state.loadProject);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const ready = Boolean(userId && hydrated && hydratedUserId === userId);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        router.push(`/canvas/${id}${agentQuery}`);
    };
    const createAndEnter = async () => {
        if (creating) return;
        setCreating(true);
        try {
            enterProject(await createProject(`${siteTitle} 画布 ${total + 1}`));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布创建失败");
        } finally {
            setCreating(false);
        }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            if (data.app !== APP_EXPORT_ID) throw new Error("不是当前应用的画布包");
            await Promise.all(
                data.projects.map(async (item) => {
                    const uploaded = new Map<string, { storageKey: string; url: string }>();
                    await Promise.all(
                        item.files.map(async (file) => {
                            const blob = zip.get(file.path);
                            if (!blob) return;
                            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, file.mimeType);
                            const media = file.mimeType.startsWith("image/") ? await uploadImage(typedBlob) : await uploadMediaFile(typedBlob, file.mimeType.startsWith("audio/") ? "audio" : "video");
                            uploaded.set(file.storageKey, media);
                        }),
                    );
                    await importProject(remapImportedProjectMedia(item.project, uploaded));
                }),
            );
            message.success(`已导入 ${data.projects.length} 个画布`);
        } catch {
            message.error("导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };
    const exportSelectedProjects = async () => {
        if (!selectedIds.length || exporting) return;
        setExporting(true);
        try {
            const selected = await Promise.all(selectedIds.map((id) => loadProject(id)));
            await exportCanvasProjects(selected);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布导出失败");
        } finally {
            setExporting(false);
        }
    };

    useEffect(() => {
        void hydrate();
    }, [hydrate, userId]);

    useEffect(() => {
        if (!ready || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        void (async () => {
            try {
                const defaultName = `${siteTitle} 画布 ${total + 1}`;
                const id = mode === "new" ? await createProject(defaultName) : projects[0]?.id || (await createProject(defaultName));
                enterProject(id);
            } catch (error) {
                autoOpenRef.current = false;
                message.error(error instanceof Error ? error.message : "画布打开失败");
            }
        })();
    }, [createProject, message, mode, projects, ready, siteTitle, total]);

    if (ready && (mode === "new" || mode === "recent")) return <div className="flex h-full items-center justify-center text-sm text-zinc-400">正在打开画布...</div>;

    return (
        <div>
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 pt-32 pb-14 sm:px-10 sm:pt-36 sm:pb-16">
                <header className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold tracking-tight text-white sm:text-[28px]">我的项目</h1>
                    <button
                        type="button"
                        className="grid size-8 place-items-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
                        aria-label={searchOpen ? "关闭搜索" : "搜索项目"}
                        aria-expanded={searchOpen}
                        onClick={() => {
                            setSearchOpen((open) => !open);
                            if (searchOpen) setKeyword("");
                        }}
                    >
                        <Search className="size-4" />
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!ready} loading={exporting} icon={<Download className="size-4" />} onClick={() => void exportSelectedProjects()}>
                                    导出选中
                                </Button>
                                <Button disabled={!ready} onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        <Button disabled={!ready} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            导入画布
                        </Button>
                    </div>
                </header>

                {searchOpen ? (
                    <Input
                        allowClear
                        autoFocus
                        placeholder="搜索项目名称"
                        value={keyword}
                        onChange={(event) => setKeyword(event.target.value)}
                        className="max-w-sm"
                        aria-label="搜索项目名称"
                    />
                ) : null}

                {!ready ? (
                    <section className="flex min-h-24 flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 text-center text-sm text-zinc-400 sm:min-h-48">
                        <span>{syncError || "正在加载画布..."}</span>
                        {syncError ? (
                            <Button size="small" onClick={() => void hydrate(true)}>
                                重新加载
                            </Button>
                        ) : null}
                    </section>
                ) : (
                    <>
                        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                            <button
                                type="button"
                                disabled={creating}
                                className="group relative flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl transition hover:opacity-95 disabled:opacity-60"
                                style={{ background: "linear-gradient(125deg, #4e46e9 0%, #6e53f6 38%, #8979ff 66%, #35cce1 100%)" }}
                                onClick={() => void createAndEnter()}
                                aria-label="新建项目"
                            >
                                <span className="grid size-12 place-items-center rounded-full bg-white/25 text-white backdrop-blur-sm transition group-hover:bg-white/35">
                                    <Plus className="size-6" />
                                </span>
                                <span className="text-sm font-medium text-white drop-shadow">新建项目</span>
                            </button>
                            {projects
                                .filter((project) => project.title.toLowerCase().includes(keyword.trim().toLowerCase()))
                                .map((project) => (
                                    <CanvasProjectCard key={project.id} project={project} />
                                ))}
                        </div>
                        {total > pageSize ? (
                            <div className="flex justify-center py-2 sm:py-0">
                                <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={(nextPage) => void hydrate(true, nextPage)} />
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </div>
    );
}

function remapImportedProjectMedia(project: CanvasExportFile["projects"][number]["project"], uploaded: Map<string, { storageKey: string; url: string }>) {
    const visit = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(visit);
        if (!value || typeof value !== "object") return value;
        const source = value as Record<string, unknown>;
        const next = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, visit(item)]));
        const media = typeof source.storageKey === "string" ? uploaded.get(source.storageKey) : undefined;
        if (!media) return next;
        next.storageKey = media.storageKey;
        next.serverUrl = media.url;
        delete next.remoteUrl;
        if ("content" in source) next.content = media.url;
        if ("dataUrl" in source) next.dataUrl = media.url;
        if ("url" in source) next.url = media.url;
        return next;
    };
    return visit(project) as typeof project;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Button, Input, Modal, Pagination, Popconfirm } from "antd";
import { Cloud, Download, FileUp, FolderOpen, Plus, Search } from "lucide-react";

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
import { deleteCloudProjectBackup, downloadCloudProjectBackup, getCloudStorageUsage, listCloudProjectBackups, type CloudProjectBackup, type CloudStorageUsage } from "@/services/api/cloud-storage";
import { formatBytes } from "@/lib/image-utils";

export function CanvasLibraryClient({ adminLocal = false }: { adminLocal?: boolean }) {
    const { message } = App.useApp();
    const router = useRouter();
    const searchParams = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const [creating, setCreating] = useState(false);
    const [newProjectOpen, setNewProjectOpen] = useState(false);
    const [projectName, setProjectName] = useState("");
    const desktopNewRef = useRef(false);
    const [exporting, setExporting] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [cloudBackupEnabled, setCloudBackupEnabled] = useState(false);
    const [backupsOpen, setBackupsOpen] = useState(false);
    const [backupsLoading, setBackupsLoading] = useState(false);
    const [backupAction, setBackupAction] = useState("");
    const [backupPage, setBackupPage] = useState(1);
    const [backups, setBackups] = useState<CloudProjectBackup[]>([]);
    const [backupTotal, setBackupTotal] = useState(0);
    const [backupUsage, setBackupUsage] = useState<CloudStorageUsage | null>(null);
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
            enterProject(await createProject(projectName.trim() || `${siteTitle} 画布 ${total + 1}`));
            setNewProjectOpen(false);
            setProjectName("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布创建失败");
        } finally {
            setCreating(false);
        }
    };
    const importCanvas = async (file?: Blob) => {
        if (!file) return false;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            if (data.app !== APP_EXPORT_ID || data.version !== 3 || !Array.isArray(data.projects) || !data.projects.length) throw new Error("画布包格式无效");
            await Promise.all(
                data.projects.map(async (item) => {
                    const uploaded = new Map<string, { storageKey: string; url: string }>();
                    await Promise.all(
                        item.files.map(async (file) => {
                            const blob = zip.get(file.path);
                            if (!blob) throw new Error(`画布包缺少素材：${file.path}`);
                            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, file.mimeType);
                            const media = file.mimeType.startsWith("image/") ? await uploadImage(typedBlob) : await uploadMediaFile(typedBlob, file.mimeType.startsWith("audio/") ? "audio" : "video");
                            uploaded.set(file.storageKey, media);
                        }),
                    );
                    await importProject(remapImportedProjectMedia(item.project, uploaded));
                }),
            );
            message.success(`已导入 ${data.projects.length} 个画布`);
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入失败，请选择有效的画布压缩包");
            return false;
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };
    const loadBackups = async (nextPage: number) => {
        setBackupsLoading(true);
        try {
            const result = await listCloudProjectBackups(nextPage);
            setBackups(result.items);
            setBackupTotal(result.total);
            setBackupPage(result.page);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取云端备份失败");
        } finally { setBackupsLoading(false); }
    };
    const restoreBackup = async (backup: CloudProjectBackup) => {
        setBackupAction(backup.referenceId);
        try {
            const file = await downloadCloudProjectBackup(backup);
            if (await importCanvas(file)) setBackupsOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "恢复云端备份失败");
        } finally { setBackupAction(""); }
    };
    const removeBackup = async (backup: CloudProjectBackup) => {
        setBackupAction(backup.referenceId);
        try {
            await deleteCloudProjectBackup(backup.referenceId);
            message.success("云端备份已删除");
            await loadBackups(backups.length === 1 && backupPage > 1 ? backupPage - 1 : backupPage);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除云端备份失败");
        } finally { setBackupAction(""); }
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
        if (!adminLocal || searchParams.get("desktopNew") !== "1") { desktopNewRef.current = false; return; }
        if (desktopNewRef.current) return;
        desktopNewRef.current = true;
        setNewProjectOpen(true);
    }, [adminLocal, searchParams]);

    useEffect(() => {
        const desktop = (window as typeof window & { dreamyoDesktop?: { getRuntimeInfo(): Promise<{ cloudProjectBackups: boolean }> } }).dreamyoDesktop;
        if (!desktop) { setCloudBackupEnabled(true); return; }
        void desktop.getRuntimeInfo().then((info) => setCloudBackupEnabled(info.cloudProjectBackups)).catch(() => setCloudBackupEnabled(false));
    }, []);

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
            {adminLocal ? <div className="mx-auto w-full max-w-[1320px] px-7 py-10 sm:px-12">
                <header className="flex flex-wrap items-start justify-between gap-5 border-b border-[#ced3ef] pb-8 dark:border-[#343759]">
                    <div><p className="text-[11px] font-semibold tracking-[.12em] text-[#514db5] dark:text-[#b9b6ff]">本地工作区</p><h1 className="mt-2 text-[27px] font-bold tracking-tight">项目库</h1><p className="mt-2 text-sm text-[#666d88] dark:text-[#abaacb]">整理画布与素材，继续你的创作。</p></div>
                    <div className="flex flex-wrap items-center gap-2 pt-4">
                        {selectedIds.length ? <><Button loading={exporting} icon={<Download className="size-4" />} onClick={() => void exportSelectedProjects()}>导出选中</Button><Button onClick={() => setDeleteIds(selectedIds)}>删除选中</Button></> : null}
                        <Button icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>导入画布</Button>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setNewProjectOpen(true)} disabled={!ready} aria-label="新建项目">新建项目</Button>
                    </div>
                </header>
                <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
                    <div className="border-b-2 border-[#6366f1] pb-2 text-sm font-semibold text-[#4f46a5] dark:text-[#c7d2fe]">本地项目 <span className="ml-1 text-xs font-normal text-[#737a9d]">{ready ? total : ""}</span></div>
                    <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear prefix={<Search className="size-4 text-[#8586bc]" />} placeholder="搜索项目" aria-label="搜索项目名称" className="w-full sm:max-w-[260px]" />
                </div>
                {!ready ? <section className="mt-10 flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-[#646b87] dark:text-[#a8a9c8]"><span>{syncError || "正在加载项目..."}</span>{syncError ? <Button onClick={() => void hydrate(true)}>重新加载</Button> : null}</section> : projects.filter((project) => project.title.toLowerCase().includes(keyword.trim().toLowerCase())).length ? <>
                    <div className="mt-7 grid grid-cols-1 gap-x-6 gap-y-9 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.filter((project) => project.title.toLowerCase().includes(keyword.trim().toLowerCase())).map((project) => <CanvasProjectCard key={project.id} project={project} adminLocal />)}
                    </div>
                    {total > pageSize ? <div className="mt-8 flex justify-center"><Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={(next) => void hydrate(true, next)} /></div> : null}
                </> : <section className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-center" role="status"><FolderOpen className="size-14 text-[#a5a3ea] dark:text-[#8f90d5]" strokeWidth={1.3} /><h2 className="text-base font-semibold">{keyword ? "没有找到匹配项目" : "暂无本地项目"}</h2><p className="text-sm text-[#646b87] dark:text-[#a8a9c8]">{keyword ? "试试其他关键词。" : "新建项目，开始在画布上创作。"}</p>{!keyword ? <Button type="primary" onClick={() => setNewProjectOpen(true)}>新建项目</Button> : null}</section>}
            </div> :
            <div className={`mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 pb-14 sm:px-10 sm:pb-16 ${adminLocal ? "pt-10 sm:pt-12" : "pt-32 sm:pt-36"}`}>
                <header className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold tracking-tight text-white sm:text-[28px]">{adminLocal ? "画布项目" : "我的项目"}</h1>
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
                        {cloudBackupEnabled ? <Button disabled={!ready} icon={<Cloud className="size-4" />} onClick={() => { setBackupsOpen(true); void loadBackups(1); void getCloudStorageUsage().then(setBackupUsage).catch(() => setBackupUsage(null)); }}>
                            云端备份
                        </Button> : null}
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
                                    <CanvasProjectCard key={project.id} project={project} cloudBackupEnabled={cloudBackupEnabled} />
                                ))}
                        </div>
                        {total > pageSize ? (
                            <div className="flex justify-center py-2 sm:py-0">
                                <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={(nextPage) => void hydrate(true, nextPage)} />
                            </div>
                        ) : null}
                    </>
                )}
            </div>}

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            {adminLocal ? <Modal title="新建本地项目" open={newProjectOpen} onCancel={() => { setNewProjectOpen(false); setProjectName(""); if (searchParams.get("desktopNew") === "1") router.replace("/canvas"); }} onOk={() => void createAndEnter()} okText="创建项目" okButtonProps={{ disabled: !projectName.trim(), loading: creating }} cancelText="取消" centered width={430} destroyOnHidden><label htmlFor="desktop-project-name" className="mb-2 block text-sm font-medium">项目名称</label><Input id="desktop-project-name" autoFocus maxLength={80} value={projectName} onChange={(event) => setProjectName(event.target.value)} onPressEnter={() => projectName.trim() && void createAndEnter()} placeholder="例如：我的视频创作" /><p className="mt-3 text-xs text-zinc-500">项目与素材保存于这台电脑。</p></Modal> : null}
            <Modal title="云端画布备份" open={backupsOpen} onCancel={() => setBackupsOpen(false)} footer={null} width={640}>
                <p className="mb-3 text-xs text-zinc-500">备份文件会计入云存储空间；恢复时创建新的画布，不覆盖现有项目。</p>
                {backupUsage ? <p className="mb-3 text-xs text-zinc-500">已用 {formatBytes(backupUsage.usedBytes) || "0 B"} / 总额度 {formatBytes(backupUsage.limitBytes) || "0 B"}，可用 {formatBytes(backupUsage.availableBytes) || "0 B"}</p> : null}
                {backupsLoading ? <div className="py-8 text-center text-sm text-zinc-500">正在读取备份...</div> : backups.length ? (
                    <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                        {backups.map((backup) => <div key={backup.referenceId} className="flex items-center gap-3 py-3">
                            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{backup.title}</div><div className="text-xs text-zinc-500">{new Date(backup.createdAt).toLocaleString("zh-CN")} · {(backup.bytes / 1024 / 1024).toFixed(2)} MiB</div></div>
                            <Button size="small" loading={backupAction === backup.referenceId} onClick={() => void restoreBackup(backup)}>恢复</Button>
                            <Popconfirm title="删除这份云端备份？" description="删除后不可恢复，若没有其他引用，将释放对应存储空间。" okText="删除" cancelText="取消" onConfirm={() => void removeBackup(backup)}><Button size="small" danger disabled={Boolean(backupAction)}>删除</Button></Popconfirm>
                        </div>)}
                    </div>
                ) : <div className="py-8 text-center text-sm text-zinc-500">暂无云端画布备份</div>}
                {backupTotal > 20 ? <div className="mt-4 flex justify-center"><Pagination current={backupPage} pageSize={20} total={backupTotal} showSizeChanger={false} onChange={(nextPage) => void loadBackups(nextPage)} /></div> : null}
            </Modal>
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

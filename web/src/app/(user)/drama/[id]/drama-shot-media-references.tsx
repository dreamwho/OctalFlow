"use client";

import { App, Button, Select } from "antd";
import { Music2, Trash2, Upload, Video } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { canvasDolaVideoProfile, resolveCanvasDolaModelId } from "@/app/(user)/canvas/utils/canvas-dola";
import { useConfigStore } from "@/stores/use-config-store";
import { uploadServerMedia } from "@/services/server-media-storage";
import { listLibraryAssetPage } from "@/services/api/library-assets";
import type { DramaProject, DramaShot, DramaSourceAsset } from "@/lib/drama-project-contract";
import { useDramaStore } from "../stores/use-drama-store";

export function DramaShotMediaReferences({ project, episodeId, shot }: { project: DramaProject; episodeId: string; shot: DramaShot }) {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const updateShot = useDramaStore((state) => state.updateShot);
    const supported = canvasDolaVideoProfile(resolveCanvasDolaModelId(config, config.videoModel || config.model))?.supportsMediaReferences;
    const inputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [library, setLibrary] = useState<DramaSourceAsset[]>([]);
    const references = shot.videoReferences || [];
    const disabled = uploading || shot.generationStatus === "queued" || shot.generationStatus === "running";
    const options = [...(project.sourceAssets || []).filter((asset) => asset.type === "video" || asset.type === "audio"), ...library];
    useEffect(() => { if (!supported) setLibrary([]); }, [supported]);
    const loadLibrary = async () => {
        try {
            const pages = await Promise.all((["video", "audio"] as const).map((kind) => listLibraryAssetPage({ kind, page: 1, pageSize: 100 })));
            setLibrary(pages.flatMap((page) => page.assets.flatMap((asset) => asset.kind === "audio" || asset.kind === "video" ? [{ id: asset.id, title: asset.title, type: asset.kind, serverUrl: asset.data.serverUrl || asset.data.url, storageKey: asset.data.storageKey, mimeType: asset.data.mimeType }] : [])));
        } catch (error) { message.error(error instanceof Error ? error.message : "素材加载失败"); }
    };
    const upload = async (files: File[]) => {
        setUploading(true);
        try {
            const added: DramaSourceAsset[] = [];
            for (const file of files) {
                const type = file.type.startsWith("audio/") ? "audio" : file.type.startsWith("video/") ? "video" : undefined;
                if (!type) throw new Error("请选择音频或视频文件");
                const stored = await uploadServerMedia(file, type);
                added.push({ id: nanoid(), type, title: file.name, serverUrl: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType });
            }
            updateShot(project.id, episodeId, shot.id, { videoReferences: [...references, ...added] });
        } catch (error) { message.error(error instanceof Error ? error.message : "参考素材上传失败"); }
        finally { setUploading(false); if (inputRef.current) inputRef.current.value = ""; }
    };
    if (!supported && !references.length) return null;
    return <div className="mt-3 space-y-2 border-t border-border/70 pt-3" data-testid="drama-media-references">
        <div className="text-sm font-semibold">音视频参考素材</div>
        {!supported ? <p className="text-xs text-muted-foreground">当前模型不支持这些参考，请移除素材或切换模型。</p> : <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button size="small" disabled={disabled} loading={uploading} icon={<Upload className="size-3.5" />} onClick={() => inputRef.current?.click()}>上传音视频参考</Button>
            <div className="min-w-0 flex-1"><Select className="w-full" size="small" placeholder="引用项目或素材库音视频" disabled={disabled} value={undefined} onOpenChange={(open) => { if (open) void loadLibrary(); }} options={options.filter((asset) => !references.some((item) => item.id === asset.id)).map((asset) => ({ value: asset.id, label: `${asset.type === "audio" ? "音频" : "视频"} · ${asset.title}` }))} onChange={(id) => { const asset = options.find((item) => item.id === id); if (asset) updateShot(project.id, episodeId, shot.id, { videoReferences: [...references, asset] }); }} /></div>
        </div>}
        <div className="flex flex-wrap gap-2">{references.map((asset) => <div key={asset.id} className="flex min-w-0 max-w-full items-center gap-2 rounded border border-border px-2 py-1 text-xs"><span>{asset.type === "audio" ? <Music2 className="size-4" /> : <Video className="size-4" />}</span><span className="truncate" title={asset.title}>{asset.title}</span><Button type="text" size="small" disabled={disabled} aria-label={`移除参考素材 ${asset.title}`} icon={<Trash2 className="size-3.5" />} onClick={() => updateShot(project.id, episodeId, shot.id, { videoReferences: references.filter((item) => item.id !== asset.id) })} /></div>)}</div>
        <input ref={inputRef} type="file" accept="video/*,audio/*" multiple hidden onChange={(event) => void upload(Array.from(event.target.files || []))} />
    </div>;
}

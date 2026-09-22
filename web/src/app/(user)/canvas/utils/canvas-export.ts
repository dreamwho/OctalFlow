import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { APP_EXPORT_ID, collectStorageKeys } from "@/lib/storage-keys";
import { exportFileExtension, safeExportFileName } from "@/lib/export-file";
import { mediaDownloadFileName } from "@/lib/media-file";
import type { CanvasExportAsset, CanvasExportFile } from "../export-types";
import type { CanvasProject } from "../stores/use-canvas-store";

export async function exportCanvasProjects(projects: CanvasProject[]) {
    const zip = await createCanvasExportZip(projects);
    saveAs(zip, mediaDownloadFileName(projects.map((project) => project.id).join(":"), "application/zip"));
}

export async function createCanvasExportZip(projects: CanvasProject[]) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                Array.from(collectStorageKeys(project, (key) => key.startsWith("permanent/") || key.startsWith("temporary/"))).map(async (storageKey) => {
                    const blob = storageKey.includes("/images/") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) throw new Error(`画布素材 ${storageKey} 无法读取，已停止导出以免生成不完整的备份`);
                    const path = `projects/${project.id}/files/${safeExportFileName(storageKey)}.${exportFileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    const data: CanvasExportFile = { app: APP_EXPORT_ID, version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    return createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
}

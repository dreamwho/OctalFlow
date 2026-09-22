"use client";

export type CloudProjectBackup = {
    referenceId: string;
    projectId: string;
    title: string;
    createdAt: string;
    bytes: number;
    checksumSha256: string;
};
export type CloudStorageUsage = { limitBytes: number; usedBytes: number; reservedBytes: number; availableBytes: number; overQuota: boolean };

type ApiPayload<T> = { code?: number; data?: T; msg?: string };
type CloudStorageBridge = {
    cloudStorage(action: "upload", input: { projectId: string; title: string; checksumSha256: string; bytes: Uint8Array }): Promise<{ referenceId: string; bytes: number }>;
    cloudStorage(action: "list", input: { page: number; pageSize: number }): Promise<{ items: CloudProjectBackup[]; total: number; page: number; pageSize: number }>;
    cloudStorage(action: "download", input: { referenceId: string }): Promise<{ bytes: Uint8Array; checksumSha256: string }>;
    cloudStorage(action: "delete", input: { referenceId: string }): Promise<{ objectDeleted: boolean }>;
    cloudStorage(action: "usage"): Promise<CloudStorageUsage>;
};

function desktopBridge() {
    return typeof window === "undefined" ? undefined : (window as typeof window & { dreamyoDesktop?: CloudStorageBridge }).dreamyoDesktop;
}

export async function uploadCloudProjectBackup(zip: Blob, project: { id: string; title: string }) {
    const checksum = await sha256(zip);
    const desktop = desktopBridge();
    if (desktop) return desktop.cloudStorage("upload", { projectId: project.id, title: project.title, checksumSha256: checksum, bytes: new Uint8Array(await zip.arrayBuffer()) });
    const response = await fetch("/api/cloud-storage/objects", {
        method: "POST",
        headers: { "Content-Type": "application/zip", "x-dreamyo-source": "backup", "x-dreamyo-content-bytes": String(zip.size),
            "x-dreamyo-sha256": checksum, "x-dreamyo-project-id": project.id, "x-dreamyo-project-title": encodeURIComponent(project.title) },
        body: zip,
    });
    return readResponse<{ referenceId: string; bytes: number }>(response);
}

export async function listCloudProjectBackups(page = 1, pageSize = 20) {
    const desktop = desktopBridge();
    if (desktop) return desktop.cloudStorage("list", { page, pageSize });
    const response = await fetch(`/api/cloud-storage/backups?page=${page}&pageSize=${pageSize}`, { cache: "no-store" });
    return readResponse<{ items: CloudProjectBackup[]; total: number; page: number; pageSize: number }>(response);
}

export async function getCloudStorageUsage() {
    const desktop = desktopBridge();
    if (desktop) return desktop.cloudStorage("usage");
    return readResponse<CloudStorageUsage>(await fetch("/api/cloud-storage/usage", { cache: "no-store" }));
}

export async function downloadCloudProjectBackup(backup: CloudProjectBackup) {
    const desktop = desktopBridge();
    if (desktop) {
        const downloaded = await desktop.cloudStorage("download", { referenceId: backup.referenceId });
        const file = new Blob([Uint8Array.from(downloaded.bytes)]);
        if (file.size !== backup.bytes || await sha256(file) !== backup.checksumSha256 || downloaded.checksumSha256 !== backup.checksumSha256) {
            throw new Error("云端备份文件校验失败，已停止恢复");
        }
        return file;
    }
    const response = await fetch(`/api/cloud-storage/backups/${encodeURIComponent(backup.referenceId)}`, { cache: "no-store" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as ApiPayload<unknown>;
        throw new Error(payload.msg || "下载云端备份失败");
    }
    const file = await response.blob();
    if (file.size !== backup.bytes || await sha256(file) !== backup.checksumSha256 || response.headers.get("x-dreamyo-sha256") !== backup.checksumSha256) {
        throw new Error("云端备份文件校验失败，已停止恢复");
    }
    return file;
}

export async function deleteCloudProjectBackup(referenceId: string) {
    const desktop = desktopBridge();
    if (desktop) return desktop.cloudStorage("delete", { referenceId });
    const response = await fetch(`/api/cloud-storage/backups/${encodeURIComponent(referenceId)}`, { method: "DELETE" });
    return readResponse<{ objectDeleted: boolean }>(response);
}

async function sha256(blob: Blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function readResponse<T>(response: Response) {
    const payload = (await response.json().catch(() => ({}))) as ApiPayload<T>;
    if (!response.ok || !payload.data) throw new Error(payload.msg || "云端存储请求失败");
    return payload.data;
}

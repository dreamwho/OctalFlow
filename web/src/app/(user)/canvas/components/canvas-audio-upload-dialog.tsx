"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import { ClipboardPaste, FileAudio, UploadCloud } from "lucide-react";

import { droppedFiles, preventFileDragEvent } from "@/lib/file-drop";
import { isAudioFile } from "../[id]/canvas-page-utils";

export function CanvasAudioUploadDialog({ open, nodeId, onClose, onUpload }: { open: boolean; nodeId: string | null; onClose: () => void; onUpload: (nodeId: string, file: File) => Promise<void> | void }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [saving, setSaving] = useState(false);
    const [dragging, setDragging] = useState(false);
    useEffect(() => {
        if (!open) {
            setFile(null);
            setSaving(false);
        }
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const handlePaste = (event: ClipboardEvent) => {
            const pasted = Array.from(event.clipboardData?.files || []).find(isAudioFile);
            if (pasted) {
                event.preventDefault();
                setFile(pasted);
            }
        };
        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [open]);
    const choose = (candidate?: File) => {
        if (!candidate) return;
        if (!isAudioFile(candidate)) return;
        setFile(candidate);
    };
    const submit = async () => {
        if (!file || !nodeId) return;
        setSaving(true);
        try {
            await onUpload(nodeId, file);
            onClose();
        } finally {
            setSaving(false);
        }
    };
    return <Modal title="上传音频到节点" open={open} onCancel={onClose} footer={<div className="flex justify-end gap-2"><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!file} loading={saving} onClick={() => void submit()}>上传并替换</Button></div>}>
        <div
            className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${dragging ? "border-indigo-500 bg-indigo-50/60" : "border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/40"}`}
            onDragEnter={(event) => { if (!preventFileDragEvent(event)) return; setDragging(true); }}
            onDragOver={(event) => { if (!preventFileDragEvent(event)) return; setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { if (!preventFileDragEvent(event)) return; setDragging(false); choose(droppedFiles(event, isAudioFile)[0]); }}
        >
            <UploadCloud className="mx-auto mb-3 size-8 text-indigo-500" />
            <div className="font-medium">拖拽音频文件到这里</div>
            <div className="mt-1 text-xs text-zinc-500">也可以复制后直接粘贴，或选择本地文件</div>
            <div className="mt-4 flex justify-center gap-2"><Button icon={<FileAudio className="size-4" />} onClick={() => inputRef.current?.click()}>选择文件</Button><Button icon={<ClipboardPaste className="size-4" />} onClick={() => void navigator.clipboard?.read?.().then(async (items) => { for (const item of items) { const type = item.types.find((candidate) => candidate.startsWith("audio/")); if (type) { choose(new File([await (await item.getType(type)).arrayBuffer()], `pasted-audio.${type.split("/")[1] || "wav"}`, { type })); break; } } }).catch(() => undefined)}>粘贴音频</Button></div>
            <input ref={inputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" className="hidden" onChange={(event) => choose(event.target.files?.[0])} />
            {file ? <div className="mx-auto mt-5 flex max-w-sm items-center justify-between rounded-lg border border-indigo-200 bg-white px-3 py-2 text-left text-sm dark:border-indigo-900 dark:bg-zinc-950"><span className="truncate">{file.name}</span><span className="ml-3 shrink-0 text-xs text-zinc-500">{Math.ceil(file.size / 1024)} KB</span></div> : null}
        </div>
    </Modal>;
}

"use client";

import { App, Button } from "antd";
import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { imagePreviewUrl } from "@/lib/media-image-url";

export const PROMPT_COVER_ACCEPT = "image/png,image/jpeg,image/webp";
export const PROMPT_COVER_MAX_BYTES = 20 * 1024 * 1024;

export function promptCoverFileError(file: File) {
    if (!/^image\/(?:png|jpe?g|webp)$/i.test(file.type)) return "仅支持 PNG、JPG 或 WebP 图片";
    if (!file.size) return "图片文件不能为空";
    if (file.size > PROMPT_COVER_MAX_BYTES) return "图片文件不能超过 20MB";
    return "";
}

export function PromptImageInput({ file, currentUrl, onChange, onRemove }: { file: File | null; currentUrl?: string; onChange: (file: File) => void; onRemove: () => void }) {
    const { message } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const objectUrl = useMemo(() => (file ? URL.createObjectURL(file) : ""), [file]);
    const previewUrl = objectUrl || (currentUrl ? imagePreviewUrl(currentUrl, 640) : "");

    useEffect(
        () => () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        },
        [objectUrl],
    );

    const choose = (next?: File) => {
        if (!next) return;
        const error = promptCoverFileError(next);
        if (error) return void message.warning(error);
        onChange(next);
    };

    const drop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        choose(Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/")) || event.dataTransfer.files[0]);
    };

    return (
        <div className="space-y-2">
            <input
                ref={inputRef}
                type="file"
                accept={PROMPT_COVER_ACCEPT}
                className="sr-only"
                aria-label="选择提示词封面图片"
                onChange={(event) => {
                    choose(event.target.files?.[0]);
                    event.target.value = "";
                }}
            />
            <div
                data-testid="prompt-cover-dropzone"
                className={`rounded-xl border border-dashed p-3 transition-colors ${dragging ? "border-primary bg-primary/5" : "border-border bg-muted/35 hover:border-primary/60"}`}
                onDragEnter={(event) => {
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                }}
                onDrop={drop}
            >
                {previewUrl ? (
                    <div className="flex min-w-0 items-center gap-3">
                        <img src={previewUrl} alt="提示词封面预览" className="h-20 w-28 shrink-0 rounded-lg border border-border object-cover" />
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">{file?.name || "当前封面图片"}</div>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">可重新选择、拖入或粘贴另一张图片替换</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Button icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>
                                    更换图片
                                </Button>
                                <Button danger icon={<Trash2 className="size-4" />} onClick={onRemove}>
                                    移除
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex min-h-28 flex-col items-center justify-center px-3 py-4 text-center">
                        <span className="grid size-10 place-items-center rounded-full border border-border bg-background text-muted-foreground">
                            <ImagePlus className="size-5" />
                        </span>
                        <div className="mt-2 text-sm font-medium text-foreground">添加封面图片</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">选择文件、拖拽图片到此处，或复制图片后直接粘贴</p>
                        <Button className="mt-3" icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>
                            选择图片
                        </Button>
                    </div>
                )}
            </div>
            <p className="text-xs text-muted-foreground">支持 PNG、JPG、WebP，最大 20MB；保存前不会上传。</p>
        </div>
    );
}

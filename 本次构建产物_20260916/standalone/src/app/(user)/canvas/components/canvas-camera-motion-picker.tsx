"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Camera, Plus, Search, Trash2, X } from "lucide-react";
import { Button, Modal } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { createMyPrompt, deleteMyPrompt, listMyPrompts } from "@/services/api/my-prompts";
import type { Prompt } from "@/services/api/prompts";
import { useThemeStore } from "@/stores/use-theme-store";
import { CANVAS_CAMERA_MOTIONS, DEFAULT_CAMERA_MOTION_PREVIEW, inferCameraMotionPreviewClass, type CanvasCameraMotionSelection } from "../utils/canvas-camera-motion";

const CAMERA_MOTION_CATEGORY = "运镜";

type PickerProps = {
    onChange: (value?: CanvasCameraMotionSelection) => void;
    onOpen?: () => void;
    trigger?: ReactNode;
};

export function CanvasCameraMotionPicker({ onChange, onOpen, trigger }: PickerProps) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<"plaza" | "mine">("plaza");
    const [query, setQuery] = useState("");
    const [myPrompts, setMyPrompts] = useState<Prompt[]>([]);
    const [loadingMine, setLoadingMine] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState("");
    const [customPrompt, setCustomPrompt] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const myMotions = useMemo(
        () => myPrompts.map((item) => ({ id: item.id, label: item.title, description: "我的运镜", prompt: item.prompt, previewClass: inferCameraMotionPreviewClass(item.prompt), previewImage: DEFAULT_CAMERA_MOTION_PREVIEW })),
        [myPrompts],
    );
    const motions = useMemo(() => {
        const source = tab === "plaza" ? CANVAS_CAMERA_MOTIONS : myMotions;
        const keyword = query.trim().toLowerCase();
        return keyword ? source.filter((item) => `${item.label} ${item.description} ${item.prompt}`.toLowerCase().includes(keyword)) : source;
    }, [myMotions, query, tab]);

    useEffect(() => {
        if (!open || tab !== "mine") return;
        let active = true;
        setLoadingMine(true);
        listMyPrompts({ page: 1, pageSize: 100, category: CAMERA_MOTION_CATEGORY, includeFacets: false })
            .then((result) => active && setMyPrompts(result.items))
            .catch((cause) => active && setError(cause instanceof Error ? cause.message : "我的运镜加载失败"))
            .finally(() => active && setLoadingMine(false));
        return () => {
            active = false;
        };
    }, [open, tab]);

    const saveCustomMotion = async () => {
        const title = name.trim();
        const prompt = customPrompt.trim();
        if (!title || !prompt) {
            setError("请填写运镜名称和运镜提示词");
            return;
        }
        setSaving(true);
        setError("");
        try {
            const created = await createMyPrompt({ title, prompt, category: CAMERA_MOTION_CATEGORY, tags: ["视频", "运镜"] });
            setMyPrompts((current) => [created, ...current]);
            setName("");
            setCustomPrompt("");
            setCreateOpen(false);
            setTab("mine");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "运镜保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <span
                className="inline-flex"
                onClick={(event) => {
                    event.stopPropagation();
                    onOpen?.();
                    setOpen(true);
                }}
            >
                {trigger || (
                    <button
                        type="button"
                        className="canvas-composer-settings flex h-8 max-w-[11rem] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition hover:border-[#5b5ce2]"
                        style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel, color: theme.node.text }}
                    >
                        <Camera className="size-3.5 text-[#5b5ce2]" />
                        <span className="truncate">添加运镜</span>
                    </button>
                )}
            </span>
            <Modal
                open={open}
                title={null}
                footer={null}
                centered
                destroyOnHidden
                width="min(920px, calc(100vw - 24px))"
                onCancel={() => setOpen(false)}
                styles={{ container: { padding: 0, overflow: "hidden", background: theme.toolbar.panel, border: `1px solid ${theme.toolbar.border}` }, body: { padding: 0 } }}
            >
                <div className="flex max-h-[min(720px,calc(100dvh-32px))] min-h-0 flex-col" style={{ color: theme.node.text }} data-canvas-camera-motion-picker>
                    <header className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: theme.toolbar.border }}>
                        <nav className="flex shrink-0 items-center gap-1 rounded-xl p-1" style={{ background: theme.node.fill }} aria-label="运镜分类">
                            {(
                                [
                                    ["plaza", "运镜广场"],
                                    ["mine", "我的运镜"],
                                ] as const
                            ).map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    className="rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                                    style={tab === id ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.muted }}
                                    onClick={() => setTab(id)}
                                >
                                    {label}
                                </button>
                            ))}
                        </nav>
                        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                            <Search className="size-4 opacity-45" />
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索运镜名称或提示词" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
                        </div>
                        <button type="button" className="grid size-8 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setOpen(false)} aria-label="关闭运镜选择">
                            <X className="size-4" />
                        </button>
                    </header>
                    <p className="px-4 pt-3 text-xs" style={{ color: theme.node.muted }}>
                        每张卡片均为循环动态预览；选择后会在当前光标位置插入运镜名称，生成时自动执行对应运镜。
                    </p>
                    {error ? <p className="mx-4 mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p> : null}
                    <div className="hide-scrollbar grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto p-4 sm:grid-cols-3 lg:grid-cols-4">
                        {tab === "mine" ? (
                            <button
                                type="button"
                                className="group grid min-h-40 place-items-center rounded-xl border border-dashed text-center transition hover:border-[#5b5ce2]"
                                style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}
                                onClick={() => {
                                    setError("");
                                    setCreateOpen(true);
                                }}
                            >
                                <span>
                                    <Plus className="mx-auto size-6 opacity-55" />
                                    <span className="mt-2 block text-xs font-semibold">新建运镜</span>
                                    <span className="mt-1 block text-[10px]" style={{ color: theme.node.muted }}>
                                        名称 + 可执行提示词
                                    </span>
                                </span>
                            </button>
                        ) : null}
                        {motions.map((motion, index) => {
                            return (
                                <button
                                    key={motion.id}
                                    type="button"
                                    className="group relative overflow-hidden rounded-xl border text-left transition hover:-translate-y-0.5"
                                    style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}
                                    onClick={() => {
                                        onChange(motion);
                                        setOpen(false);
                                    }}
                                >
                                    <span className="relative block aspect-[16/9] overflow-hidden bg-black" data-camera-motion-preview={motion.id}>
                                        <img
                                            src={motion.previewImage || DEFAULT_CAMERA_MOTION_PREVIEW}
                                            alt={`${motion.label}动态运镜预览`}
                                            className={`canvas-motion-preview-image size-full object-cover ${motion.previewClass}`}
                                            style={{ animationDelay: `${index * -0.37}s` }}
                                        />
                                        <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm">动态预览</span>
                                    </span>
                                    <span className="block px-2.5 py-2 pr-8">
                                        <span className="block text-xs font-semibold">{motion.label}</span>
                                        <span className="mt-0.5 block line-clamp-2 text-[10px] leading-4" style={{ color: theme.node.muted }}>
                                            {motion.prompt}
                                        </span>
                                    </span>
                                    {tab === "mine" ? (
                                        <span
                                            role="button"
                                            tabIndex={0}
                                            className="absolute bottom-2 right-2 grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-red-500/10 hover:text-red-500 hover:opacity-100"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                void deleteMyPrompt(motion.id)
                                                    .then(() => setMyPrompts((current) => current.filter((item) => item.id !== motion.id)))
                                                    .catch((cause) => setError(cause instanceof Error ? cause.message : "删除失败"));
                                            }}
                                            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.click()}
                                            aria-label={`删除运镜 ${motion.label}`}
                                        >
                                            <Trash2 className="size-3" />
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })}
                        {tab === "mine" && loadingMine ? (
                            <div className="col-span-full py-8 text-center text-xs" style={{ color: theme.node.muted }}>
                                正在加载我的运镜…
                            </div>
                        ) : null}
                        {tab === "mine" && !loadingMine && !myMotions.length ? (
                            <div className="col-span-full py-8 text-center text-xs" style={{ color: theme.node.muted }}>
                                还没有自定义运镜，点击“新建运镜”开始创建。
                            </div>
                        ) : null}
                    </div>
                </div>
            </Modal>
            <Modal open={createOpen} title="新建自定义运镜" footer={null} centered destroyOnHidden width="min(560px, calc(100vw - 24px))" onCancel={() => setCreateOpen(false)}>
                <div className="grid gap-4 pt-2">
                    <div className="overflow-hidden rounded-xl bg-black" data-canvas-camera-motion-picker>
                        <img src={DEFAULT_CAMERA_MOTION_PREVIEW} alt="自定义运镜动态预览" className={`canvas-motion-preview-image aspect-video w-full object-cover ${inferCameraMotionPreviewClass(customPrompt)}`} />
                    </div>
                    <label className="grid gap-1.5 text-sm font-medium">
                        运镜名称
                        <input
                            value={name}
                            maxLength={40}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="例如：低机位快速跟拍"
                            className="h-10 rounded-lg border border-black/10 bg-transparent px-3 outline-none transition focus:border-[#5b5ce2] dark:border-white/15"
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                        运镜提示词
                        <textarea
                            value={customPrompt}
                            maxLength={800}
                            rows={5}
                            onChange={(event) => setCustomPrompt(event.target.value)}
                            placeholder="描述摄影机的方向、速度、景别变化、稳定方式、起止点和主体关系"
                            className="resize-none rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-[#5b5ce2] dark:border-white/15"
                        />
                    </label>
                    {error ? <p className="text-xs text-red-500">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button onClick={() => setCreateOpen(false)}>取消</Button>
                        <Button type="primary" loading={saving} onClick={() => void saveCustomMotion()}>
                            保存运镜
                        </Button>
                    </div>
                </div>
            </Modal>
        </>
    );
}

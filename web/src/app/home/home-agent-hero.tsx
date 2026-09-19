"use client";

import { App, Popover } from "antd";
import { Check, ChevronDown, Clapperboard, Frame, Image as ImageIcon, Layers, Loader2, Plus, SlidersHorizontal, Sparkles, UsersRound, Video, WandSparkles, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";

import { useCreateDraftAttachmentsStore } from "@/app/(user)/create/use-create-draft-attachments-store";
import { useCreativeAgentModels } from "@/hooks/use-creative-agent-options";
import { ModelPicker } from "@/components/model-picker";
import { CreativeGenerationPreferences } from "@/components/creative-generation-preferences";
import { useConfigStore } from "@/stores/use-config-store";
import { formatCreditAmount, requestCreditCost } from "@/constant/credits";
import { DreamyoIcon, type DreamyoIconName } from "@/components/ui/dreamyo-icon";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { listAgentSkills, type AgentSkillSummary } from "@/services/api/agent-skills";
import { HOME_CREATION_MODES, type HomeCreationMode } from "./home-data";
import { SiteLogo } from "@/components/layout/site-logo";
import { useHomeActions } from "./home-actions";
import styles from "./home-agent-hero.module.css";

const IMAGE_PROMPT_HINTS = [
    "描述你的创意构想，例如：赛博朋克雨夜街道，电影级光影与霓虹倒影...",
    "可输入主体、构图、光线与画质细节，左侧 + 号支持拖拽或直接 Ctrl+V 粘贴参考图...",
    "支持风格定制，例如：国风重彩工笔画、超写实 8K 人像、3D 粘土潮玩手办...",
    "也可以输入色彩基调与细节要求，AI 将为你智能规划最佳模型与参数...",
];

const VIDEO_PROMPT_HINTS = [
    "描述你想创作的动态视频，例如：电影感慢动作特写，星空下的光影穿梭...",
    "可指定运镜方式：推镜头特写、升降俯瞰环绕、平滑摇镜追踪与时序演变...",
    "点击左侧 + 号上传首帧参考图，AI 即可根据画面流畅延展逼真动态视频...",
    "支持输入角色微表情、环境物理碰撞与光影变换等细致动作描述...",
];

const MODE_ICONS = { agent: "magic", image: "image", video: "video", audio: "audio" } as const satisfies Record<HomeCreationMode, DreamyoIconName>;
const MODEL_CAPABILITIES = ["image", "video", "audio"] as const;
type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
type SkillCategory = "all" | "image" | "video" | "canvas" | "drama" | "edit";

const shortcuts: Array<{ label: string; detail: string; icon: LucideIcon; mode?: HomeCreationMode; path?: string }> = [
    { label: "图片生成", detail: "从想法到视觉", icon: ImageIcon, mode: "image" },
    { label: "视频生成", detail: "让画面动起来", icon: Video, mode: "video" },
    { label: "智能画布", detail: "无限创意连接", icon: Frame, path: "/canvas" },
    { label: "短剧创作", detail: "一键成片", icon: Clapperboard, path: "/drama" },
    { label: "角色设计", detail: "虚拟角色生成", icon: UsersRound, mode: "agent" },
    { label: "创意社区", detail: "发现更多灵感", icon: Sparkles, path: "/community" },
];

export function HomeAgentHero() {
    const { message } = App.useApp();
    const router = useRouter();
    const [mode, setMode] = useState<"image" | "video">("image");
    const [prompt, setPrompt] = useState("");
    const [sourceFile, setSourceFile] = useState<File>();
    const [skillMenuOpen, setSkillMenuOpen] = useState(false);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [modeMenuOpen, setModeMenuOpen] = useState(false);
    const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(false);
    const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
    const [selectedModelId, setSelectedModelId] = useState("");
    const [skillCategory, setSkillCategory] = useState<SkillCategory>("all");
    const [modelCapability, setModelCapability] = useState<ModelCapability>("image");
    const [aspectRatio, setAspectRatio] = useState("1:1");
    const [duration, setDuration] = useState("5");
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [pageHidden, setPageHidden] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [activeHintIndex, setActiveHintIndex] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const motionRef = useRef<HTMLDivElement>(null);
    const pointerRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0 });
    const { authenticated, sessionReady, site, openLogin, startCreating, createCanvasAndGenerate, openProtectedPath } = useHomeActions();
    const [submitting, setSubmitting] = useState(false);
    const config = useConfigStore((state) => state.config);
    const models = useCreativeAgentModels();
    const selectedMode = HOME_CREATION_MODES.find((item) => item.id === mode) || HOME_CREATION_MODES[0];
    const selectedModel = models.find((item) => item.id === selectedModelId);
    const skillCategories = homeSkillCategories(skills);
    const visibleSkills = skills.filter((skill) => homeSkillMatchesCategory(skill, skillCategory));
    const visibleModels = models.filter((model) => model.capability === modelCapability);
    const isVideoMode = mode === "video" || selectedModel?.capability === "video";
    const credits = requestCreditCost({
        apiSource: config.apiSource,
        modelPointCosts: config.modelPointCosts,
        generationPointMultipliers: config.generationPointMultipliers,
        kind: isVideoMode ? "video" : "image",
        model: selectedModelId || config.model,
        count: 1,
        quality: isVideoMode ? undefined : "high",
        videoQuality: isVideoMode ? "1080" : undefined,
        videoSeconds: isVideoMode ? Number(duration) || 5 : undefined,
    });

    useEffect(() => {
        if (visibleModels.length > 0 && !visibleModels.some((m) => m.id === selectedModelId)) {
            setSelectedModelId(visibleModels[0].id);
        }
    }, [visibleModels, selectedModelId]);

    useEffect(() => {
        if (!authenticated) {
            setSkills([]);
            setSkillsLoading(false);
            return;
        }
        let active = true;
        setSkillsLoading(true);
        void listAgentSkills("all")
            .then((items) => {
                if (active) setSkills(items);
            })
            .catch(() => {
                if (active) setSkills([]);
            })
            .finally(() => {
                if (active) setSkillsLoading(false);
            });
        return () => {
            active = false;
        };
    }, [authenticated]);

    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        let frame = 0;
        const animate = () => {
            if (document.hidden) {
                frame = 0;
                return;
            }
            const pointer = pointerRef.current;
            pointer.x += (pointer.targetX - pointer.x) * 0.075;
            pointer.y += (pointer.targetY - pointer.y) * 0.075;
            motionRef.current?.style.setProperty("--pointer-x", `${pointer.x * 28}px`);
            motionRef.current?.style.setProperty("--pointer-y", `${pointer.y * 18}px`);
            frame = window.requestAnimationFrame(animate);
        };
        const resume = () => {
            if (!document.hidden && !frame) frame = window.requestAnimationFrame(animate);
        };
        const pause = () => {
            if (document.hidden && frame) {
                window.cancelAnimationFrame(frame);
                frame = 0;
            }
        };
        frame = window.requestAnimationFrame(animate);
        document.addEventListener("visibilitychange", resume);
        document.addEventListener("visibilitychange", pause);
        return () => {
            window.cancelAnimationFrame(frame);
            document.removeEventListener("visibilitychange", resume);
            document.removeEventListener("visibilitychange", pause);
        };
    }, []);

    useEffect(() => {
        const updateVisibility = () => setPageHidden(document.hidden);
        updateVisibility();
        document.addEventListener("visibilitychange", updateVisibility);
        return () => document.removeEventListener("visibilitychange", updateVisibility);
    }, []);

    useEffect(() => {
        const stage = motionRef.current;
        if (!stage) return;
        const hideBrokenImage = (event: Event) => {
            const image = event.currentTarget as HTMLImageElement;
            if (!image.naturalWidth) image.style.display = "none";
        };
        const images = [...stage.querySelectorAll<HTMLImageElement>("img")];
        images.forEach((image) => {
            if (image.complete && !image.naturalWidth) image.style.display = "none";
            image.addEventListener("error", hideBrokenImage);
        });
        return () => images.forEach((image) => image.removeEventListener("error", hideBrokenImage));
    }, []);

    // 监听灵感发现等外部组件触发的“做同款”带入提示词事件
    useEffect(() => {
        const handleApplyPrompt = (event: Event) => {
            const customEvent = event as CustomEvent<{ prompt: string; mode?: "image" | "video" }>;
            if (customEvent.detail?.prompt) {
                setPrompt(customEvent.detail.prompt);
                if (customEvent.detail.mode) {
                    setMode(customEvent.detail.mode);
                }
                window.scrollTo({ top: 0, behavior: "smooth" });
                setTimeout(() => {
                    textareaRef.current?.focus();
                }, 150);
            }
        };

        window.addEventListener("dreamyo:apply-prompt", handleApplyPrompt);
        return () => window.removeEventListener("dreamyo:apply-prompt", handleApplyPrompt);
    }, []);

    const trackPointer = (event: PointerEvent<HTMLElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        pointerRef.current.targetX = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
        pointerRef.current.targetY = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
    };

    const resetPointer = () => {
        pointerRef.current.targetX = 0;
        pointerRef.current.targetY = 0;
    };

    const chooseFile = (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
            message.error("请选择图片或视频素材");
            return;
        }
        if (file.size > CREATIVE_UPLOAD_MAX_BYTES) {
            message.error(`参考素材不能超过 ${Math.round(CREATIVE_UPLOAD_MAX_BYTES / 1024 / 1024)}MB`);
            return;
        }
        setSourceFile(file);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(file));
    };

    const removeFile = () => {
        setSourceFile(undefined);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const activeHints = mode === "video" ? VIDEO_PROMPT_HINTS : IMAGE_PROMPT_HINTS;

    useEffect(() => {
        setActiveHintIndex(0);
    }, [mode]);

    useEffect(() => {
        if (prompt.length > 0) return;
        const timer = setInterval(() => {
            setActiveHintIndex((prev) => (prev + 1) % activeHints.length);
        }, 3800);
        return () => clearInterval(timer);
    }, [prompt.length, activeHints.length]);

    const handleDrop = (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) {
            chooseFile(file);
            message.success("已添加参考素材");
        }
    };

    const handlePaste = (event: React.ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                    event.preventDefault();
                    chooseFile(file);
                    message.success("已从剪贴板粘贴参考素材");
                    return;
                }
            }
        }
    };

    const submit = async () => {
        if (!prompt.trim()) {
            message.warning("请先描述你想创作的内容");
            textareaRef.current?.focus();
            return;
        }
        if (!authenticated) {
            openLogin("/canvas");
            return;
        }
        setSubmitting(true);
        try {
            const isVideo = mode === "video" || selectedModel?.capability === "video";
            await createCanvasAndGenerate({
                prompt: prompt.trim(),
                type: isVideo ? "video" : "image",
                modelIds: selectedModelId ? [selectedModelId] : [],
                skillIds: selectedSkillIds,
                aspectRatio,
                duration: isVideo ? duration : undefined,
            });
        } catch (err: any) {
            message.error(err?.message || "创建画布失败，请重试");
        } finally {
            setSubmitting(false);
        }
    };

    const activateShortcut = (shortcut: (typeof shortcuts)[number]) => {
        if (shortcut.path) {
            if (shortcut.path === "/community") router.push("/community");
            else if (shortcut.path === "/create") router.push("/canvas");
            else openProtectedPath(shortcut.path);
            return;
        }
        if (shortcut.mode) {
            const targetMode = shortcut.mode === "video" ? "video" : "image";
            setMode(targetMode);
            setModelCapability(targetMode);
        }
        textareaRef.current?.focus();
    };

    return (
        <section className={styles.hero} data-page-hidden={pageHidden ? "true" : undefined} aria-labelledby="home-hero-title" onPointerMove={trackPointer} onPointerLeave={resetPointer}>
            <div ref={motionRef} className={styles.motionStage} data-testid="home-agent-halo" aria-hidden="true">
                <span className="octal-ambient__glow octal-ambient__glow--cyan" style={{ width: 680, height: 680, top: "4%", left: "6%", opacity: 0.4 }} />
                <span className="octal-ambient__glow octal-ambient__glow--purple" style={{ width: 750, height: 750, top: "12%", right: "6%", opacity: 0.5 }} />
            </div>

            <div className={styles.heroContent}>
                <div className={styles.heroCopy}>
                    <SiteLogo logoUrl={site?.logoUrl || "/brand/dreamyo/mark.png"} className={styles.heroMark} />
                    <h1 id="home-hero-title" className={styles.heroTitle}>把灵感，变成作品</h1>
                    <p className={styles.heroSubtitle}>从一个想法开始，让 AI 帮你完成创作。</p>
                </div>

                <div className={styles.composerWrap}>
                    <div className={styles.composerGlow} aria-hidden="true" />
                    <div className={styles.composer} data-testid="home-agent-card">
                        {/* 顶部行：图片/视频切换 + Skill（原对话/快速/电商套图分段已移除） */}
                        <div className="mb-4 flex items-center justify-between gap-2">
                            <div className="inline-flex p-0.5 rounded-full border border-white/10 bg-slate-950/70 backdrop-blur-md shadow-inner shrink-0">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMode("image");
                                        setModelCapability("image");
                                    }}
                                    className={clsx(
                                        "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all select-none",
                                        mode === "image" ? styles.modeToggleActive : styles.modeToggleIdle,
                                    )}
                                >
                                    <ImageIcon className="size-3.5" />
                                    <span>图片</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMode("video");
                                        setModelCapability("video");
                                    }}
                                    className={clsx(
                                        "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all select-none",
                                        mode === "video" ? styles.modeToggleActive : styles.modeToggleIdle,
                                    )}
                                >
                                    <Video className="size-3.5" />
                                    <span>视频</span>
                                </button>
                            </div>

                            {/* Skill 选择胶囊 */}
                            <Popover
                                trigger="click"
                                placement="bottomRight"
                                arrow={false}
                                open={skillMenuOpen}
                                onOpenChange={(open) => {
                                    setSkillMenuOpen(open);
                                    if (open) {
                                        setModeMenuOpen(false);
                                        setModelMenuOpen(false);
                                    }
                                }}
                                styles={{ container: { background: "transparent", boxShadow: "none", padding: 0 } }}
                                content={
                                    <div className={styles.pickerPanel} data-testid="home-skill-picker">
                                        <div className={styles.pickerHeader}>
                                            <div>
                                                <strong>Skill</strong>
                                                <span>组合适合当前任务的创作能力</span>
                                            </div>
                                            {selectedSkillIds.length ? <small>已选 {selectedSkillIds.length}</small> : null}
                                        </div>
                                        {!sessionReady || skillsLoading ? <div className={styles.pickerEmpty}>正在载入创作能力...</div> : null}
                                        {sessionReady && !authenticated ? <HomeLoginPrompt onLogin={() => openLogin("/create")} /> : null}
                                        {authenticated && skills.length ? (
                                            <>
                                                <div className={styles.pickerTabs} role="tablist" aria-label="Skill 分类">
                                                    {skillCategories.map((category) => (
                                                        <button key={category.id} type="button" role="tab" aria-selected={skillCategory === category.id} onClick={() => setSkillCategory(category.id)}>
                                                            {category.label}
                                                            <span>{category.count}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                                <div className={styles.pickerList}>
                                                    {visibleSkills.map((skill) => {
                                                        const selected = selectedSkillIds.includes(skill.id);
                                                        return (
                                                            <button
                                                                key={skill.id}
                                                                type="button"
                                                                className={selected ? styles.pickerItemSelected : undefined}
                                                                aria-pressed={selected}
                                                                onClick={() => setSelectedSkillIds((current) => (selected ? current.filter((id) => id !== skill.id) : [...current, skill.id].slice(0, 8)))}
                                                            >
                                                                {skill.previewImageUrl ? (
                                                                    <img src={skill.previewImageUrl} alt="" loading="lazy" />
                                                                ) : (
                                                                    <span className={styles.pickerItemIcon}>
                                                                        <DreamyoIcon name="magic" size={22} />
                                                                    </span>
                                                                )}
                                                                <span className={styles.pickerItemCopy}>
                                                                    <strong>{skill.name}</strong>
                                                                    <small>{skill.description}</small>
                                                                </span>
                                                                <span className={styles.pickerItemAction}>{selected ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </>
                                        ) : null}
                                        {authenticated && !skillsLoading && !skills.length ? <div className={styles.pickerEmpty}>暂无可用 Skill</div> : null}
                                    </div>
                                }
                            >
                                <button type="button" className={`${styles.toolControl} ${skillMenuOpen ? styles.toolControlActive : ""}`} aria-expanded={skillMenuOpen}>
                                    <WandSparkles size={15} aria-hidden="true" />
                                    <span>Skill{selectedSkillIds.length ? ` · ${selectedSkillIds.length}` : ""}</span>
                                    <ChevronDown size={13} aria-hidden="true" />
                                </button>
                            </Popover>
                        </div>

                        <div className="flex items-start gap-3.5 w-full">
                            {/* 参考素材加号小框 (参考 jiaotu.ai 规范，支持点击、拖拽与粘贴) */}
                            <div
                                className={clsx(
                                    "group relative flex flex-col items-center justify-center shrink-0 rounded-2xl border-2 border-dashed transition-all cursor-pointer select-none overflow-hidden",
                                    isDragging
                                        ? "border-cyan-400 bg-cyan-500/15 shadow-[0_0_20px_rgba(83,217,255,0.3)] scale-[1.02]"
                                        : previewUrl
                                        ? "border-cyan-500/40 bg-black/40"
                                        : "border-zinc-700/60 hover:border-cyan-400/60 bg-zinc-900/40 hover:bg-zinc-800/60"
                                )}
                                style={{ width: "80px", height: "80px" }}
                                onClick={() => fileInputRef.current?.click()}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    setIsDragging(true);
                                }}
                                onDragEnter={(e) => {
                                    e.preventDefault();
                                    setIsDragging(true);
                                }}
                                onDragLeave={(e) => {
                                    e.preventDefault();
                                    setIsDragging(false);
                                }}
                                onDrop={handleDrop}
                                title="点击选择文件、拖拽图片到此处，或在输入框中直接 Ctrl+V 粘贴"
                            >
                                {previewUrl ? (
                                    <div className="relative w-full h-full group/img">
                                        <img src={previewUrl} alt="参考素材" className="w-full h-full object-cover" />
                                        <button
                                            type="button"
                                            aria-label="移除参考素材"
                                            className="absolute top-1 right-1 size-5 rounded-full bg-black/75 hover:bg-red-500 text-white flex items-center justify-center transition-colors shadow-md"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                removeFile();
                                            }}
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center justify-center gap-1.5 text-zinc-400 group-hover:text-cyan-300 transition-colors p-1 text-center">
                                        <div className="size-6 rounded-full bg-white/5 group-hover:bg-cyan-500/20 flex items-center justify-center transition-all">
                                            <Plus size={15} className="stroke-[2.5]" />
                                        </div>
                                        <span className="text-[11px] font-medium tracking-tight">添加素材</span>
                                    </div>
                                )}
                            </div>

                            {/* 提示词输入区 + 动态创意引导 Placeholder (参考 jiaotu.ai) */}
                            <div
                                className={clsx(styles.promptField, "relative flex-1 min-w-0")}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    setIsDragging(true);
                                }}
                                onDragLeave={(e) => {
                                    e.preventDefault();
                                    setIsDragging(false);
                                }}
                                onDrop={handleDrop}
                            >
                                <textarea
                                    id="home-agent-prompt"
                                    ref={textareaRef}
                                    value={prompt}
                                    maxLength={2000}
                                    aria-label="描述你想创作的内容"
                                    placeholder=""
                                    onChange={(event) => setPrompt(event.target.value)}
                                    onPaste={handlePaste}
                                    onKeyDown={(event) => {
                                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
                                    }}
                                />
                                {prompt.length === 0 && (
                                    <div
                                        className="pointer-events-none absolute left-0 top-0 w-full overflow-hidden select-none pr-4"
                                        style={{ height: "84px" }}
                                    >
                                        <div
                                            key={`${mode}-${activeHintIndex}`}
                                            className="animate-in fade-in slide-in-from-bottom-1 duration-500 text-[14px] leading-relaxed text-zinc-500/90 line-clamp-3"
                                        >
                                            {activeHints[activeHintIndex % activeHints.length]}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className={styles.composerToolbar}>
                            <div className={styles.leftControls}>
                                {/* 1. 模型选择胶囊 */}
                                <ModelPicker
                                    className={`${styles.toolControl} font-medium`}
                                    config={config}
                                    value={selectedModelId || config.model}
                                    onChange={(modelId) => setSelectedModelId(modelId)}
                                    capability={mode === "video" ? "video" : "image"}
                                />


                                {/* 4. 统一参数设置胶囊（比例、画质、时长融合在单一弹出层中，参考画布偏好设置） */}
                                <CreativeGenerationPreferences
                                    capability={mode === "video" ? "video" : "image"}
                                    preferences={{
                                        mode: mode === "video" ? "video" : "image",
                                        image: { size: aspectRatio, quality: "high", count: 1 },
                                        video: { size: aspectRatio, quality: "1080", seconds: Number(duration) || 5, generateAudio: true, watermark: false },
                                    }}
                                    triggerIcon={<SlidersHorizontal className="size-3.5 text-cyan-400" />}
                                    triggerLabel={mode === "video" ? `${aspectRatio} · ${duration}s` : `${aspectRatio} · 高画质`}
                                    triggerClassName={clsx(
                                        styles.toolControl,
                                        "!h-[36px] !px-3 !rounded-full !text-[13px] !flex !flex-row !items-center !flex-nowrap whitespace-nowrap shrink-0 border border-white/10 bg-white/5 hover:bg-white/10 text-zinc-200 font-medium",
                                    )}
                                    showTriggerChevron={false}
                                    placement="top"
                                    tabless
                                    autoAdjustOverflow
                                    onChange={(patch) => {
                                        if (patch.size) setAspectRatio(patch.size);
                                        if (patch.seconds) setDuration(String(patch.seconds));
                                    }}
                                />

                                {/* 隐藏的文件输入组件 */}
                                <input ref={fileInputRef} className={styles.hiddenInput} type="file" accept="image/*,video/mp4,video/quicktime,video/webm" onChange={(event) => chooseFile(event.target.files?.[0])} />
                            </div>

                            <div className={styles.rightControls}>
                                {/* 消耗 + 生成提交组合：左侧堆叠图标与积分数字，右侧玫红圆形箭头按钮（参考图2形式） */}
                                <div
                                    className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 py-1 pl-4 shadow-lg"
                                    style={{ background: "rgba(18, 21, 31, 0.92)" }}
                                    title={`本次生成预计消耗 ${formatCreditAmount(credits)} 积分`}
                                >
                                    <Layers className="size-4 text-zinc-300" aria-hidden="true" />
                                    <span data-home-credit-cost className="mr-1.5 text-sm font-semibold leading-none tabular-nums text-zinc-100">
                                        {formatCreditAmount(credits)}
                                    </span>
                                    <button
                                        type="button"
                                        className="grid size-9 place-items-center rounded-full transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                                        style={{
                                            background: "linear-gradient(135deg, #4e46e9, #6e53f6 55%, #8979ff)",
                                            border: "1px solid rgba(255, 255, 255, 0.24)",
                                            boxShadow: "0 0 16px rgba(98, 82, 255, 0.5), inset 0 1px rgba(255, 255, 255, 0.35)",
                                        }}
                                        aria-label="立即生成"
                                        disabled={submitting || (!prompt.trim() && !sourceFile)}
                                        onClick={submit}
                                    >
                                        {submitting ? (
                                            <Loader2 className="size-4 animate-spin text-white" />
                                        ) : (
                                            <img src="/brand/dreamyo/generation/generate-glyph.png" alt="" aria-hidden="true" width={20} height={20} />
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 底部微型引导 (极简留白，移除下方杂乱大排推荐卡片) */}
                <div className="mt-7 flex items-center justify-center gap-2 text-xs text-zinc-400 select-none">
                    <span className="inline-block size-1.5 rounded-full bg-cyan-400/80 animate-pulse" />
                    <span>支持文生图、图生图、视频生成与多模态智能创作，一键开启灵感画布</span>
                </div>
            </div>
        </section>
    );
}

function HomeLoginPrompt({ onLogin }: { onLogin: () => void }) {
    return (
        <div className={styles.loginPrompt}>
            <span>登录后查看当前可用的 Skill 与模型</span>
            <button type="button" onClick={onLogin}>
                立即登录
            </button>
        </div>
    );
}

function HomeModelIcon({ capability }: { capability: ModelCapability }) {
    return <DreamyoIcon name={capability} size={22} />;
}

function homeSkillCategories(skills: AgentSkillSummary[]) {
    const categories: Array<{ id: SkillCategory; label: string }> = [
        { id: "all", label: "全部" },
        { id: "image", label: "图片" },
        { id: "video", label: "视频" },
        { id: "canvas", label: "画布" },
        { id: "drama", label: "短剧" },
        { id: "edit", label: "编辑" },
    ];
    return categories.map((category) => ({ ...category, count: skills.filter((skill) => homeSkillMatchesCategory(skill, category.id)).length })).filter((category) => category.id === "all" || category.count > 0);
}

function homeSkillMatchesCategory(skill: AgentSkillSummary, category: SkillCategory) {
    if (category === "all") return true;
    if (category === "edit") return skill.action === "edit";
    return skill.workspaces?.includes(category) || false;
}

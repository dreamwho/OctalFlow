"use client";

import { App, Popover } from "antd";
import { AudioLines, Box, Boxes, Check, ChevronDown, Film, Image as ImageIcon, Paperclip, PenLine, Plus, Send, Sparkles, Video, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { useCreateDraftAttachmentsStore } from "@/app/(user)/create/use-create-draft-attachments-store";
import { useCreativeAgentModels } from "@/hooks/use-creative-agent-options";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { listAgentSkills, type AgentSkillSummary } from "@/services/api/agent-skills";
import { HOME_CREATION_MODES, type HomeCreationMode } from "./home-data";
import { useHomeActions } from "./home-actions";
import styles from "./home-agent-hero.module.css";

const MODE_ICONS = { agent: Sparkles, image: ImageIcon, video: Video, audio: AudioLines } as const;
const MODEL_CAPABILITIES = ["image", "video", "audio"] as const;
type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
type SkillCategory = "all" | "image" | "video" | "canvas" | "drama" | "edit";

const shortcuts: Array<{ label: string; detail: string; icon: typeof Sparkles; mode?: HomeCreationMode; path?: string }> = [
    { label: "爆款复刻", detail: "复刻结构与节奏", icon: Boxes, mode: "video" },
    { label: "图片生成", detail: "从想法生成作品", icon: ImageIcon, mode: "image" },
    { label: "视频生成", detail: "文字生成动态影像", icon: Film, mode: "video" },
    { label: "智能画布", detail: "无限画布，自由创作", icon: PenLine, path: "/canvas" },
];

export function HomeAgentHero() {
    const { message } = App.useApp();
    const [mode, setMode] = useState<HomeCreationMode>("agent");
    const [prompt, setPrompt] = useState("");
    const [sourceFile, setSourceFile] = useState<File>();
    const [skillMenuOpen, setSkillMenuOpen] = useState(false);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(false);
    const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
    const [selectedModelId, setSelectedModelId] = useState("");
    const [skillCategory, setSkillCategory] = useState<SkillCategory>("all");
    const [modelCapability, setModelCapability] = useState<ModelCapability>("image");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const motionRef = useRef<HTMLDivElement>(null);
    const pointerRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0 });
    const { authenticated, sessionReady, openLogin, startCreating, openProtectedPath } = useHomeActions();
    const models = useCreativeAgentModels();
    const selectedMode = HOME_CREATION_MODES.find((item) => item.id === mode) || HOME_CREATION_MODES[0];
    const selectedModel = models.find((item) => item.id === selectedModelId);
    const skillCategories = homeSkillCategories(skills);
    const visibleSkills = skills.filter((skill) => homeSkillMatchesCategory(skill, skillCategory));
    const visibleModels = models.filter((model) => model.capability === modelCapability);

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
            const pointer = pointerRef.current;
            pointer.x += (pointer.targetX - pointer.x) * 0.075;
            pointer.y += (pointer.targetY - pointer.y) * 0.075;
            motionRef.current?.style.setProperty("--pointer-x", `${pointer.x * 28}px`);
            motionRef.current?.style.setProperty("--pointer-y", `${pointer.y * 18}px`);
            frame = window.requestAnimationFrame(animate);
        };
        frame = window.requestAnimationFrame(animate);
        return () => window.cancelAnimationFrame(frame);
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
    };

    const submit = () => {
        if (!prompt.trim()) {
            message.warning("请先描述你想创作的内容");
            textareaRef.current?.focus();
            return;
        }
        if (sourceFile) useCreateDraftAttachmentsStore.getState().add([sourceFile], "");
        startCreating(prompt.trim(), mode, { skillIds: selectedSkillIds, modelIds: selectedModelId ? [selectedModelId] : [] });
    };

    const activateShortcut = (shortcut: (typeof shortcuts)[number]) => {
        if (shortcut.path) {
            openProtectedPath(shortcut.path);
            return;
        }
        if (shortcut.mode) setMode(shortcut.mode);
        if (shortcut.label === "爆款复刻") setPrompt((current) => current || "复刻参考内容的爆款结构与节奏，生成全新的原创作品");
        textareaRef.current?.focus();
    };

    return (
        <section className={styles.hero} aria-labelledby="home-hero-title" onPointerMove={trackPointer} onPointerLeave={resetPointer}>
            <div ref={motionRef} className={styles.motionStage} data-testid="home-agent-halo" aria-hidden="true">
                <video className={styles.motionVideo} src="/brand/octaflow-particle-infinity.mp4" autoPlay muted loop playsInline preload="auto" />
                <span data-halo-ring className={styles.motionVeil} />
                <span data-halo-ring className={styles.motionBloom} />
                <span data-halo-ring className={styles.motionLeft} />
                <span data-halo-ring className={styles.motionRight} />
            </div>

            <div className={styles.heroContent}>
                <p className={styles.eyebrow}>OCTALFLOW · AI CREATIVE SPACE</p>
                <h1 id="home-hero-title" className={styles.heroTitle}>把灵感，变成作品</h1>
                <p className={styles.heroSubtitle}>从一个想法开始，让 AI 帮你完成创作。</p>

                <div className={styles.composerWrap}>
                    <div className={styles.composerGlow} aria-hidden="true" />
                    <div className={styles.composer} data-testid="home-agent-card">
                        <textarea
                            id="home-agent-prompt"
                            ref={textareaRef}
                            value={prompt}
                            maxLength={2000}
                            aria-label="描述你想创作的内容"
                            placeholder="描述你想创作的内容，比如："
                            onChange={(event) => setPrompt(event.target.value)}
                            onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
                            }}
                        />
                        <div className={styles.examplePrompts} aria-label="示例提示词">
                            {selectedMode.examples.slice(0, 4).map((example) => (
                                <button key={example} type="button" onClick={() => setPrompt(example)}>{example}</button>
                            ))}
                        </div>

                        <div className={styles.composerToolbar}>
                            <div className={styles.leftControls}>
                                <button type="button" className={styles.iconControl} aria-label="进入创作页添加参考素材" onClick={() => fileInputRef.current?.click()}>
                                    <Paperclip aria-hidden="true" />
                                    {sourceFile ? <span className={styles.fileDot} aria-label="已选择素材" /> : null}
                                </button>
                                <input ref={fileInputRef} className={styles.hiddenInput} type="file" accept="image/*,video/mp4,video/quicktime,video/webm" onChange={(event) => chooseFile(event.target.files?.[0])} />
                                <Popover
                                    trigger="click"
                                    placement="bottomLeft"
                                    arrow={false}
                                    open={skillMenuOpen}
                                    onOpenChange={(open) => {
                                        setSkillMenuOpen(open);
                                        if (open) setModelMenuOpen(false);
                                    }}
                                    styles={{ container: { background: "transparent", boxShadow: "none", padding: 0 } }}
                                    content={
                                        <div className={styles.pickerPanel} data-testid="home-skill-picker">
                                            <div className={styles.pickerHeader}>
                                                <div><strong>Skill</strong><span>组合适合当前任务的创作能力</span></div>
                                                {selectedSkillIds.length ? <small>已选 {selectedSkillIds.length}</small> : null}
                                            </div>
                                            {!sessionReady || skillsLoading ? <div className={styles.pickerEmpty}>正在载入创作能力...</div> : null}
                                            {sessionReady && !authenticated ? <HomeLoginPrompt onLogin={() => openLogin("/create")} /> : null}
                                            {authenticated && skills.length ? (
                                                <>
                                                    <div className={styles.pickerTabs} role="tablist" aria-label="Skill 分类">
                                                        {skillCategories.map((category) => (
                                                            <button key={category.id} type="button" role="tab" aria-selected={skillCategory === category.id} onClick={() => setSkillCategory(category.id)}>
                                                                {category.label}<span>{category.count}</span>
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
                                                                    {skill.previewImageUrl ? <img src={skill.previewImageUrl} alt="" loading="lazy" /> : <span className={styles.pickerItemIcon}><WandSparkles aria-hidden="true" /></span>}
                                                                    <span className={styles.pickerItemCopy}><strong>{skill.name}</strong><small>{skill.description}</small></span>
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
                                        <WandSparkles aria-hidden="true" /><span>Skill{selectedSkillIds.length ? ` · ${selectedSkillIds.length}` : ""}</span><ChevronDown aria-hidden="true" />
                                    </button>
                                </Popover>
                                <Popover
                                    trigger="click"
                                    placement="bottomLeft"
                                    arrow={false}
                                    open={modelMenuOpen}
                                    onOpenChange={(open) => {
                                        setModelMenuOpen(open);
                                        if (open) setSkillMenuOpen(false);
                                    }}
                                    styles={{ container: { background: "transparent", boxShadow: "none", padding: 0 } }}
                                    content={
                                        <div className={`${styles.pickerPanel} ${styles.modelPickerPanel}`} data-testid="home-model-picker">
                                            <div className={styles.pickerHeader}><div><strong>模型</strong><span>{selectedModel ? "已指定模型，进入创作页后仍可调整" : "默认由 Agent 智能规划"}</span></div></div>
                                            {sessionReady && !authenticated ? <HomeLoginPrompt onLogin={() => openLogin("/create")} /> : null}
                                            {authenticated ? (
                                                <>
                                                    <div className={styles.pickerTabs} role="tablist" aria-label="模型能力分类">
                                                        {MODEL_CAPABILITIES.map((capability) => (
                                                            <button key={capability} type="button" role="tab" aria-selected={modelCapability === capability} onClick={() => setModelCapability(capability)}>
                                                                {capability === "image" ? "图片" : capability === "video" ? "视频" : "音频"}<span>{models.filter((item) => item.capability === capability).length}</span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                    <div className={styles.pickerList}>
                                                        <button type="button" className={!selectedModelId ? styles.pickerItemSelected : undefined} aria-pressed={!selectedModelId} onClick={() => setSelectedModelId("")}>
                                                            <span className={styles.pickerItemIcon}><Sparkles aria-hidden="true" /></span>
                                                            <span className={styles.pickerItemCopy}><strong>智能规划</strong><small>根据需求自动选择最合适的模型与参数</small></span>
                                                            <span className={styles.pickerItemAction}>{!selectedModelId ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}</span>
                                                        </button>
                                                        {visibleModels.map((model) => {
                                                            const selected = selectedModelId === model.id;
                                                            return (
                                                                <button key={model.id} type="button" className={selected ? styles.pickerItemSelected : undefined} aria-pressed={selected} onClick={() => setSelectedModelId(selected ? "" : model.id)}>
                                                                    <span className={`${styles.pickerItemIcon} ${styles.modelIcon}`}><HomeModelIcon capability={model.capability} /></span>
                                                                    <span className={styles.pickerItemCopy}><strong>{model.name}</strong><small>{model.capability === "image" ? "图片生成与编辑" : model.capability === "video" ? "视频生成与动态创作" : "语音与音频生成"}</small></span>
                                                                    <span className={styles.pickerItemAction}>{selected ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}</span>
                                                                </button>
                                                            );
                                                        })}
                                                        {!visibleModels.length ? <div className={styles.pickerEmpty}>当前未配置可用模型</div> : null}
                                                    </div>
                                                </>
                                            ) : null}
                                        </div>
                                    }
                                >
                                    <button type="button" className={`${styles.toolControl} ${modelMenuOpen ? styles.toolControlActive : ""}`} aria-expanded={modelMenuOpen}>
                                        <Box aria-hidden="true" /><span>{selectedModel?.name || "智能模型"}</span><ChevronDown aria-hidden="true" />
                                    </button>
                                </Popover>
                            </div>

                            <div className={styles.rightControls}>
                                <div className={styles.modeGroup} aria-label="创作模式">
                                    {HOME_CREATION_MODES.map((item) => {
                                        const Icon = MODE_ICONS[item.id];
                                        return (
                                            <button key={item.id} type="button" aria-pressed={mode === item.id} aria-label={item.label} className={mode === item.id ? styles.modeActive : undefined} onClick={() => setMode(item.id)}>
                                                <Icon aria-hidden="true" /><span>{item.label}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                <button type="button" className={styles.submitButton} aria-label="开始创作" onClick={submit}>
                                    <Send aria-hidden="true" /><span>生成</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className={styles.shortcutRow} aria-label="快捷创作入口">
                    {shortcuts.map((shortcut) => {
                        const Icon = shortcut.icon;
                        return (
                            <button key={shortcut.label} type="button" onClick={() => activateShortcut(shortcut)}>
                                <span className={styles.shortcutIcon}><Icon aria-hidden="true" /></span>
                                <span><strong>{shortcut.label}</strong><small>{shortcut.detail}</small></span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}

function HomeLoginPrompt({ onLogin }: { onLogin: () => void }) {
    return <div className={styles.loginPrompt}><span>登录后查看当前可用的 Skill 与模型</span><button type="button" onClick={onLogin}>立即登录</button></div>;
}

function HomeModelIcon({ capability }: { capability: ModelCapability }) {
    if (capability === "video") return <Film aria-hidden="true" />;
    if (capability === "audio") return <AudioLines aria-hidden="true" />;
    return <Sparkles aria-hidden="true" />;
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
    return categories
        .map((category) => ({ ...category, count: skills.filter((skill) => homeSkillMatchesCategory(skill, category.id)).length }))
        .filter((category) => category.id === "all" || category.count > 0);
}

function homeSkillMatchesCategory(skill: AgentSkillSummary, category: SkillCategory) {
    if (category === "all") return true;
    if (category === "edit") return skill.action === "edit";
    return skill.workspaces?.includes(category) || false;
}

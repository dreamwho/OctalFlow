"use client";

import { App } from "antd";
import { ArrowUpRight, Boxes, Check, ChevronDown, Clapperboard, CloudUpload, Combine, Film, Layers3, PencilLine, Scissors, Send, ShieldCheck, Sparkles, Split, UsersRound, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { useCreateDraftAttachmentsStore } from "@/app/(user)/create/use-create-draft-attachments-store";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { useHomeActions } from "./home-actions";
import styles from "./home-agent-hero.module.css";

const remakeModes = [
    { id: "video-remake-universal", label: "通用复刻" },
    { id: "video-remake-vlog", label: "VLOG" },
    { id: "video-remake-drama", label: "短剧" },
    { id: "video-remake-talking-head", label: "口播" },
    { id: "video-remake-product", label: "产品种草" },
    { id: "video-remake-tutorial", label: "教程" },
] as const;

const workflow = [
    { icon: Scissors, title: "解析原片", detail: "提取镜头、节奏与转场" },
    { icon: UsersRound, title: "重建资产", detail: "重塑角色与场景资产" },
    { icon: Split, title: "智能分段", detail: "识别语义切点与镜头节奏" },
    { icon: Layers3, title: "批量生成", detail: "并行生成连续视频片段" },
    { icon: Combine, title: "自动合成", detail: "自动拼接为完整视频" },
] as const;

export function HomeAgentHero() {
    const { message } = App.useApp();
    const [tab, setTab] = useState<"remake" | "create">("remake");
    const [prompt, setPrompt] = useState("");
    const [skillId, setSkillId] = useState<(typeof remakeModes)[number]["id"]>("video-remake-universal");
    const [sourceVideo, setSourceVideo] = useState<File>();
    const [sourceVideoUrl, setSourceVideoUrl] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const flowBackgroundRef = useRef<HTMLDivElement>(null);
    const flowPointerRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0 });
    const { startCreating, openProtectedPath } = useHomeActions();

    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        let animationFrame = 0;
        const animate = () => {
            const pointer = flowPointerRef.current;
            pointer.x += (pointer.targetX - pointer.x) * 0.105;
            pointer.y += (pointer.targetY - pointer.y) * 0.105;
            const layer = flowBackgroundRef.current;
            if (layer) {
                layer.style.setProperty("--flow-x", `${pointer.x * 108}px`);
                layer.style.setProperty("--flow-y", `${pointer.y * 78}px`);
                layer.style.setProperty("--flow-rotate", `${pointer.x * 4.5}deg`);
                layer.style.setProperty("--flow-depth-x", `${pointer.x * -54}px`);
                layer.style.setProperty("--flow-depth-y", `${pointer.y * -38}px`);
                layer.style.setProperty("--flow-depth-rotate", `${pointer.x * -2.9}deg`);
            }
            animationFrame = window.requestAnimationFrame(animate);
        };
        animationFrame = window.requestAnimationFrame(animate);
        return () => window.cancelAnimationFrame(animationFrame);
    }, []);

    const trackBackgroundPointer = (event: PointerEvent<HTMLElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        flowPointerRef.current.targetX = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
        flowPointerRef.current.targetY = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
    };

    const releaseBackgroundPointer = () => {
        flowPointerRef.current.targetX = 0;
        flowPointerRef.current.targetY = 0;
    };

    useEffect(() => {
        if (!sourceVideo) {
            setSourceVideoUrl("");
            return;
        }
        const url = URL.createObjectURL(sourceVideo);
        setSourceVideoUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [sourceVideo]);

    const selectVideo = (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("video/")) {
            message.error("请选择 MP4、MOV 或 WEBM 视频文件");
            return;
        }
        if (file.size > CREATIVE_UPLOAD_MAX_BYTES) {
            message.error(`参考视频不能超过 ${Math.round(CREATIVE_UPLOAD_MAX_BYTES / 1024 / 1024)}MB`);
            return;
        }
        setSourceVideo(file);
    };

    const submit = () => {
        if (tab === "remake" && !sourceVideo) {
            message.warning("请先上传需要分析的参考视频");
            fileInputRef.current?.click();
            return;
        }
        if (tab === "create" && !prompt.trim()) {
            message.warning("请先描述你想创作的视频");
            textareaRef.current?.focus();
            return;
        }
        if (sourceVideo) useCreateDraftAttachmentsStore.getState().add([sourceVideo], "");
        const selectedMode = remakeModes.find((item) => item.id === skillId)?.label || "通用复刻";
        const request = prompt.trim() || `使用${selectedMode}复刻这条参考视频：保留可迁移的结构、镜头节奏与转场，创建全新角色、场景、声音与表达。`;
        startCreating(request, "agent", { skillIds: tab === "remake" ? [skillId] : [] });
    };

    return (
        <section className={styles.hero} aria-labelledby="home-hero-title" onPointerMove={trackBackgroundPointer} onPointerLeave={releaseBackgroundPointer}>
            <div ref={flowBackgroundRef} className={styles.flowBackground} aria-hidden="true">
                <span className={styles.flowPrimary} />
                <span className={styles.flowDepth} />
            </div>
            <div className={styles.heroContent}>
                <p className={styles.eyebrow}>AI 原生视频创作工作台</p>
                <h1 id="home-hero-title" className={styles.heroTitle}>复刻爆款结构，创作你的全新视频</h1>
                <p className={styles.heroSubtitle}>上传参考视频，OctalFlow 自动拆解镜头、节奏与转场，重建角色和场景，并批量生成可编辑的新作品。</p>

                <div className={styles.modeSwitch} role="tablist" aria-label="首页创作模式">
                    <button type="button" role="tab" aria-selected={tab === "remake"} className={tab === "remake" ? styles.modeActive : undefined} onClick={() => setTab("remake")}><Sparkles aria-hidden="true" />爆款复刻</button>
                    <button type="button" role="tab" aria-selected={tab === "create"} className={tab === "create" ? styles.modeActive : undefined} onClick={() => setTab("create")}><PencilLine aria-hidden="true" />自由创作</button>
                </div>

                <div className={styles.remakeComposer}>
                    <p className={styles.composerLead}>{tab === "remake" ? "上传参考视频或描述你的改编方向，OctalFlow 将为你智能复刻。" : "描述你的创意，OctalFlow 将自动规划素材、镜头和生成任务。"}</p>
                    <div className={styles.composerMain}>
                        <button type="button" className={styles.uploadCard} onClick={() => fileInputRef.current?.click()} aria-label={sourceVideo ? `更换参考视频 ${sourceVideo.name}` : "上传参考视频"}>
                            {sourceVideoUrl ? <video src={sourceVideoUrl} muted playsInline preload="metadata" /> : <CloudUpload aria-hidden="true" />}
                            <span>{sourceVideo ? sourceVideo.name : "上传参考视频"}</span>
                            <small>{sourceVideo ? `${(sourceVideo.size / 1024 / 1024).toFixed(1)}MB · 点击更换` : `支持 MP4 / MOV / WEBM · ≤ ${Math.round(CREATIVE_UPLOAD_MAX_BYTES / 1024 / 1024)}MB`}</small>
                            {sourceVideo ? <Check className={styles.uploadReady} aria-hidden="true" /> : null}
                        </button>
                        <input ref={fileInputRef} className={styles.hiddenInput} type="file" accept="video/mp4,video/quicktime,video/webm" onChange={(event) => selectVideo(event.target.files?.[0])} />

                        <div className={styles.promptPanel}>
                            <textarea ref={textareaRef} value={prompt} maxLength={1000} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
                            }} placeholder={tab === "remake" ? "描述你的改编方向、目标平台与角色设定…" : "例如：为新锐建筑设计师创作一条 45 秒竖屏 VLOG…"} />
                            <div className={styles.remakeTypes} role="group" aria-label="复刻类型">
                                {remakeModes.map((item) => <button key={item.id} type="button" disabled={tab !== "remake"} aria-pressed={skillId === item.id && tab === "remake"} className={skillId === item.id && tab === "remake" ? styles.typeActive : undefined} onClick={() => setSkillId(item.id)}>{item.label}</button>)}
                            </div>
                            <span className={styles.characterCount}>{prompt.length} / 1000</span>
                        </div>
                    </div>

                    <div className={styles.composerFooter}>
                        <div className={styles.planSummaries}>
                            <span><Film aria-hidden="true" /><b>模型</b> 智能匹配<ChevronDown aria-hidden="true" /></span>
                            <span><WandSparkles aria-hidden="true" /><b>Skill</b> {tab === "remake" ? "结构学习 + 节奏重构" : "智能创作编排"}<ChevronDown aria-hidden="true" /></span>
                            <span><Boxes aria-hidden="true" /><b>资产库</b> 自动创建新资产<ChevronDown aria-hidden="true" /></span>
                            <span><Clapperboard aria-hidden="true" /><b>比例</b> 跟随源视频<ChevronDown aria-hidden="true" /></span>
                        </div>
                        <button type="button" className={styles.submitButton} onClick={submit}><Send aria-hidden="true" />{tab === "remake" ? "开始智能复刻" : "开始自由创作"}</button>
                    </div>
                    <p className={styles.safetyNote}><ShieldCheck aria-hidden="true" />{tab === "remake" ? "仅学习可迁移的结构与节奏，不克隆人脸、声音、品牌、水印、音乐及高度独创表达" : "自动规划镜头、资产与生成任务，所有内容保持可编辑与可追踪"}</p>
                </div>

                <div className={styles.workflowCard}>
                    <div className={styles.workflowHeading}>
                        <div><strong>一键复刻视频</strong><span>工作流程</span></div>
                        <button type="button" onClick={() => openProtectedPath("/canvas")}><ArrowUpRight aria-hidden="true" />从空白画布开始</button>
                    </div>
                    <div className={styles.workflowGrid}>
                        {workflow.map((item, index) => {
                            const Icon = item.icon;
                            return <article key={item.title}>
                                <div className={styles.workflowTitle}><Icon aria-hidden="true" /><b>{item.title}</b></div>
                                <p>{item.detail}</p>
                                <div className={styles.workflowVisual}>
                                    {index === 0 && sourceVideoUrl ? <video src={sourceVideoUrl} muted playsInline preload="metadata" /> : null}
                                    {index === 2 ? ["7s", "8s", "5s", "10s", "9s", "6s"].map((duration) => <span key={duration}>{duration}</span>) : null}
                                    {index !== 0 && index !== 2 ? <Icon aria-hidden="true" /> : null}
                                    {index === 0 && !sourceVideoUrl ? <Film aria-hidden="true" /> : null}
                                </div>
                            </article>;
                        })}
                    </div>
                </div>

                <div className={styles.trustRow} aria-label="安全与原创承诺">
                    <span><ShieldCheck />端到端数据安全保护</span><span><ShieldCheck />不储存原片与隐私内容</span><span><ShieldCheck />不克隆人脸与声音特征</span><span><Film />不生成原品牌、水印与音乐</span>
                </div>
            </div>
        </section>
    );
}

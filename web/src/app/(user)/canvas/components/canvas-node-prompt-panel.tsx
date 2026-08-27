"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { ChevronDown, CircleCheck, FileText, Link2, LoaderCircle, Maximize2, Minimize2, Music2, Sparkles, Square, X } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { CreditSymbol, formatCreditAmount, requestCreditCost } from "@/constant/credits";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { defaultConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasSkillSelector } from "./canvas-skill-selector";
import { CanvasAudioSettingsPopover } from "./canvas-audio-settings-popover";
import { CanvasResourceMentionTextarea, insertTextAtSelection } from "./canvas-resource-mention-textarea";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasCameraControl } from "./canvas-camera-control";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { buildCanvasNodeConfig, canvasAudioConfigPatch, canvasVideoConfigPatch } from "../utils/canvas-node-config";
import { PANORAMA_IMAGE_SIZE } from "../utils/canvas-panorama";
import { cameraControlLabel } from "../utils/canvas-camera";
import { PROMPT_COMPOSER_BOTTOM_INSET, PROMPT_COMPOSER_MIN_HEIGHT, PROMPT_COMPOSER_SAFE_TOP, resolvePromptComposerHeight } from "../utils/canvas-surface-geometry";
import { listAgentSkills, type AgentSkillSummary } from "@/services/api/agent-skills";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

const stopCanvasInteraction = (event: SyntheticEvent) => event.stopPropagation();

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, skillIds?: string[]) => void | Promise<void>;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
    onClose?: () => void;
    height?: number | null;
    onHeightChange?: (height: number | null) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], onImageSettingsOpenChange, onClose, height, onHeightChange }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = isCanvasImageNodeType(node.type) && Boolean(node.metadata?.content);
    const isPanorama = node.type === CanvasNodeType.Panorama;
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const activeMentionReferences = mentionReferences.filter((reference) => reference.active);
    const [prompt, setPrompt] = useState(publicNodePrompt(node));
    const [expanded, setExpanded] = useState(false);
    const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(false);
    const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
    const promptEditorRef = useRef<HTMLTextAreaElement | null>(null);
    const expandedEditorRef = useRef<HTMLTextAreaElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const resizeStartRef = useRef<{ pointerId: number; y: number; height: number } | null>(null);
    const mouseResizeCleanupRef = useRef<(() => void) | null>(null);
    const credits = requestCreditCost({
        apiSource: config.apiSource,
        modelPointCosts: config.modelPointCosts,
        generationPointMultipliers: config.generationPointMultipliers,
        kind: mode,
        model: config.model,
        count: mode === "image" ? config.count : 1,
        quality: config.quality,
        videoQuality: config.vquality,
        videoSeconds: config.videoSeconds,
    });

    useEffect(() => {
        setPrompt(publicNodePrompt(node));
        setSelectedSkillIds(node.metadata?.selectedSkillIds || []);
    }, [node.id, node.metadata?.status]);

    useEffect(() => {
        if (mode !== "image" && mode !== "video") {
            setSkills([]);
            return;
        }
        let active = true;
        setSkillsLoading(true);
        listAgentSkills(mode)
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
    }, [mode]);

    useEffect(() => () => mouseResizeCleanupRef.current?.(), []);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (!isEditingExistingContent) onPromptChange(node.id, value);
    };

    const insertReferenceAtCursor = (reference: CanvasResourceReference) => {
        const textarea = promptEditorRef.current;
        if (!textarea) return;
        const focused = document.activeElement === textarea;
        const start = focused ? textarea.selectionStart : prompt.length;
        const end = focused ? textarea.selectionEnd : prompt.length;
        const next = insertTextAtSelection(prompt, start, end, `${reference.label} `);
        updatePrompt(next.value);
        requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(next.caret, next.caret);
        });
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return false;
        void onGenerate(node.id, mode, text, selectedSkillIds);
        setPrompt("");
        setSelectedSkillIds([]);
        return true;
    };

    const selectSkill = (skill: AgentSkillSummary) => {
        setSelectedSkillIds((current) => (current.includes(skill.id) ? current : [...current, skill.id]));
    };

    const selectedSkills = skills.filter((skill) => selectedSkillIds.includes(skill.id));
    const visibleReferences = activeMentionReferences.length
        ? activeMentionReferences
        : node.metadata?.content
          ? [
                {
                    id: `${node.id}-current`,
                    nodeId: node.id,
                    kind: mode === "video" ? "video" : mode === "audio" ? "audio" : mode === "text" ? "text" : "image",
                    label: `当前${modeLabel(mode)}`,
                    title: node.title,
                    previewUrl: node.metadata.content,
                    text: mode === "text" ? node.metadata.content : undefined,
                    active: true,
                } satisfies CanvasResourceReference,
            ]
          : [];
    const selectedSkillSummary = selectedSkills.length ? selectedSkills.map((skill) => skill.name).join("、") : "未选择";
    const qualitySummary = mode === "video" ? `${config.vquality || "720"}P` : mode === "image" ? imageQualityLabel(config.quality) : "—";

    const submitExpanded = () => {
        if (submit()) setExpanded(false);
    };

    const renderModelAndSettings = () => (
        <>
            {mode === "image" || mode === "video" ? <CanvasSkillSelector skills={skills} loading={skillsLoading} selectedSkillIds={selectedSkillIds} onSelect={selectSkill} /> : null}
            <ModelPicker className="min-w-[8.5rem]" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability={mode} onMissingConfig={() => openConfigDialog(true)} />
            {mode === "image" ? (
                <>
                    <CanvasImageSettingsPopover
                        config={config}
                        placement="topLeft"
                        buttonClassName="canvas-composer-settings !h-8 !max-w-[13rem] !justify-start !rounded-lg !px-2.5"
                        onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                        onOpenChange={onImageSettingsOpenChange}
                        fixedSizeLabel={isPanorama ? "全景 2:1" : undefined}
                    />
                    {!isPanorama ? <CanvasCameraControl value={node.metadata?.cameraControl} onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })} buttonClassName="canvas-composer-settings !h-8 !max-w-[11rem] !justify-start !rounded-lg !px-2.5" /> : null}
                </>
            ) : mode === "video" ? (
                <>
                    <CanvasVideoSettingsPopover
                        config={config}
                        metadata={node.metadata}
                        references={mentionReferences}
                        buttonClassName="canvas-composer-settings !h-8 !max-w-[13rem] !justify-start !rounded-lg !px-2.5"
                        onConfigChange={(key, value) => onConfigChange(node.id, canvasVideoConfigPatch(key, value))}
                        onMetadataChange={(patch) => onConfigChange(node.id, patch)}
                    />
                    <CanvasCameraControl value={node.metadata?.cameraControl} onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })} buttonClassName="canvas-composer-settings !h-8 !max-w-[11rem] !justify-start !rounded-lg !px-2.5" />
                </>
            ) : mode === "audio" ? (
                <CanvasAudioSettingsPopover config={config} buttonClassName="canvas-composer-settings !h-8 !max-w-[13rem] !justify-start !rounded-lg !px-2.5" onConfigChange={(key, value) => onConfigChange(node.id, canvasAudioConfigPatch(key, value))} />
            ) : null}
        </>
    );

    const generateButton = (compact = false) => (
        <Button
            type="primary"
            className={`canvas-generate-button shrink-0 !rounded-[12px] ${compact ? "!h-10 !min-w-28 !px-4" : "!h-12 !w-full !px-5"}`}
            danger={isRunning}
            disabled={!isRunning && !prompt.trim()}
            onClick={() => (isRunning ? onStop(node.id) : submit())}
            aria-label={isRunning ? "停止生成" : "生成"}
        >
            <span className="flex items-center justify-center gap-2">
                {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                <span className="text-sm font-semibold">{isRunning ? "停止生成" : "生成"}</span>
                {!isRunning ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums opacity-85">
                        <CreditSymbol />
                        {formatCreditAmount(credits)}
                    </span>
                ) : (
                    <Square className="size-3 fill-current" />
                )}
            </span>
        </Button>
    );

    const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.pointerType === "mouse") return;
        if (!onHeightChange || !panelRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeStartRef.current = { pointerId: event.pointerId, y: event.clientY, height: panelRef.current.getBoundingClientRect().height };
    };

    const startMousePanelResize = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!onHeightChange || !panelRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        mouseResizeCleanupRef.current?.();
        const startY = event.clientY;
        const startHeight = panelRef.current.getBoundingClientRect().height;
        const handleMove = (moveEvent: MouseEvent) => onHeightChange(resolvePromptComposerHeight(window.innerHeight, startHeight + startY - moveEvent.clientY));
        const cleanup = () => {
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", cleanup);
            mouseResizeCleanupRef.current = null;
        };
        mouseResizeCleanupRef.current = cleanup;
        window.addEventListener("mousemove", handleMove);
        window.addEventListener("mouseup", cleanup);
    };

    const resizePanel = (event: ReactPointerEvent<HTMLDivElement>) => {
        const start = resizeStartRef.current;
        if (!start || start.pointerId !== event.pointerId || !onHeightChange) return;
        event.preventDefault();
        onHeightChange(resolvePromptComposerHeight(window.innerHeight, start.height + start.y - event.clientY));
    };

    const finishPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (resizeStartRef.current?.pointerId !== event.pointerId) return;
        resizeStartRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!onHeightChange) return;
        if (event.key === "Home") {
            event.preventDefault();
            onHeightChange(null);
            return;
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const currentHeight = panelRef.current?.getBoundingClientRect().height || resolvePromptComposerHeight(window.innerHeight, height);
        onHeightChange(resolvePromptComposerHeight(window.innerHeight, currentHeight + (event.key === "ArrowUp" ? 24 : -24)));
    };

    return (
        <div
            ref={panelRef}
            data-canvas-node-prompt-panel
            data-canvas-composer-height={height ?? "default"}
            className="canvas-scene-composer relative flex h-[min(58vh,410px)] min-h-[330px] flex-col overflow-hidden rounded-[18px] border shadow-[0_22px_70px_rgba(37,43,74,.16)] backdrop-blur-2xl"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, height: height ? `${height}px` : undefined, maxHeight: `calc(100dvh - ${PROMPT_COMPOSER_SAFE_TOP + PROMPT_COMPOSER_BOTTOM_INSET}px)` }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
        >
            {onHeightChange ? (
                <div
                    data-canvas-composer-resize-handle
                    role="separator"
                    aria-label="调整提示词面板高度"
                    aria-orientation="horizontal"
                    aria-valuemin={PROMPT_COMPOSER_MIN_HEIGHT}
                    aria-valuenow={height ? Math.round(height) : undefined}
                    aria-valuetext={height ? `${Math.round(height)} 像素` : "默认高度"}
                    tabIndex={0}
                    title="上下拖动调整高度，双击恢复默认"
                    className="group absolute inset-x-0 top-0 z-30 flex h-4 cursor-row-resize touch-none items-start justify-center outline-none"
                    onPointerDown={startPanelResize}
                    onMouseDown={startMousePanelResize}
                    onPointerMove={resizePanel}
                    onPointerUp={finishPanelResize}
                    onPointerCancel={finishPanelResize}
                    onLostPointerCapture={() => {
                        resizeStartRef.current = null;
                    }}
                    onKeyDown={handleResizeKeyDown}
                    onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onHeightChange(null);
                    }}
                >
                    <span className="mt-1 h-1 w-12 rounded-full opacity-30 transition group-hover:opacity-70 group-focus-visible:opacity-80" style={{ background: theme.node.muted }} aria-hidden />
                </div>
            ) : null}
            <header className="relative flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3" style={{ borderColor: theme.toolbar.border }}>
                <div className="flex min-w-0 items-center gap-2">
                    <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium transition hover:opacity-70" style={{ color: theme.node.muted }} onClick={onClose} aria-label="收起提示词面板">
                        <ChevronDown className="size-3.5" />
                        <span className="hidden sm:inline">收起</span>
                    </button>
                    <span className="h-4 w-px" style={{ background: theme.toolbar.border }} aria-hidden />
                    <div className="min-w-0 truncate text-xs font-semibold sm:text-sm">场记编排台 · Composer</div>
                    <kbd className="hidden rounded-md px-1.5 py-0.5 text-[10px] font-medium opacity-45 sm:inline" style={{ background: theme.toolbar.itemHover }}>⌘K</kbd>
                </div>
                <div className="absolute left-1/2 hidden max-w-[45%] -translate-x-1/2 items-center gap-1.5 truncate text-xs font-semibold md:flex" style={{ color: theme.toolbar.activeText }}>
                    <Link2 className="size-3.5 shrink-0" />
                    <span className="truncate">已连接到 {node.title}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <span className="hidden text-[11px] opacity-45 md:inline">⌘ / 快捷键</span>
                    <button type="button" className="grid size-8 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" onClick={onClose} aria-label="关闭提示词面板">
                        <X className="size-4" />
                    </button>
                </div>
            </header>

            <div className="thin-scrollbar grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[190px_minmax(0,1fr)] md:overflow-hidden xl:grid-cols-[220px_minmax(0,1fr)_250px]">
                <aside className="min-h-0 border-b p-3 md:border-b-0 md:border-r" style={{ borderColor: theme.toolbar.border }}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold">引用素材</div>
                        <span className="text-[11px] tabular-nums opacity-45">{visibleReferences.length}</span>
                    </div>
                    {visibleReferences.length ? (
                        <div className="thin-scrollbar flex gap-2 overflow-x-auto md:grid md:max-h-[calc(100%-28px)] md:grid-cols-1 md:overflow-y-auto md:overflow-x-hidden" aria-label="当前参考素材">
                            {visibleReferences.map((reference) => (
                                <button
                                    key={reference.id}
                                    type="button"
                                    data-canvas-no-drag
                                    title={`插入 ${reference.label}`}
                                    className="group relative h-20 w-32 shrink-0 overflow-hidden rounded-[10px] border text-left transition hover:-translate-y-0.5 md:h-24 md:w-full"
                                    style={{ borderColor: theme.node.activeStroke, background: theme.node.fill }}
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                    }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (!reference.id.endsWith("-current")) insertReferenceAtCursor(reference);
                                    }}
                                >
                                    <ReferencePreview reference={reference} />
                                    <span className="absolute left-1.5 top-1.5 rounded-md bg-[#5b5ce2] px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm">{reference.label}</span>
                                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-[10px] font-medium text-white">{reference.title}</span>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="grid min-h-28 place-items-center rounded-xl border border-dashed px-3 text-center text-xs leading-5" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>
                            连接图片、视频或文本节点后，素材会显示在这里
                        </div>
                    )}
                </aside>

                <section className="flex min-h-0 min-w-0 flex-col p-3">
                    <div className="canvas-composer-tools thin-scrollbar flex min-h-8 shrink-0 items-center gap-1.5 overflow-x-auto pb-2">{renderModelAndSettings()}</div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1.5 text-sm font-semibold">
                            <Sparkles className="size-4" style={{ color: theme.toolbar.activeText }} />
                            生成提示词
                        </div>
                        <Tooltip title="放大编辑" placement="top">
                            <button type="button" className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setExpanded(true)} aria-label="放大提示词输入">
                                <Maximize2 className="size-3.5" />
                            </button>
                        </Tooltip>
                    </div>
                    <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-[12px] border" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                        <CanvasResourceMentionTextarea
                            ref={promptEditorRef}
                            value={prompt}
                            references={mentionReferences}
                            skills={skills}
                            onSelectSkill={selectSkill}
                            onChange={updatePrompt}
                            onSubmit={submit}
                            aria-label="节点提示词"
                            data-testid="canvas-node-prompt-editor"
                            containerClassName="min-h-0 flex-1"
                            className="thin-scrollbar h-full min-h-[128px] w-full resize-none overflow-y-auto rounded-none !border-0 px-4 py-3 pb-8 text-sm leading-6 outline-none"
                            style={{ background: "transparent", color: theme.node.text }}
                            placeholder={`${promptPlaceholder(mode, hasImageContent, hasTextContent, isPanorama)}${mode === "image" || mode === "video" ? "，输入 / 选择 Skill" : ""}`}
                        />
                        <div className="pointer-events-none absolute bottom-2.5 right-3 text-[10px] tabular-nums opacity-35">{prompt.length}/1000</div>
                    </div>
                    <div className="mt-2 flex min-w-0 items-center gap-2">
                        <CanvasPromptLibrary onSelect={updatePrompt} />
                        {selectedSkills.length ? (
                            <div className="thin-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto" aria-label="已选择的 Skill">
                                {selectedSkills.map((skill) => (
                                    <span key={skill.id} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}>
                                        <span className="max-w-36 truncate">{skill.name}</span>
                                        <button type="button" className="grid size-4 place-items-center rounded hover:bg-black/10 dark:hover:bg-white/10" onClick={() => setSelectedSkillIds((current) => current.filter((id) => id !== skill.id))} aria-label={`移除 Skill ${skill.name}`}>
                                            <X className="size-2.5" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <span className="min-w-0 flex-1 truncate text-[11px] opacity-45">使用 / 插入引用，使用 Skill 选择创作能力</span>
                        )}
                        <div className="xl:hidden">{generateButton(true)}</div>
                    </div>
                </section>

                <aside className="hidden min-h-0 flex-col overflow-hidden border-l p-3 xl:flex" style={{ borderColor: theme.toolbar.border }}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">生成设置</span>
                        {node.metadata?.status === "success" ? <CircleCheck className="size-4 text-emerald-500" aria-hidden /> : null}
                    </div>
                    <dl className="grid min-h-0 grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-4">
                        <SummaryRow label="Skill" value={selectedSkillSummary} />
                        <SummaryRow label="模型" value={config.model || modeLabel(mode)} />
                        <SummaryRow label="比例" value={config.size || "默认"} />
                        <SummaryRow label="画质" value={qualitySummary} />
                        <SummaryRow label="时长" value={mode === "video" ? `${config.videoSeconds || 5}s` : "—"} />
                        <SummaryRow label="参考素材" value={`${visibleReferences.length} 个`} />
                        <SummaryRow label="镜头" value={mode === "image" || mode === "video" ? cameraControlLabel(node.metadata?.cameraControl) : "—"} />
                    </dl>
                    <div className="mt-auto shrink-0 border-t pt-3" style={{ borderColor: theme.toolbar.border }}>
                        <div className="mb-2 flex items-center justify-between text-[11px]">
                            <span style={{ color: theme.node.muted }}>预计消耗</span>
                            <span className="inline-flex items-center gap-1 font-semibold tabular-nums"><CreditSymbol />{formatCreditAmount(credits)}</span>
                        </div>
                        {generateButton()}
                    </div>
                </aside>
            </div>

            <div className="contents" onClick={stopCanvasInteraction} onDoubleClick={stopCanvasInteraction} onMouseDown={stopCanvasInteraction} onPointerDown={stopCanvasInteraction} onWheel={stopCanvasInteraction} onContextMenu={stopCanvasInteraction}>
                <Modal
                    className="canvas-prompt-editor-modal"
                    open={expanded}
                    title="编辑提示词"
                    centered
                    destroyOnHidden
                    mask={{ closable: false }}
                    width="min(760px, calc(100vw - 24px))"
                    onCancel={() => setExpanded(false)}
                    afterOpenChange={(open) => {
                        if (!open) return;
                        requestAnimationFrame(() => {
                            const textarea = expandedEditorRef.current;
                            textarea?.focus();
                            textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
                        });
                    }}
                    styles={{
                        container: { background: theme.node.panel, border: `1px solid ${theme.toolbar.border}`, color: theme.node.text },
                        header: { background: theme.node.panel, marginBottom: 0, paddingBottom: 8 },
                        title: { color: theme.node.text },
                        body: { background: theme.node.panel, padding: "4px 12px 12px" },
                    }}
                    footer={null}
                >
                    <div data-canvas-prompt-editor="expanded" className="min-w-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }}>
                        <CanvasResourceMentionTextarea
                            ref={expandedEditorRef}
                            autoFocus={expanded}
                            value={prompt}
                            references={mentionReferences}
                            skills={skills}
                            onSelectSkill={selectSkill}
                            onChange={updatePrompt}
                            onSubmit={submitExpanded}
                            aria-label="提示词编辑器"
                            className="thin-scrollbar h-[min(52vh,26rem)] min-h-64 w-full resize-none border-0 px-4 py-3 text-sm leading-6 outline-none"
                            style={{ background: theme.node.fill, color: theme.node.text }}
                            placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent, isPanorama)}
                        />
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                        <Button icon={<Minimize2 className="size-4" />} onClick={() => setExpanded(false)} aria-label="收起提示词输入">
                            收起
                        </Button>
                        <Button type="primary" danger={isRunning} disabled={!isRunning && !prompt.trim()} onClick={() => (isRunning ? onStop(node.id) : submitExpanded())} aria-label={isRunning ? "停止生成" : "生成"}>
                            {isRunning ? "停止生成" : "生成"}
                        </Button>
                    </div>
                </Modal>
            </div>
        </div>
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={imagePreviewUrl(reference.previewUrl, 360)} alt={reference.title} className="size-full object-cover" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="size-full object-cover" muted preload="metadata" playsInline />;
    if (reference.kind === "audio")
        return (
            <span className="grid size-full place-items-center">
                <Music2 className="size-7 opacity-45" />
            </span>
        );
    return (
        <span className="flex size-full items-center gap-2 px-3 text-xs leading-5">
            <FileText className="size-5 shrink-0 opacity-45" />
            <span className="line-clamp-3">{reference.text || reference.title}</span>
        </span>
    );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
    return (
        <>
            <dt className="opacity-45">{label}</dt>
            <dd className="min-w-0 truncate font-medium" title={value}>
                {value}
            </dd>
        </>
    );
}

function imageQualityLabel(value: string) {
    return value === "high" ? "高画质" : value === "medium" ? "标准" : value === "low" ? "快速" : "自动";
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : mode === "video" ? globalConfig.videoModel : mode === "audio" ? globalConfig.audioModel : globalConfig.textModel;
    const model = node.metadata?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : globalConfig.model || defaultConfig.model);
    const config = buildCanvasNodeConfig(globalConfig, node, mode, model);
    return node.type === CanvasNodeType.Panorama ? { ...config, size: PANORAMA_IMAGE_SIZE } : config;
}

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean, isPanorama: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (isPanorama) return hasImageContent ? "描述要如何调整这个全景环境" : "描述要生成的 360° 全景环境";
    if (mode === "image") return hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

export function publicNodePrompt(node: CanvasNodeData) {
    return node.metadata?.sourcePrompt?.trim() || node.metadata?.prompt?.trim() || node.metadata?.composerContent?.trim() || "";
}

function modeLabel(mode: CanvasNodeGenerationMode) {
    return mode === "image" ? "图片" : mode === "video" ? "视频" : mode === "audio" ? "音频" : "文本";
}

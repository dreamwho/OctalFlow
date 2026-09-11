"use client";

import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { FileText, Link2, LoaderCircle, Maximize2, Minimize2, MoreHorizontal, Music2, Sparkles, X } from "lucide-react";
import { Button, Modal, Popover, Tooltip } from "antd";

import { GenerationActionButton } from "@/components/generation-action-button";
import { ModelPicker } from "@/components/model-picker";
import { CreditSymbol, formatCreditAmount, requestCreditCost } from "@/constant/credits";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { defaultConfig, modelOptionLabel, modelOptionName, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { MINIMAX_SPEECH_MODELS } from "@/lib/minimax-audio";
import { isQwenAudioModel, qwenDefaultAudioVoice } from "@/lib/qwen-audio";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasSkillSelector } from "./canvas-skill-selector";
import { CanvasAudioModePicker, CanvasAudioSettingsPopover } from "./canvas-audio-settings-popover";
import { CanvasResourceMentionTextarea, insertTextAtSelection, referenceMentionLabel } from "./canvas-resource-mention-textarea";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasCameraControl } from "./canvas-camera-control";
import { CanvasCameraMotionPicker } from "./canvas-camera-motion-picker";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { buildCanvasNodeConfig, canvasAudioConfigPatch, canvasVideoConfigPatch, selectableCanvasAudioModels } from "../utils/canvas-node-config";
import { PANORAMA_IMAGE_SIZE } from "../utils/canvas-panorama";
import { cameraMotionPromptToken, type CanvasCameraMotionDefinitions, type CanvasCameraMotionSelection } from "../utils/canvas-camera-motion";
import { agentSkillSupportsMode, listNodeAgentSkills, type AgentSkillSummary } from "@/services/api/agent-skills";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

const stopCanvasInteraction = (event: SyntheticEvent) => event.stopPropagation();

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, skillIds?: string[], metadataOverrides?: Partial<CanvasNodeData["metadata"]>) => void | Promise<void>;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], onImageSettingsOpenChange }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const audioModelOptions = useMemo(() => (mode === "audio" ? selectableCanvasAudioModels(config, config.audioMode) : []), [config, mode]);
    const unavailableAudioModes = useMemo(() => (mode === "audio" ? (["tts", "voice-clone", "voice-design", "music"] as const).filter((audioMode) => selectableCanvasAudioModels(config, audioMode).length === 0) : []), [config, mode]);

    useEffect(() => {
        if (mode !== "audio" || !audioModelOptions.length || audioModelOptions.some((model) => modelOptionName(model).toLowerCase() === modelOptionName(config.model).toLowerCase())) return;
        const nextModel = audioModelOptions[0];
        const nextUpstreamModel = modelOptionName(resolveModelRequestConfig(config, nextModel).model).trim();
        onConfigChange(node.id, { model: nextModel, ...(isQwenAudioModel(nextUpstreamModel) ? { audioVoice: qwenDefaultAudioVoice(nextUpstreamModel) } : {}) });
    }, [audioModelOptions, config, mode, node.id, onConfigChange]);

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
    const [cameraMotions, setCameraMotions] = useState<CanvasCameraMotionDefinitions>(node.metadata?.cameraMotions || {});
    const promptEditorRef = useRef<HTMLTextAreaElement | null>(null);
    const expandedEditorRef = useRef<HTMLTextAreaElement | null>(null);
    const promptSelectionRef = useRef({ start: 0, end: 0 });
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
        const nextPrompt = publicNodePrompt(node);
        setPrompt(nextPrompt);
        promptSelectionRef.current = { start: nextPrompt.length, end: nextPrompt.length };
        setSelectedSkillIds(node.metadata?.selectedSkillIds || []);
    }, [node.id, node.metadata?.status]);

    useEffect(() => {
        setCameraMotions(node.metadata?.cameraMotions || {});
    }, [node.id, node.metadata?.cameraMotions]);

    useEffect(() => {
        if (mode !== "image" && mode !== "video") {
            setSkills([]);
            return;
        }
        let active = true;
        setSkillsLoading(true);
        listNodeAgentSkills(mode)
            .then((items) => {
                if (active) setSkills(items.filter((skill) => agentSkillSupportsMode(skill, mode)));
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

    const updatePrompt = (value: string) => {
        setPrompt(value);
        const nextCameraMotions = Object.fromEntries(Object.entries(cameraMotions).filter(([, motion]) => value.includes(cameraMotionPromptToken(motion))));
        if (Object.keys(nextCameraMotions).length !== Object.keys(cameraMotions).length) {
            setCameraMotions(nextCameraMotions);
            onConfigChange(node.id, { cameraMotions: nextCameraMotions });
        }
        if (!isEditingExistingContent) onPromptChange(node.id, value);
    };

    const rememberPromptSelection = (start: number, end: number) => {
        const nextStart = Math.max(0, Math.min(start, prompt.length));
        promptSelectionRef.current = { start: nextStart, end: Math.max(nextStart, Math.min(end, prompt.length)) };
    };

    const capturePromptSelection = () => {
        const textarea = promptEditorRef.current;
        if (textarea) rememberPromptSelection(textarea.selectionStart, textarea.selectionEnd);
    };

    const insertReferenceAtCursor = (reference: CanvasResourceReference) => {
        capturePromptSelection();
        const next = insertTextAtSelection(prompt, promptSelectionRef.current.start, promptSelectionRef.current.end, `${referenceMentionLabel(reference.label)} `);
        updatePrompt(next.value);
        promptSelectionRef.current = { start: next.caret, end: next.caret };
        requestAnimationFrame(() => {
            promptEditorRef.current?.focus();
            promptEditorRef.current?.setSelectionRange(next.caret, next.caret);
        });
    };

    const insertCameraMotionAtCursor = (motion?: CanvasCameraMotionSelection) => {
        if (!motion) return;
        const nextMotions = { ...cameraMotions, [motion.label]: { label: motion.label, prompt: motion.prompt, previewClass: motion.previewClass } };
        setCameraMotions(nextMotions);
        onConfigChange(node.id, { cameraMotions: nextMotions });
        const next = insertTextAtSelection(prompt, promptSelectionRef.current.start, promptSelectionRef.current.end, cameraMotionPromptToken(motion));
        updatePrompt(next.value);
        promptSelectionRef.current = { start: next.caret, end: next.caret };
        requestAnimationFrame(() => {
            promptEditorRef.current?.focus();
            promptEditorRef.current?.setSelectionRange(next.caret, next.caret);
        });
    };

    const selectSkill = (skill: AgentSkillSummary) => {
        setSelectedSkillIds((current) => (current.includes(skill.id) ? current : [...current, skill.id]));
    };

    const selectedSkills = skills.filter((skill) => selectedSkillIds.includes(skill.id));
    const eligibleSelectedSkillIds = selectedSkills.map((skill) => skill.id);
    const cameraMotionTokens = Object.values(cameraMotions).map((motion) => ({ token: cameraMotionPromptToken(motion), label: motion.label, kind: "camera-motion" as const }));
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
    const optionalSkill = selectedSkills.length && selectedSkills.every((skill) => skill.promptMode === "optional") ? selectedSkills[0] : undefined;
    const missingRequiredReference = selectedSkills.some((skill) => skill.requiresReference) && visibleReferences.length === 0;
    const isAudioCreationMode = mode === "audio" && (config.audioMode === "voice-clone" || config.audioMode === "voice-design");
    const canGenerate = Boolean(prompt.trim() || optionalSkill) && !missingRequiredReference && !isAudioCreationMode;
    const submit = () => {
        const text = prompt.trim();
        if ((!text && !optionalSkill) || missingRequiredReference || isAudioCreationMode || isRunning) return false;
        const executionSeed = text || optionalSkill?.promptHint || `按「${optionalSkill?.name || "所选 Skill"}」默认流程生成`;
        void onGenerate(node.id, mode, executionSeed, eligibleSelectedSkillIds);
        setPrompt("");
        setSelectedSkillIds([]);
        return true;
    };
    const submitExpanded = () => {
        if (submit()) setExpanded(false);
    };

    const changeAudioMode = (audioMode: AiConfig["audioMode"]) => {
        const availableModels = selectableCanvasAudioModels(config, audioMode);
        const currentModelIsAvailable = availableModels.some((model) => modelOptionName(model).toLowerCase() === modelOptionName(config.model).toLowerCase());
        const nextModel = currentModelIsAvailable ? config.model : availableModels[0];
        const nextUpstreamModel = nextModel ? modelOptionName(resolveModelRequestConfig(config, nextModel).model).trim() : "";
        onConfigChange(node.id, { audioMode, ...(nextModel && !currentModelIsAvailable ? { model: nextModel } : {}), ...(isQwenAudioModel(nextUpstreamModel) ? { audioVoice: qwenDefaultAudioVoice(nextUpstreamModel) } : {}) });
    };

    const changeAudioModel = (model: string) => {
        const upstreamModel = modelOptionName(resolveModelRequestConfig(config, model).model).trim();
        onConfigChange(node.id, { model, ...(isQwenAudioModel(upstreamModel) ? { audioVoice: qwenDefaultAudioVoice(upstreamModel) } : {}) });
    };

    const audioModelLabel = (model: string) => {
        const upstreamModel = modelOptionName(resolveModelRequestConfig(config, model).model).trim();
        if ((config.audioMode === "voice-clone" || config.audioMode === "voice-design") && MINIMAX_SPEECH_MODELS.includes(upstreamModel as (typeof MINIMAX_SPEECH_MODELS)[number])) return "MiniMax";
        return modelOptionLabel(config, model);
    };

    const renderModelAndSettings = () => (
        <>
            {mode === "audio" ? <CanvasAudioModePicker value={config.audioMode} disabledModes={unavailableAudioModes} onChange={changeAudioMode} /> : null}
            <ModelPicker className="min-w-[8.5rem]" config={config} value={config.model} onChange={changeAudioModel} capability={mode} options={mode === "audio" ? audioModelOptions : undefined} getModelLabel={mode === "audio" ? audioModelLabel : undefined} onMissingConfig={() => openConfigDialog(true)} />
            {mode === "image" ? (
                <>
                    <CanvasImageSettingsPopover
                        config={config}
                        placement="topLeft"
                        buttonClassName="canvas-composer-settings !inline-flex !h-7 !w-auto !shrink-0 !flex-nowrap !items-center !justify-start !overflow-hidden !rounded-lg !px-2.5 [&>span:last-child]:!inline-flex [&>span:last-child]:!min-w-0 [&>span:last-child]:!items-center [&>span:last-child]:!gap-1 [&>span:last-child]:!whitespace-nowrap [&>span:last-child>svg]:!shrink-0"
                        onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : key === "size" ? { size: value, sizeUserSelected: true } : { [key]: value })}
                        onOpenChange={onImageSettingsOpenChange}
                        fixedSizeLabel={isPanorama ? "全景 2:1" : undefined}
                    />
                </>
            ) : mode === "video" ? (
                <>
                    <CanvasVideoSettingsPopover
                        config={config}
                        metadata={node.metadata}
                        references={mentionReferences}
                        buttonClassName="canvas-composer-settings !inline-flex !h-7 !w-auto !shrink-0 !flex-nowrap !items-center !justify-start !overflow-hidden !rounded-lg !px-2.5 [&>span:last-child]:!inline-flex [&>span:last-child]:!min-w-0 [&>span:last-child]:!items-center [&>span:last-child]:!gap-1 [&>span:last-child]:!whitespace-nowrap [&>span:last-child>svg]:!shrink-0"
                        onConfigChange={(key, value) => onConfigChange(node.id, canvasVideoConfigPatch(key, value))}
                        onMetadataChange={(patch) => onConfigChange(node.id, patch)}
                    />
                </>
            ) : mode === "audio" ? (
                <CanvasAudioSettingsPopover
                    config={config}
                    buttonClassName="canvas-composer-settings !h-7 !max-w-[13rem] !justify-start !rounded-lg !px-2.5"
                    onConfigChange={(key, value) => onConfigChange(node.id, canvasAudioConfigPatch(key, value))}
                    sourceAudioUrl={node.type === CanvasNodeType.Audio ? node.metadata?.content : undefined}
                    clonePromptText={prompt}
                    onVoiceCloneComplete={(voiceId, promptText) => {
                        onConfigChange(node.id, { audioVoice: voiceId, audioMode: "tts" });
                        return onGenerate(node.id, "audio", promptText, [], { audioVoice: voiceId, audioMode: "tts" });
                    }}
                />
            ) : null}
        </>
    );

    const generateButton = () => (
        <GenerationActionButton appearance="icon" running={isRunning} cancellable className="shrink-0" disabled={!isRunning && !canGenerate} onClick={() => (isRunning ? onStop(node.id) : submit())} aria-label={isRunning ? "停止生成" : "生成"} />
    );

    return (
        <div
            data-canvas-node-prompt-panel
            className="canvas-scene-composer relative flex size-full min-h-0 flex-col overflow-hidden rounded-2xl border shadow-[0_18px_54px_rgba(15,23,42,.18)]"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={stopCanvasInteraction}
            onWheel={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
        >
            <div className="flex h-11 shrink-0 items-center gap-1 px-3 pt-1.5" data-canvas-composer-quick-tools>
                <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.node.muted }}
                    onClick={() => visibleReferences[0] && !visibleReferences[0].id.endsWith("-current") && insertReferenceAtCursor(visibleReferences[0])}
                    aria-label="插入参考素材"
                >
                    <Link2 className="size-3.5" />
                    参考{visibleReferences.length ? ` ${visibleReferences.length}` : ""}
                </button>
                <CanvasPromptLibrary onSelect={updatePrompt} />
                {mode === "image" || mode === "video" ? <CanvasSkillSelector skills={skills} loading={skillsLoading} selectedSkillIds={eligibleSelectedSkillIds} onSelect={selectSkill} /> : null}
                {mode === "image" && !isPanorama ? <CanvasCameraControl value={node.metadata?.cameraControl} onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })} /> : null}
                {mode === "video" ? (
                    <>
                        <CanvasCameraControl value={node.metadata?.cameraControl} onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })} />
                        <CanvasCameraMotionPicker onOpen={capturePromptSelection} onChange={insertCameraMotionAtCursor} />
                    </>
                ) : null}
                <span className="min-w-0 flex-1" />
                <Tooltip title="放大编辑" placement="top">
                    <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setExpanded(true)} aria-label="放大提示词输入">
                        <Maximize2 className="size-4" />
                    </button>
                </Tooltip>
            </div>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pb-2">
                {visibleReferences.length || selectedSkills.length ? (
                    <div className="thin-scrollbar flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto" data-canvas-prompt-context>
                        {visibleReferences.map((reference) => (
                            <Popover key={reference.id} trigger="hover" placement="topLeft" mouseEnterDelay={0.15} content={<ReferenceHoverPreview reference={reference} />} overlayInnerStyle={{ padding: 6 }}>
                                <button
                                    type="button"
                                    className="group grid size-11 shrink-0 place-items-center overflow-hidden rounded-md border transition hover:-translate-y-0.5"
                                    style={{ borderColor: `${theme.node.activeStroke}66`, background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
                                    title={`插入 ${reference.label}`}
                                    aria-label={`插入 ${reference.label}`}
                                    onClick={() => !reference.id.endsWith("-current") && insertReferenceAtCursor(reference)}
                                >
                                    <span className="flex size-full items-center justify-center overflow-hidden bg-black/10">
                                        <ReferencePreview reference={reference} fit="cover" />
                                    </span>
                                </button>
                            </Popover>
                        ))}
                        {selectedSkills.map((skill) => (
                            <div
                                key={skill.id}
                                className="group inline-flex h-7 max-w-[18rem] shrink-0 items-center gap-1 rounded-full border px-1.5 text-xs font-semibold"
                                style={{ borderColor: theme.toolbar.border, background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
                                data-canvas-inline-skill
                            >
                                <button
                                    type="button"
                                    className="grid size-4 shrink-0 place-items-center rounded-full opacity-55 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                                    onClick={() => setSelectedSkillIds((current) => current.filter((id) => id !== skill.id))}
                                    aria-label={`移除 Skill ${skill.name}`}
                                >
                                    <X className="size-3" />
                                </button>
                                <Sparkles className="size-3 shrink-0" />
                                <span className="truncate">{skill.name}</span>
                                <CanvasSkillSelector
                                    skills={skills.filter((item) => item.id !== skill.id)}
                                    loading={skillsLoading}
                                    selectedSkillIds={eligibleSelectedSkillIds}
                                    onSelect={(next) => setSelectedSkillIds((current) => current.map((id) => (id === skill.id ? next.id : id)))}
                                    trigger={
                                        <button type="button" className="grid size-4 place-items-center rounded-full transition hover:bg-black/10 dark:hover:bg-white/10" aria-label={`更换 Skill ${skill.name}`}>
                                            <MoreHorizontal className="size-3" />
                                        </button>
                                    }
                                />
                            </div>
                        ))}
                    </div>
                ) : null}
                <div className="relative min-h-0 flex-1">
                    <CanvasResourceMentionTextarea
                        ref={promptEditorRef}
                        value={prompt}
                        references={mentionReferences}
                        inlineTokens={cameraMotionTokens}
                        skills={skills}
                        onSelectSkill={selectSkill}
                        onSelect={(event) => rememberPromptSelection(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
                        onChange={updatePrompt}
                        onSubmit={submit}
                        aria-label="节点提示词"
                        data-testid="canvas-node-prompt-editor"
                        containerClassName="size-full min-h-0"
                        className="thin-scrollbar size-full min-h-[76px] resize-none overflow-y-auto rounded-none !border-0 px-1 pb-5 pt-1 text-sm leading-6 outline-none"
                        style={{ background: "transparent", color: theme.node.text, fontSize: 14, lineHeight: "24px", letterSpacing: "normal" }}
                        placeholder={
                            selectedSkills.length
                                ? selectedSkills[0].promptHint || promptPlaceholder(mode, hasImageContent, hasTextContent, isPanorama)
                                : `${promptPlaceholder(mode, hasImageContent, hasTextContent, isPanorama)}${mode === "image" || mode === "video" ? "，输入 / 选择 Skill" : ""}`
                        }
                    />
                    <div className="pointer-events-none absolute bottom-0 right-1 text-[10px] tabular-nums opacity-30">{prompt.length}/1000</div>
                </div>
                <div className="flex h-9 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border-t pt-1" style={{ borderColor: theme.toolbar.border }}>
                    <div className="canvas-composer-tools thin-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden whitespace-nowrap">{renderModelAndSettings()}</div>
                    {!isRunning ? (
                        <span
                            data-canvas-credit-cost
                            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-semibold tabular-nums"
                            style={{ borderColor: theme.toolbar.border, background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
                        >
                            <CreditSymbol />
                            {formatCreditAmount(credits)}
                        </span>
                    ) : (
                        <LoaderCircle className="size-4 shrink-0 animate-spin opacity-60" />
                    )}
                    {generateButton()}
                </div>
            </section>

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
                    afterOpenChange={(open: boolean) => {
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
                            inlineTokens={cameraMotionTokens}
                            skills={skills}
                            onSelectSkill={selectSkill}
                            onChange={updatePrompt}
                            onSubmit={submitExpanded}
                            aria-label="提示词编辑器"
                            className="thin-scrollbar h-[min(52vh,26rem)] min-h-64 w-full resize-none border-0 px-4 py-3 text-sm leading-6 outline-none"
                            style={{ background: theme.node.fill, color: theme.node.text, fontSize: 14, lineHeight: "24px", letterSpacing: "normal" }}
                            placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent, isPanorama)}
                        />
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                        <Button icon={<Minimize2 className="size-4" />} onClick={() => setExpanded(false)} aria-label="收起提示词输入">
                            收起
                        </Button>
                        <GenerationActionButton running={isRunning} cancellable disabled={!isRunning && !canGenerate} onClick={() => (isRunning ? onStop(node.id) : submitExpanded())} aria-label={isRunning ? "停止生成" : "生成"}>
                            {isRunning ? "停止生成" : "生成"}
                        </GenerationActionButton>
                    </div>
                </Modal>
            </div>
        </div>
    );
}

function ReferencePreview({ reference, fit = "contain" }: { reference: CanvasResourceReference; fit?: "contain" | "cover" }) {
    const className = `size-full ${fit === "cover" ? "object-cover" : "object-contain"}`;
    if (reference.kind === "image" && reference.previewUrl) return <img src={imagePreviewUrl(reference.previewUrl, 360)} alt={reference.title} className={className} />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className={className} muted preload="metadata" playsInline />;
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

function ReferenceHoverPreview({ reference }: { reference: CanvasResourceReference }) {
    return (
        <div className="w-56 overflow-hidden rounded-lg bg-black text-white shadow-xl">
            <div className="aspect-video overflow-hidden bg-black">
                <ReferencePreview reference={reference} />
            </div>
            <div className="truncate px-2.5 py-2 text-xs font-medium">{reference.title}</div>
        </div>
    );
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

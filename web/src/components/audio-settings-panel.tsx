"use client";

import { type ClipboardEvent, type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Popover, Select, Slider, type SelectProps } from "antd";
import { ChevronDown, Headphones } from "lucide-react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceOptions, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { canvasSelectionBorderStyle, type CanvasTheme } from "@/lib/canvas-theme";
import { classifyMiniMaxVoice } from "@/lib/minimax-audio";
import { isQwenAudioModel, qwenAudioModelFamily, qwenAudioSystemVoices, qwenDefaultAudioVoice } from "@/lib/qwen-audio";
import { defaultConfig, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];
const qwenFormatOptions = ["mp3", "wav", "pcm", "opus"].map((value) => ({ value, label: value.toUpperCase() }));
const qwenSampleRateOptions = ["8000", "16000", "22050", "24000", "44100", "48000"].map((value) => ({ value, label: `${value} Hz` }));
const miniMaxEmotionOptions = [
    { value: "", label: "自适应" },
    { value: "happy", label: "快乐的" },
    { value: "sad", label: "悲伤的" },
    { value: "angry", label: "愤怒的" },
    { value: "fearful", label: "恐惧的" },
    { value: "disgusted", label: "厌恶的" },
    { value: "surprised", label: "惊讶的" },
    { value: "neutral", label: "中性的" },
];

type AudioSettingKey =
    | "audioMode"
    | "audioVoice"
    | "audioFormat"
    | "audioSpeed"
    | "audioVolume"
    | "audioPitch"
    | "audioEmotion"
    | "audioLanguageBoost"
    | "audioSampleRate"
    | "audioBitrate"
    | "audioChannel"
    | "audioLyrics"
    | "audioInstructions";

type MiniMaxVoiceOption = {
    value: string;
    label: string;
    voiceName: string;
    description: string;
    category: string;
    model?: string;
    scene?: string;
    feature?: string;
    age?: string;
    gender?: string;
    language?: string;
    previewUrl?: string;
};

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    showModeSelector?: boolean;
    className?: string;
    sourceAudioUrl?: string;
    autoOpenVoiceModal?: boolean;
    onVoiceModalOpen?: () => void;
    onVoiceModalClose?: () => void;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, showModeSelector = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", sourceAudioUrl = "", autoOpenVoiceModal = false, onVoiceModalOpen, onVoiceModalClose }: AudioSettingsPanelProps) {
    const [miniMaxVoices, setMiniMaxVoices] = useState<{ system: MiniMaxVoiceOption[]; personal: MiniMaxVoiceOption[] }>({ system: [], personal: [] });
    const [voiceModalOpen, setVoiceModalOpen] = useState(false);
    const [voiceName, setVoiceName] = useState("");
    const [voiceDescription, setVoiceDescription] = useState("");
    const [voicePrompt, setVoicePrompt] = useState("");
    const [voiceFile, setVoiceFile] = useState<File | null>(null);
    const voiceFileInputRef = useRef<HTMLInputElement>(null);
    const [voiceSaving, setVoiceSaving] = useState(false);
    const [voiceError, setVoiceError] = useState("");
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const currentModel = modelOptionName(requestConfig.model).trim();
    const currentProtocol = requestConfig.advancedConfig?.protocol;
    const isQwen = currentProtocol === "aliyun-bailian-audio" || isQwenAudioModel(currentModel);
    const isMiniMax = !isQwen && (currentProtocol === "minimax-audio" || currentProtocol === "tencent-tokenhub-music" || /^(?:speech|music)-/i.test(currentModel) || currentModel === "minimax-music-v3.0");
    const qwenModel = currentModel;
    const qwenVoiceValues = useMemo(() => {
        if (miniMaxVoices.system.length && isQwen) return miniMaxVoices.system;
        return qwenAudioSystemVoices(qwenModel).map((item) => ({ value: item.voiceParam, label: item.voiceName, voiceName: item.voiceName, description: item.feature, category: item.feature, model: item.model, scene: item.scene, feature: item.feature, age: item.age, gender: item.gender, language: item.language, ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}) }));
    }, [isQwen, miniMaxVoices.system, qwenModel]);
    const isQwen3Model = /^qwen3-tts-/i.test(qwenModel);
    const isQwen3Snapshot = /^qwen3-tts-(?:vc|vd)-/i.test(qwenModel);
    const isVoiceProvider = isMiniMax || isQwen;
    const miniMaxVoiceValues = [...miniMaxVoices.system, ...miniMaxVoices.personal];
    const miniMaxVoice = miniMaxVoiceValues.some((item) => item.value === config.audioVoice) ? config.audioVoice : miniMaxVoices.system[0]?.value || "";
    const voice = isQwen ? String(config.audioVoice || "").trim() : isMiniMax ? miniMaxVoice : normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);
    const speedSelectOptions = speedOptions.map((value) => ({ value, label: audioSpeedLabel(value) }));
    const groupVoices = (items: MiniMaxVoiceOption[], source: string) => {
        const groups = new Map<string, MiniMaxVoiceOption[]>();
        for (const item of items) groups.set(item.category, [...(groups.get(item.category) || []), item]);
        return Array.from(groups, ([category, options]) => ({ label: `${source} · ${category}（${options.length}）`, options }));
    };
    const miniMaxVoiceOptions: NonNullable<SelectProps["options"]> = [...groupVoices(miniMaxVoices.system, "系统音色"), ...groupVoices(miniMaxVoices.personal, "个人创建")];
    const qwenVoiceOptions: NonNullable<SelectProps["options"]> = [
        ...groupVoices(qwenVoiceValues, `系统音色 · ${qwenAudioModelFamily(qwenModel)}`),
        ...groupVoices(miniMaxVoices.personal.filter((item) => !audioVoiceOptions.some((option) => option.value === item.value) && (!item.model || item.model === qwenModel)), "个人创建"),
    ].filter((group) => group.options.length);
    const qwenPersonalVoices = useMemo(() => miniMaxVoices.personal.filter((item) => !audioVoiceOptions.some((option) => option.value === item.value) && (!item.model || item.model === qwenModel)), [miniMaxVoices.personal, qwenModel]);
    const qwenVoice = qwenVoiceValues.some((item) => item.value === voice) || qwenPersonalVoices.some((item) => item.value === voice) ? voice : qwenDefaultAudioVoice(qwenModel);
    const openVoiceModal = useCallback(() => {
        setVoiceError("");
        onVoiceModalOpen?.();
        setVoiceModalOpen(true);
    }, [onVoiceModalOpen]);

    useEffect(() => {
        if (!autoOpenVoiceModal) return;
        openVoiceModal();
    }, [autoOpenVoiceModal, openVoiceModal]);

    useEffect(() => {
        if (!isVoiceProvider || config.audioMode !== "tts") return;
        let active = true;
        fetch(isQwen ? `/api/qwen-audio/voices?model=${encodeURIComponent(qwenModel)}` : "/api/minimax/voices", { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((payload: { system?: Array<{ remoteVoiceId: string; name: string; voiceName?: string; description?: string; category?: string; model?: string; scene?: string; feature?: string; age?: string; gender?: string; language?: string; previewUrl?: string }>; personal?: Array<{ remoteVoiceId: string; name: string; voiceName?: string; description?: string; category?: string; model?: string; scene?: string; feature?: string; age?: string; gender?: string; language?: string; previewUrl?: string }> } | null) => {
                if (!active || !payload) return;
                const mapOptions = (items: Array<{ remoteVoiceId: string; name: string; voiceName?: string; description?: string; category?: string; model?: string; scene?: string; feature?: string; age?: string; gender?: string; language?: string; previewUrl?: string }>) => Array.from(new Map(items.map((item) => {
                    const voiceName = item.voiceName || item.name;
                    const description = item.description || "";
                    return [item.remoteVoiceId, { value: item.remoteVoiceId, label: voiceName, voiceName, description, category: item.category || item.feature || classifyMiniMaxVoice(voiceName, description), model: item.model, scene: item.scene, feature: item.feature, age: item.age, gender: item.gender, language: item.language, ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}) }];
                })).values());
                const systemItems = isQwen ? payload.system || [] : [...(payload.system || [])].reverse();
                setMiniMaxVoices({ system: mapOptions(systemItems), personal: mapOptions(payload.personal || []) });
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [config.audioMode, config.model, isQwen, isVoiceProvider, qwenModel]);

    useEffect(() => {
        if (config.audioMode === "tts" && isQwen && qwenVoice && config.audioVoice !== qwenVoice && !qwenVoiceValues.some((item) => item.value === voice) && !qwenPersonalVoices.some((item) => item.value === voice)) onConfigChange("audioVoice", qwenVoice);
        if (config.audioMode === "tts" && isMiniMax && miniMaxVoice && miniMaxVoice !== config.audioVoice) onConfigChange("audioVoice", miniMaxVoice);
    }, [config.audioMode, config.audioVoice, isMiniMax, isQwen, miniMaxVoice, onConfigChange, qwenPersonalVoices, qwenVoice, qwenVoiceValues, voice]);

    const createVoice = async () => {
        setVoiceError("");
        setVoiceSaving(true);
        try {
            const clone = config.audioMode === "voice-clone";
            let cloneFile = voiceFile;
            if (clone && !cloneFile && sourceAudioUrl) {
                const sourceResponse = await fetch(sourceAudioUrl);
                if (sourceResponse.ok) {
                    const blob = await sourceResponse.blob();
                    cloneFile = new File([blob], "canvas-audio.wav", { type: blob.type || "audio/wav" });
                }
            }
            if (clone && !cloneFile) throw new Error("音色复刻需要先上传参考音频");
            if (!clone && !voicePrompt.trim()) throw new Error("音色设计需要填写音色提示词");
            const response = clone
                ? await fetch(isQwen ? "/api/qwen-audio/voices/clone" : "/api/minimax/voices/clone", (() => {
                      const body = new FormData();
                      body.set("file", cloneFile!);
                      body.set("name", voiceName.trim() || "我的复刻音色");
                      body.set("description", voiceDescription.trim());
                      if (isQwen) body.set("model", requestConfig.model);
                      return { method: "POST", body };
                  })())
                : await fetch(isQwen ? "/api/qwen-audio/voices" : "/api/minimax/voices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "design", model: requestConfig.model, name: voiceName.trim() || "我的设计音色", prompt: voicePrompt, description: voiceDescription.trim() }) });
            const payload = (await response.json().catch(() => ({}))) as { voice?: { remoteVoiceId: string; name: string; voiceName?: string; description?: string }; error?: string };
            if (!response.ok || !payload.voice) throw new Error(payload.error || "创建 MiniMax 音色失败");
            onConfigChange("audioVoice", payload.voice.remoteVoiceId);
            onConfigChange("audioMode", "tts");
            const createdVoiceName = payload.voice.voiceName || payload.voice.name;
            const description = payload.voice.description || voiceDescription.trim();
            const option = { value: payload.voice.remoteVoiceId, label: createdVoiceName, voiceName: createdVoiceName, description, category: classifyMiniMaxVoice(createdVoiceName, description) };
            setMiniMaxVoices((current) => ({ ...current, personal: [option, ...current.personal.filter((item) => item.value !== option.value)] }));
            setVoiceModalOpen(false);
            setVoiceFile(null);
            onVoiceModalClose?.();
        } catch (reason) {
            setVoiceError(reason instanceof Error ? reason.message : `创建${isQwen ? "百炼" : "MiniMax"}音色失败`);
        } finally {
            setVoiceSaving(false);
        }
    };

    const setSelectedVoiceFile = (candidate: File | null | undefined) => {
        if (!candidate) return;
        const isAudio = candidate.type.startsWith("audio/") || /\.(?:mp3|m4a|wav|ogg|aac|flac)$/i.test(candidate.name);
        if (!isAudio) {
            setVoiceError("请选择 MP3、M4A、WAV 等音频文件");
            return;
        }
        if (candidate.size > 20 * 1024 * 1024) {
            setVoiceError("复刻音频不能超过 20MB");
            return;
        }
        setVoiceFile(candidate);
        setVoiceError("");
    };

    const handleVoiceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setSelectedVoiceFile(event.dataTransfer.files?.[0]);
    };

    const handleVoicePaste = (event: ClipboardEvent<HTMLDivElement>) => {
        const candidate = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("audio/") || /\.(?:mp3|m4a|wav|ogg|aac|flac)$/i.test(file.name));
        if (!candidate) return;
        event.preventDefault();
        setSelectedVoiceFile(candidate);
    };

    const closeVoiceModal = () => {
        if (voiceSaving) return;
        setVoiceModalOpen(false);
        onVoiceModalClose?.();
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                {showModeSelector ? <SettingGroup title="功能" color={theme.node.muted}>
                    <AudioSelect
                        value={config.audioMode || "tts"}
                        options={[
                            { value: "tts", label: "文转语音" },
                            { value: "voice-clone", label: "音色复刻" },
                            { value: "voice-design", label: "音色设计" },
                            { value: "music", label: "音乐设计" },
                        ]}
                        theme={theme}
                        onChange={(value) => onConfigChange("audioMode", value)}
                    />
                </SettingGroup> : null}
                {config.audioMode === "music" ? (
                    <>
                        <SettingGroup title="风格定义" color={theme.node.muted}>
                            <textarea
                                value={config.audioInstructions || ""}
                                placeholder="请输入音乐类型、情绪、BPM、乐器等"
                                className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                                onMouseDown={(event) => event.stopPropagation()}
                            />
                        </SettingGroup>
                        <div className="grid grid-cols-2 gap-2.5">
                            <SettingGroup title="歌词" color={theme.node.muted}>
                                <textarea value={config.audioLyrics || ""} placeholder="可选，输入歌词" className="h-16 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm outline-none" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onChange={(event) => onConfigChange("audioLyrics", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            </SettingGroup>
                        </div>
                    </>
                ) : config.audioMode === "voice-clone" || config.audioMode === "voice-design" ? autoOpenVoiceModal ? null : (
                    <div className="space-y-2 rounded-xl border px-3 py-2.5 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        <div>{config.audioMode === "voice-clone" ? "上传参考音频创建复刻音色，然后在提示词面板填写要输出的文字并生成" : "点击下方按钮创建音色，名称、介绍和音色提示词在弹出层中填写"}</div>
                        {isVoiceProvider && (isQwen || (config.audioMode === "voice-clone" ? requestConfig.advancedConfig?.minimaxVoiceCloneEnabled !== false : requestConfig.advancedConfig?.minimaxVoiceDesignEnabled !== false)) ? <Button size="small" type="link" className="!px-0" onClick={openVoiceModal}>{config.audioMode === "voice-clone" ? "复刻新音色" : "设计新音色"}</Button> : null}
                    </div>
                ) : isMiniMax ? (
                    <div className="space-y-3">
                        <SettingGroup title="音色" color={theme.node.muted}>
                            <AudioVoiceSelect value={voice} options={miniMaxVoiceOptions.length ? miniMaxVoiceOptions : [{ value: "", label: "正在获取音色目录", disabled: true }]} theme={theme} onChange={(value) => onConfigChange("audioVoice", value)} />
                        </SettingGroup>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                            <RangeSetting title="语速" value={Number(config.audioSpeed || 1)} min={0.5} max={2} step={0.05} theme={theme} onChange={(value) => onConfigChange("audioSpeed", String(value))} />
                            <RangeSetting title="音量" value={Number(config.audioVolume || 1)} min={0} max={10} step={0.1} theme={theme} onChange={(value) => onConfigChange("audioVolume", String(value))} />
                            <RangeSetting title="音高" value={Number(config.audioPitch || 0)} min={-12} max={12} step={1} theme={theme} onChange={(value) => onConfigChange("audioPitch", String(value))} />
                        </div>
                        <SettingGroup title="情感" color={theme.node.muted}>
                            <div className="grid grid-cols-4 gap-1 rounded-xl p-1" style={{ background: theme.node.subtleSurface }}>
                                {miniMaxEmotionOptions.map((option) => <button key={option.value || "auto"} type="button" className="rounded-lg px-1.5 py-1.5 text-xs transition" style={{ background: config.audioEmotion === option.value ? theme.node.fill : "transparent", color: config.audioEmotion === option.value ? theme.node.text : theme.node.muted }} onClick={() => onConfigChange("audioEmotion", option.value)}>{option.label}</button>)}
                            </div>
                        </SettingGroup>
                    </div>
                ) : isQwen && config.audioMode === "tts" ? (
                    <div className="space-y-3">
                        <SettingGroup title="音色" color={theme.node.muted}>
                            <AudioVoiceSelect
                                value={qwenVoice}
                                options={qwenVoiceOptions.length ? qwenVoiceOptions : [{ value: "", label: "请先创建该模型的个人音色", disabled: true }]}
                                theme={theme}
                                onChange={(value) => onConfigChange("audioVoice", value)}
                            />
                            {isQwen3Snapshot && !qwenVoice ? <div className="text-xs" style={{ color: theme.node.muted }}>Qwen-TTS 复刻/设计模型必须先创建并选择与当前模型绑定的个人音色。</div> : null}
                        </SettingGroup>
                        {!isQwen3Model ? <>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                                <RangeSetting title="语速" value={Number(config.audioSpeed || 1)} min={0.5} max={2} step={0.05} theme={theme} onChange={(value) => onConfigChange("audioSpeed", String(value))} />
                                <RangeSetting title="音量" value={config.audioVolume === defaultConfig.audioVolume ? 50 : Number(config.audioVolume || 50)} min={0} max={100} step={1} theme={theme} onChange={(value) => onConfigChange("audioVolume", String(value))} />
                                <RangeSetting title="音高" value={config.audioPitch === defaultConfig.audioPitch ? 1 : Number(config.audioPitch || 1)} min={0.5} max={2} step={0.05} theme={theme} onChange={(value) => onConfigChange("audioPitch", String(value))} />
                            </div>
                            <div className="grid grid-cols-2 gap-2.5">
                                <SettingGroup title="格式" color={theme.node.muted}><AudioSelect value={format === "pcm" ? "pcm" : format === "wav" ? "wav" : format === "opus" ? "opus" : "mp3"} options={qwenFormatOptions} theme={theme} onChange={(value) => onConfigChange("audioFormat", value)} /></SettingGroup>
                                <SettingGroup title="采样率" color={theme.node.muted}><AudioSelect value={qwenSampleRateOptions.some((item) => item.value === config.audioSampleRate) ? config.audioSampleRate : "24000"} options={qwenSampleRateOptions} theme={theme} onChange={(value) => onConfigChange("audioSampleRate", value)} /></SettingGroup>
                            </div>
                            {/^(?:cosyvoice-)/i.test(qwenModel) ? <SettingGroup title="声音指令" color={theme.node.muted}><textarea value={config.audioInstructions || ""} placeholder="例如：请用河南话表达。" className="h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onChange={(event) => onConfigChange("audioInstructions", event.target.value)} onMouseDown={(event) => event.stopPropagation()} /></SettingGroup> : null}
                        </> : null}
                    </div>
                ) : (
                    <SettingGroup title="声音" color={theme.node.muted}>
                        <AudioSelect value={voice} options={audioVoiceOptions} theme={theme} onChange={(value) => onConfigChange("audioVoice", value)} />
                    </SettingGroup>
                )}
                {config.audioMode === "music" ? <div className="space-y-3">
                    <SettingGroup title="输出格式" color={theme.node.muted}><AudioSelect value={format} options={audioFormatOptions} theme={theme} onChange={(value) => onConfigChange("audioFormat", value)} /></SettingGroup>
                    <SegmentedSetting title="比特率" value={config.audioBitrate || "128000"} options={["32000", "60000", "64000", "128000", "256000"]} theme={theme} onChange={(value) => onConfigChange("audioBitrate", value)} />
                    <SegmentedSetting title="采样率" value={config.audioSampleRate || "16000"} options={["16000", "24000", "32000", "44100"]} theme={theme} onChange={(value) => onConfigChange("audioSampleRate", value)} />
                </div> : config.audioMode !== "voice-clone" && config.audioMode !== "voice-design" && !isMiniMax && !isQwen ? <div className="grid grid-cols-2 gap-2.5">
                    <SettingGroup title="格式" color={theme.node.muted}>
                        <AudioSelect value={format} options={audioFormatOptions} theme={theme} onChange={(value) => onConfigChange("audioFormat", value)} />
                    </SettingGroup>
                    <SettingGroup title="语速" color={theme.node.muted}>
                        <AudioSelect value={speed} options={speedSelectOptions} theme={theme} onChange={(value) => onConfigChange("audioSpeed", value)} />
                    </SettingGroup>
                    <SettingGroup title="音量" color={theme.node.muted}>
                        <Slider min={0} max={2} step={0.05} value={Number(config.audioVolume || 1)} onChange={(value) => onConfigChange("audioVolume", String(value))} />
                    </SettingGroup>
                </div> : null}
            </div>
            <Modal
                className="canvas-audio-voice-modal"
                title={`${config.audioMode === "voice-clone" ? "复刻" : "设计"} ${isQwen ? "阿里云百炼" : "MiniMax"} 音色`}
                open={voiceModalOpen}
                onCancel={closeVoiceModal}
                centered
                zIndex={1400}
                width="min(680px, calc(100vw - 24px))"
                styles={{
                    container: { padding: 0, overflow: "hidden", ...canvasSelectionBorderStyle(theme.toolbar.panel) },
                    header: { marginBottom: 0, padding: "18px 22px 12px", background: theme.toolbar.panel },
                    body: { padding: "0 22px 18px" },
                    footer: { marginTop: 0, padding: "12px 22px 18px", borderTop: `1px solid ${theme.node.stroke}` },
                }}
                footer={[
                    <Button key="cancel" onClick={closeVoiceModal} disabled={voiceSaving}>取消</Button>,
                    <Button key="submit" type="primary" loading={voiceSaving} style={{ background: theme.node.action, borderColor: theme.node.action, color: theme.node.actionText, opacity: 1 }} onMouseDown={(event) => event.stopPropagation()} onClick={() => void createVoice()}>创建并使用</Button>,
                ]}
                modalRender={(node) => <div onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>{node}</div>}
            >
                <div className="flex flex-col gap-4 pt-1">
                    <Input value={voiceName} placeholder="前端显示名称" onChange={(event) => setVoiceName(event.target.value)} />
                    {config.audioMode === "voice-clone" ? <div className="flex flex-col gap-4"><Input.TextArea className="!min-h-20" value={voiceDescription} maxLength={500} showCount placeholder="音色介绍（仅保存到当前项目后台，不会发送到上游）" onChange={(event) => setVoiceDescription(event.target.value)} /><div className="flex cursor-pointer flex-col gap-3 rounded-xl border border-dashed p-4" onClick={() => voiceFileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={handleVoiceDrop} onPaste={handleVoicePaste} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") voiceFileInputRef.current?.click(); }} role="button" tabIndex={0}><div className="text-sm font-medium">参考音频</div><div className="text-xs text-stone-500">将音频拖到这里，或点击区域后粘贴，也可以选择文件。支持 MP3、M4A、WAV，最大 20MB。</div><div className="flex flex-wrap items-center gap-2"><Button onClick={(event) => { event.stopPropagation(); voiceFileInputRef.current?.click(); }}>选择文件</Button><span className="max-w-full truncate text-xs text-stone-600 dark:text-stone-300">{voiceFile?.name || (sourceAudioUrl ? "将使用当前音频节点文件" : "未选择文件")}</span></div><input ref={voiceFileInputRef} className="hidden" type="file" accept="audio/*,.mp3,.m4a,.wav" onChange={(event) => setSelectedVoiceFile(event.target.files?.[0])} /></div><div className="text-xs text-stone-500">上传参考音频创建音色后，回到提示词面板填写要输出的文字文案，点击生成即可用该音色合成语音。</div></div> : <div className="flex flex-col gap-4"><Input.TextArea className="!min-h-20" value={voiceDescription} maxLength={500} showCount placeholder="音色介绍（仅保存到当前项目后台，方便辨识音色类型，不会发送到上游）" onChange={(event) => setVoiceDescription(event.target.value)} /><Input.TextArea className="!min-h-24" value={voicePrompt} placeholder="音色提示词：描述想要的音色，例如温暖、成熟、纪录片旁白；内容越具体，音色效果越稳定" onChange={(event) => setVoicePrompt(event.target.value)} /></div>}
                    {voiceError ? <div className="text-sm text-red-500">{voiceError}</div> : null}
                </div>
            </Modal>
        </ImageSettingsTheme>
    );
}

function AudioSelect({ value, options, theme, onChange }: { value: string; options: NonNullable<SelectProps["options"]>; theme: CanvasTheme; onChange: (value: string) => void }) {
    return <AudioSelectBase value={value} options={options} theme={theme} onChange={onChange} />;
}

function AudioVoiceSelect({ value, options, theme, onChange }: { value: string; options: NonNullable<SelectProps["options"]>; theme: CanvasTheme; onChange: (value: string) => void }) {
    type VoiceOptionData = Partial<MiniMaxVoiceOption> & { value?: string | number; label?: ReactNode; disabled?: boolean };
    type VoiceEntry = { value: string; voiceName: string; description: string; category: string; previewUrl?: string; disabled?: boolean };
    const voiceEntries = useMemo<VoiceEntry[]>(() => options.flatMap((option) => {
        const group = option as { label?: ReactNode; options?: NonNullable<SelectProps["options"]> };
        const groupLabel = String(group.label || "其他").replace(/（\d+）$/, "");
        const groupSource = groupLabel.split(" · ")[0] || "其他";
        const items = group.options || [option];
        return items.map((item) => {
            const data = item as VoiceOptionData;
            const voiceName = String(data.voiceName || (typeof data.label === "string" ? data.label : data.value || "未命名音色"));
            const categoryName = String(data.category || data.feature || groupLabel || "其他");
            return { value: String(data.value ?? ""), voiceName, description: String(data.description || data.feature || "暂无音色介绍"), category: `${groupSource} · ${categoryName}`, ...(data.previewUrl ? { previewUrl: data.previewUrl } : {}), ...(data.disabled ? { disabled: true } : {}) };
        });
    }), [options]);
    const categories = useMemo(() => [
        { key: "全部", count: voiceEntries.length },
        ...Array.from(new Map(voiceEntries.map((entry) => [entry.category, 1])).keys()).map((key) => ({ key, count: voiceEntries.filter((entry) => entry.category === key).length })),
    ], [voiceEntries]);
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState("全部");
    const filteredEntries = category === "全部" ? voiceEntries : voiceEntries.filter((entry) => entry.category === category);
    const selectCategory = (nextCategory: string) => {
        setCategory(nextCategory);
        if (nextCategory === "全部") return;
        const first = voiceEntries.find((entry) => entry.category === nextCategory && !entry.disabled && entry.value);
        if (first && first.value !== String(value)) onChange(first.value);
    };
    useEffect(() => {
        if (!categories.some((item) => item.key === category)) setCategory("全部");
    }, [categories, category]);
    const selected = voiceEntries.find((entry) => entry.value === String(value));
    const label = selected?.voiceName || (value ? value : "请选择音色");
    const content = (
        <div
            data-audio-voice-popover
            className="w-[min(680px,calc(100vw-32px))] max-w-full overflow-hidden"
            style={{ color: theme.node.text }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="border-b px-4 pb-3 pt-3" style={{ borderColor: theme.toolbar.border }}>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">选择音色</span>
                    <span className="text-[11px]" style={{ color: theme.node.muted }}>{selected?.category || `${voiceEntries.length} 个音色`}</span>
                </div>
                <div className="hide-scrollbar flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="音色分类">
                    {categories.map((item) => {
                        const active = item.key === category;
                        return <button key={item.key} type="button" role="tab" aria-selected={active} className="flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" style={{ background: active ? theme.toolbar.activeBg : "transparent", color: active ? theme.toolbar.activeText : theme.node.muted }} onClick={() => selectCategory(item.key)}>{item.key}<span className="opacity-60">{item.count}</span></button>;
                    })}
                </div>
            </div>
            <div className="thin-scrollbar grid max-h-[min(390px,calc(100dvh-250px))] min-h-20 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
                {filteredEntries.length ? filteredEntries.map((entry) => {
                    const active = entry.value === String(value);
                    return <div key={`${entry.category}-${entry.value || entry.voiceName}`} role="button" tabIndex={entry.disabled ? -1 : 0} aria-disabled={entry.disabled || undefined} className="rounded-xl border p-3 text-left transition" style={{ borderColor: active ? theme.node.activeStroke : theme.toolbar.border, background: active ? theme.node.subtleSurface : theme.node.fill, opacity: entry.disabled ? 0.65 : 1, cursor: entry.disabled ? "default" : "pointer" }} onClick={() => { if (!entry.disabled && entry.value) { onChange(entry.value); setOpen(false); } }} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !entry.disabled && entry.value) { event.preventDefault(); onChange(entry.value); setOpen(false); } }}>
                        <div className="flex min-w-0 items-start gap-2">
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.itemHover, color: active ? theme.toolbar.activeText : theme.node.muted }}><Headphones className="size-3.5" /></span>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{entry.voiceName}</div>
                                <div className="mt-1 line-clamp-2 text-xs leading-5" style={{ color: theme.node.muted }}>{entry.description}</div>
                                {entry.previewUrl ? <audio controls preload="none" src={entry.previewUrl} className="mt-2 h-7 w-full max-w-[220px]" aria-label={`试听 ${entry.voiceName}`} onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} /> : null}
                            </div>
                        </div>
                    </div>;
                }) : <div className="col-span-full py-10 text-center text-xs" style={{ color: theme.node.muted }}>当前分类暂无音色</div>}
            </div>
        </div>
    );
    return <div className="block w-full" onMouseDown={(event) => event.stopPropagation()}>
        <Popover
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            open={open}
            onOpenChange={setOpen}
            zIndex={1325}
            getPopupContainer={() => document.body}
            styles={{ container: { padding: 0, borderRadius: 16, overflow: "hidden", ...canvasSelectionBorderStyle(theme.toolbar.panel) } }}
            content={content}
        >
            <button type="button" className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border px-3 text-left text-sm transition hover:brightness-110" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }} aria-haspopup="dialog" aria-expanded={open}>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <ChevronDown className={`size-4 shrink-0 opacity-65 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
        </Popover>
    </div>;
}

function AudioSelectBase({ value, options, theme, onChange, voiceMode = false }: { value: string; options: NonNullable<SelectProps["options"]>; theme: CanvasTheme; onChange: (value: string) => void; voiceMode?: boolean }) {
    void theme;
    return (
        <span className="block [&_.ant-select]:w-full" onMouseDown={(event) => event.stopPropagation()}>
            <Select
                value={value}
                options={options}
                onChange={onChange}
                listHeight={voiceMode ? 420 : 360}
                popupMatchSelectWidth={voiceMode ? 560 : 420}
                getPopupContainer={() => document.body}
                styles={{ popup: { root: { zIndex: 1305 } } }}
                optionRender={(option) => {
                    const data = option.data as Partial<MiniMaxVoiceOption>;
                    return data.voiceName ? <div className="min-w-[420px] py-1" onMouseDown={(event) => event.stopPropagation()}><div className="font-medium">{data.voiceName}</div><div className="mt-0.5 truncate text-xs opacity-60">{data.description || data.feature || "暂无音色介绍"}</div>{data.previewUrl ? <audio controls preload="none" src={data.previewUrl} className="mt-1 h-7 w-48" onMouseDown={(event) => event.stopPropagation()} /> : null}</div> : <span>{option.label}</span>;
                }}
            />
        </span>
    );
}

function RangeSetting({ title, value, min, max, step, theme, onChange }: { title: string; value: number; min: number; max: number; step: number; theme: CanvasTheme; onChange: (value: number) => void }) {
    const safeValue = Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
    return <SettingGroup title={title} color={theme.node.muted}><div className="flex items-center gap-2"><Slider className="min-w-0 flex-1" min={min} max={max} step={step} value={safeValue} tooltip={{ formatter: null }} onChange={(next) => onChange(Number(next))} /><span className="min-w-9 rounded-md border px-1.5 py-0.5 text-center text-xs tabular-nums" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>{safeValue}</span></div></SettingGroup>;
}

function SegmentedSetting({ title, value, options, theme, onChange }: { title: string; value: string; options: string[]; theme: CanvasTheme; onChange: (value: string) => void }) {
    return <SettingGroup title={title} color={theme.node.muted}><div className="grid grid-cols-5 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }}>{options.map((option) => <button key={option} type="button" className="min-w-0 px-2 py-2 text-xs transition" style={{ background: value === option ? theme.node.subtleSurface : "transparent", color: value === option ? theme.node.text : theme.node.muted }} onClick={() => onChange(option)}>{option}</button>)}</div></SettingGroup>;
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

"use client";

import { useEffect, useState } from "react";
import { Mic2, Music2, Sparkles, WandSparkles } from "lucide-react";
import { Select } from "antd";

import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@/lib/audio-generation";
import { isQwenAudioModel } from "@/lib/qwen-audio";
import { modelOptionName, resolveModelRequestConfig } from "@/stores/use-config-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasSettingsPopoverShell, type CanvasSettingsPopoverPlacement } from "./canvas-settings-popover-shell";

export type CanvasAudioSettingKey =
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

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: CanvasSettingsPopoverPlacement;
    sourceAudioUrl?: string;
};

const AUDIO_MODE_OPTIONS = [
    { value: "tts", label: "文转语音", description: "将文字转换为语音", icon: <Sparkles className="size-3.5" /> },
    { value: "voice-clone", label: "音色复刻", description: "上传音频复刻音色，再填写文案生成语音", icon: <Mic2 className="size-3.5" /> },
    { value: "voice-design", label: "音色设计", description: "按音色提示词设计全新音色", icon: <WandSparkles className="size-3.5" /> },
    { value: "music", label: "音乐设计", description: "根据风格生成音乐", icon: <Music2 className="size-3.5" /> },
] as const;
type CanvasAudioMode = (typeof AUDIO_MODE_OPTIONS)[number]["value"];

export function CanvasAudioModePicker({ value, onChange, disabledModes = [] }: { value?: CanvasAudioMode; onChange: (value: CanvasAudioMode) => void; disabledModes?: string[] }) {
    const active = AUDIO_MODE_OPTIONS.find((item) => item.value === (value || "tts")) || AUDIO_MODE_OPTIONS[0];
    return <span className="block w-[7.2rem] shrink-0 [&_.ant-select]:w-full" data-canvas-no-drag onMouseDown={(event) => event.stopPropagation()}><Select size="small" value={active.value} options={AUDIO_MODE_OPTIONS.map(({ value: optionValue, label, description }) => ({ value: optionValue, label, description, disabled: disabledModes.includes(optionValue) }))} onChange={onChange} optionRender={(option) => <div className="py-0.5"><div className="font-medium">{option.data.label}{option.data.disabled ? "（已关闭）" : ""}</div><div className="text-[11px] opacity-60">{option.data.description}</div></div>} prefix={<span className="text-current">{active.icon}</span>} /></span>;
}

export function CanvasAudioSettingsPopover({ config, onConfigChange, buttonClassName, placement = "top", sourceAudioUrl }: CanvasAudioSettingsPopoverProps) {
    const [voiceNames, setVoiceNames] = useState<Record<string, string>>({});
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const currentModel = modelOptionName(requestConfig.model).trim();
    useEffect(() => {
        if (config.audioMode !== "tts" || !config.audioVoice.trim()) return;
        let active = true;
        const isQwen = requestConfig.advancedConfig?.protocol === "aliyun-bailian-audio" || isQwenAudioModel(currentModel);
        const url = isQwen ? `/api/qwen-audio/voices?model=${encodeURIComponent(currentModel)}` : "/api/minimax/voices";
        fetch(url, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((payload: { system?: Array<{ remoteVoiceId: string; name: string; voiceName?: string }>; personal?: Array<{ remoteVoiceId: string; name: string; voiceName?: string }> } | null) => {
                if (!active || !payload) return;
                const entries = [...(payload.system || []), ...(payload.personal || [])];
                setVoiceNames(Object.fromEntries(entries.map((item) => [item.remoteVoiceId, item.voiceName || item.name])));
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [config.audioMode, config.audioVoice, currentModel, requestConfig.advancedConfig?.protocol]);
    const voiceLabel = config.audioVoice.trim() ? voiceNames[config.audioVoice] || audioVoiceLabel(config.audioVoice) : "未选择音色";
    const label = config.audioMode === "music" ? `${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}` : config.audioMode === "voice-clone" || config.audioMode === "voice-design" ? "参数设置" : `${voiceLabel} · ${audioSpeedLabel(config.audioSpeed)}`;
    return (
        <CanvasSettingsPopoverShell
            label={label}
            buttonClassName={buttonClassName}
            defaultButtonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"
            placement={placement}
            panelWidth={720}
        >
            {(theme, close, openChildOverlay) => <AudioSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} showTitle={false} showModeSelector={false} className="space-y-4" sourceAudioUrl={sourceAudioUrl} autoOpenVoiceModal={config.audioMode === "voice-clone" || config.audioMode === "voice-design"} onVoiceModalOpen={openChildOverlay} onVoiceModalClose={close} />}
        </CanvasSettingsPopoverShell>
    );
}

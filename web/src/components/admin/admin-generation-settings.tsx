"use client";

import { AutoComplete, Input, InputNumber, Select, Switch } from "antd";
import { CircleGauge, SlidersHorizontal, Sparkles } from "lucide-react";

import { normalizeGenerationPromptRules, type GenerationPromptRuleKey } from "@/lib/generation-prompt-rules";
import type { AuthSettings } from "@/lib/auth/store";
import { resolveLogicalModelCapabilityProfile, resolveLogicalModelConfig } from "@/lib/model-routing-config";
import { LabeledControl, SectionTitle } from "@/components/admin/admin-settings-controls";

const settingsPanelSurfaceClass = "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950";

export type AgentReadiness = {
    ready: boolean;
    capabilities: Array<{ type: "text" | "image" | "video" | "audio"; model: string; ready: boolean; message: string }>;
    skills: Record<"image" | "video" | "canvas" | "drama", number>;
};

export function GenerationConcurrencyPanel({ settings, onChange }: { settings: AuthSettings; onChange: (key: keyof AuthSettings["generationConcurrency"], value: number | null) => void }) {
    return (
        <div className={settingsPanelSurfaceClass}>
            <SectionTitle icon={<Sparkles className="size-4" />} title="每用户并发上限" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <LabeledControl label="Agent 同时运行">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.agent} onChange={(value) => onChange("agent", value)} />
                </LabeledControl>
                <LabeledControl label="生图同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.image} onChange={(value) => onChange("image", value)} />
                </LabeledControl>
                <LabeledControl label="视频同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.video} onChange={(value) => onChange("video", value)} />
                </LabeledControl>
                <LabeledControl label="音频同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.audio} onChange={(value) => onChange("audio", value)} />
                </LabeledControl>
                <LabeledControl label="文本同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.text} onChange={(value) => onChange("text", value)} />
                </LabeledControl>
                <LabeledControl label="整集合成同时运行">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.render} onChange={(value) => onChange("render", value)} />
                </LabeledControl>
                <LabeledControl label="生成处理通道数（1–8）">
                    <InputNumber
                        className="w-full"
                        min={1}
                        max={8}
                        precision={0}
                        value={settings.generationConcurrency.workerLanes}
                        onChange={(value) => onChange("workerLanes", value === null ? value : Math.max(1, Math.min(8, value)))}
                    />
                </LabeledControl>
            </div>
            <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">限制的是单个用户自己的并发任务，不是全站共享上限。「生成处理通道数」决定后台 Worker 同时处理的任务数量，可设置范围 1–8（保存后约 15 秒内自动生效，无需重启；输入超出范围会自动收敛到边界值，服务端同样强制校验）。</div>
        </div>
    );
}

export function GenerationCostControlPanel({ settings, onChange }: { settings: AuthSettings; onChange: (key: keyof AuthSettings["generationCostControl"], value: number | null) => void }) {
    return (
        <div className={settingsPanelSurfaceClass}>
            <SectionTitle icon={<CircleGauge className="size-4" />} title="生成成本保护" />
            <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
                <LabeledControl label="单任务积分上限">
                    <InputNumber className="w-full" min={0} precision={2} value={settings.generationCostControl.maxPointsPerTask} onChange={(value) => onChange("maxPointsPerTask", value)} />
                </LabeledControl>
                <LabeledControl label="单用户每日积分上限">
                    <InputNumber className="w-full" min={0} precision={2} value={settings.generationCostControl.dailyUserPointSpend} onChange={(value) => onChange("dailyUserPointSpend", value)} />
                </LabeledControl>
                <LabeledControl label="全站每日积分上限">
                    <InputNumber className="w-full" min={0} precision={2} value={settings.generationCostControl.dailyTotalPointSpend} onChange={(value) => onChange("dailyTotalPointSpend", value)} />
                </LabeledControl>
            </div>
        </div>
    );
}

export function localAgentReadiness(settings: AuthSettings): AgentReadiness {
    const models = { text: settings.defaultModels.textModel, image: settings.defaultModels.imageModel, video: settings.defaultModels.videoModel, audio: settings.defaultModels.audioModel } as const;
    const capabilities = Object.entries(models).map(([type, model]) => {
        const capability = type as keyof typeof models;
        const resolved = resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, capability, model);
        return { type: capability, model, ready: Boolean(model && resolved), message: !model ? "未设置默认模型" : !resolved ? "默认模型没有可用渠道绑定" : "使用渠道：" + resolved.channel.name };
    });
    const skills = { image: 0, video: 0, canvas: 0, drama: 0 };
    for (const skill of settings.agentSkills) if (skill.enabled) for (const workspace of skill.workspaces || ["image"]) skills[workspace] += 1;
    return { ready: capabilities.every((item) => item.ready), capabilities, skills };
}

export function GenerationDefaultsPanel({ settings, onChange }: { settings: AuthSettings; onChange: <K extends keyof AuthSettings["generationDefaults"]>(key: K, value: AuthSettings["generationDefaults"][K]) => void }) {
    const videoAnalysisModels = settings.logicalModels
        .filter((model) => {
            if (model.capability !== "text") return false;
            const resolved = resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "text", model.id);
            if (!resolved) return false;
            const profile = resolveLogicalModelCapabilityProfile(resolved.binding, "text", resolved.channel, resolved.binding.upstreamModel);
            return profile?.supportsReferenceImage === true || profile?.supportsReferenceVideo === true;
        })
        .map((model) => ({ value: model.id, label: model.name }));
    return (
        <div className={settingsPanelSurfaceClass}>
            <SectionTitle icon={<SlidersHorizontal className="size-4" />} title="生成默认值" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <LabeledControl label="画布默认生图张数">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationDefaults.canvasImageCount} onChange={(value) => onChange("canvasImageCount", value || 1)} />
                </LabeledControl>
                <LabeledControl label="Agent 默认生图张数">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationDefaults.imageCount} onChange={(value) => onChange("imageCount", value || 1)} />
                </LabeledControl>
                <LabeledControl label="工作台单次最多生成张数">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationDefaults.imageMaxCount} onChange={(value) => onChange("imageMaxCount", value || 1)} />
                </LabeledControl>
                <LabeledControl label="默认图片/视频比例">
                    <Select
                        className="w-full"
                        value={settings.generationDefaults.imageSize}
                        options={["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"].map((value) => ({ value, label: value }))}
                        onChange={(value) => onChange("imageSize", value)}
                    />
                </LabeledControl>
                <LabeledControl label="默认图片质量">
                    <Select
                        className="w-full"
                        value={settings.generationDefaults.imageQuality}
                        options={[
                            { value: "auto", label: "自动" },
                            { value: "low", label: "低清" },
                            { value: "medium", label: "中等" },
                            { value: "high", label: "高清" },
                        ]}
                        onChange={(value) => onChange("imageQuality", value)}
                    />
                </LabeledControl>
                <LabeledControl label="默认视频清晰度">
                    <AutoComplete
                        className="w-full"
                        value={settings.generationDefaults.videoQuality}
                        options={["480", "720", "1080"].map((value) => ({ value, label: value + "p" }))}
                        placeholder="例如 720、1440 或 2K"
                        onChange={(value) => onChange("videoQuality", value)}
                    />
                </LabeledControl>
                <LabeledControl label="默认视频秒数">
                    <InputNumber className="w-full" min={-1} precision={0} placeholder="-1 表示智能" value={settings.generationDefaults.videoSeconds} onChange={(value) => onChange("videoSeconds", value ?? 5)} />
                </LabeledControl>
                <LabeledControl label="视频分析模型">
                    <Select
                        className="w-full"
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        value={settings.generationDefaults.videoAnalysisModel || undefined}
                        placeholder="选择文本逻辑模型"
                        options={videoAnalysisModels}
                        onChange={(value: string | undefined) => onChange("videoAnalysisModel", value || "")}
                    />
                </LabeledControl>
                <LabeledControl label="默认音频音色">
                    <Input value={settings.generationDefaults.audioVoice} onChange={(event) => onChange("audioVoice", event.target.value)} />
                </LabeledControl>
                <LabeledControl label="默认音频格式">
                    <Select className="w-full" value={settings.generationDefaults.audioFormat} options={["mp3", "wav", "opus", "aac", "flac"].map((value) => ({ value, label: value.toUpperCase() }))} onChange={(value) => onChange("audioFormat", value)} />
                </LabeledControl>
                <LabeledControl label="生成媒体下载出网方式">
                    <Select
                        className="w-full"
                        value={settings.generationDefaults.mediaDownloadEgress || "server-proxy"}
                        options={[
                            { value: "server-proxy", label: "跟随服务器代理（默认）" },
                            { value: "direct", label: "强制直连（不占代理流量）" },
                        ]}
                        onChange={(value) => onChange("mediaDownloadEgress", value)}
                    />
                </LabeledControl>
            </div>
            <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                新建画布生图节点和配置节点默认使用；视频分析模型从可用的文本逻辑模型中选择。生成媒体下载出网方式控制把上游生成的图片/视频下载回服务器时是否走代理：选择「强制直连」可避免下载占用代理流量，但若上游地址仅能通过代理访问会下载失败。
            </div>
        </div>
    );
}

const promptRuleLabels: Record<GenerationPromptRuleKey, { title: string; description: string }> = {
    imageReference: { title: "图片参考素材约束", description: "有参考图时追加，适用于画布、工作台、Agent 与短剧。变量：{{referenceLabels}}、{{referenceLabelsZh}}。" },
    sub2ApiImageReference: { title: "Sub2API 图片编辑约束", description: "Sub2API 图片编辑使用此项替代通用参考图约束。变量：{{referenceField}}。" },
    panorama: { title: "全景节点输出约束", description: "仅全景节点追加。变量：{{referenceDirection}}，根据有无参考图填入环境补全说明。关闭后由原始提示词决定输出。" },
    videoReference: { title: "视频参考素材约束", description: "普通参考图或参考视频追加。变量：{{referenceSource}}。" },
    videoFirstFrame: { title: "视频首帧约束", description: "显式选择首帧时追加；关闭不影响真实首帧素材提交。" },
    videoFirstLastFrame: { title: "视频首尾帧约束", description: "显式选择尾帧时追加；关闭不影响真实首尾帧素材提交与角色校验。" },
    minimaxH3Base: { title: "MiniMax H3 文生 / 首尾帧包装", description: "H3 专用格式模板。变量：{{prompt}}、{{frameAlignment}}、{{referenceBindings}}。关闭后直接提交原提示词；首尾帧素材仍正常绑定。" },
    minimaxH3Reference: { title: "MiniMax H3 多模态参考包装", description: "变量：{{prompt}}、{{referenceDefinitions}}、{{retentionAnalysis}}、{{durationDirection}}。可改写或移除保持素材的规则。" },
    minimaxH3Bindings: { title: "MiniMax H3 素材绑定说明", description: "基础模板与已有结构化提示词的绑定说明。变量：{{referenceDefinitions}}。关闭不改变真实素材与标签的绑定。" },
    image: { title: "图片通用优化规则", description: "所有生图请求的前置文本，与参考图规则独立。" },
    video: { title: "视频通用优化规则", description: "所有视频生成请求的前置文本，与参考素材规则独立。" },
    text: { title: "文本通用优化规则", description: "文本节点任务的系统指令；不修改用户原文。" },
    audio: { title: "音频通用优化规则", description: "写入音频渠道的 instructions（需上游支持），不拼入待朗读正文或歌词。" },
};

export function GenerationPromptRulesPanel({ settings, onChange }: { settings: AuthSettings; onChange: <K extends keyof AuthSettings["generationDefaults"]>(key: K, value: AuthSettings["generationDefaults"][K]) => void }) {
    const rules = normalizeGenerationPromptRules(settings.generationDefaults.promptRules);
    const update = (key: GenerationPromptRuleKey, patch: Partial<(typeof rules)[GenerationPromptRuleKey]>) => onChange("promptRules", { ...rules, [key]: { ...rules[key], ...patch } });
    return (
        <div className={settingsPanelSurfaceClass}>
            <SectionTitle icon={<Sparkles className="size-4" />} title="生成提示词优化规则" />
            <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">开启时应用配置内容，关闭或清空时不应用。H3 模板中的 {"{{prompt}}"} 表示用户请求，遗漏时仍会保留原文。保存后新提交的任务生效，已提交任务保留原执行规则。此处控制固定文本，不影响默认模型规划、用户主动选择的 Skill、相机和运镜参数。</p>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {(Object.keys(promptRuleLabels) as GenerationPromptRuleKey[]).map((key) => (
                    <div key={key} className="min-w-0 space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" data-prompt-rule={key}>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium">{promptRuleLabels[key].title}</span>
                            <Switch aria-label={`${promptRuleLabels[key].title}开关`} checked={rules[key].enabled} onChange={(enabled) => update(key, { enabled })} />
                        </div>
                        <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">{promptRuleLabels[key].description}</p>
                        <Input.TextArea aria-label={`${promptRuleLabels[key].title}内容`} value={rules[key].content} rows={4} placeholder="填写需要追加的优化内容；留空不追加" onChange={(event) => update(key, { content: event.target.value })} />
                    </div>
                ))}
            </div>
        </div>
    );
}

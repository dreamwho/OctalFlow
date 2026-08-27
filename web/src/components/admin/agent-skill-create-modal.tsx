"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Form, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Upload } from "antd";
import { Download, FileArchive, GitBranch, PencilLine, UploadCloud } from "lucide-react";
import { nanoid } from "nanoid";

import { AGENT_SKILL_ARCHIVE_MAX_BYTES } from "@/lib/agent-skill-import-types";
import type { AgentSkill } from "@/lib/auth/store-types";
import {
    importAgentSkillFromGithub,
    importAgentSkillFromFile,
    type AgentSkillImportCandidate,
    type ImportedAgentSkill,
} from "@/services/api/admin-agent-skills";

type AgentSkillCreateModalProps = {
    open: boolean;
    existingSkills: AgentSkill[];
    onClose: () => void;
    onCreate: (skill: AgentSkill) => Promise<boolean>;
};

type SkillFormValues = {
    name: string;
    description: string;
    instructions: string;
    keywords: string;
    workspaces: AgentSkill["workspaces"];
    action: AgentSkill["action"];
    requiresReference: boolean;
    size: string;
    quality: string;
    count: number;
    videoSeconds: number;
};

const workspaceOptions = [
    { value: "image", label: "图片创作" },
    { value: "video", label: "视频创作" },
    { value: "canvas", label: "画布" },
    { value: "drama", label: "短剧项目" },
];

export function AgentSkillCreateModal({ open, existingSkills, onClose, onCreate }: AgentSkillCreateModalProps) {
    const [form] = Form.useForm<SkillFormValues>();
    const [mode, setMode] = useState<"file" | "github" | "manual">("file");
    const [sourceUrl, setSourceUrl] = useState("");
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [candidates, setCandidates] = useState<AgentSkillImportCandidate[]>([]);
    const [selectedPath, setSelectedPath] = useState("");
    const [importedSkill, setImportedSkill] = useState<ImportedAgentSkill>();
    const [importError, setImportError] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        setMode("file");
        setSourceUrl("");
        setSelectedFile(null);
        setCandidates([]);
        setSelectedPath("");
        setImportedSkill(undefined);
        setImportError("");
        form.setFieldsValue({
            name: "",
            description: "",
            instructions: "",
            keywords: "",
            workspaces: ["image"],
            action: "generate",
            requiresReference: false,
            size: "",
            quality: "",
            count: 1,
            videoSeconds: 5,
        });
    }, [form, open]);

    const extractFromGithub = async () => {
        if (!sourceUrl.trim()) {
            setImportError("请输入公开 GitHub 地址");
            return;
        }
        setImportError("");
        setLoading(true);
        try {
            const result = await importAgentSkillFromGithub({ url: sourceUrl.trim(), path: selectedPath || undefined });
            setCandidates(result.candidates);
            if (result.candidates.length) {
                setSelectedPath(result.candidates[0].path);
                setImportedSkill(undefined);
                return;
            }
            if (result.skill) {
                setImportedSkill(result.skill);
                form.setFieldsValue(valuesFromSkill(result.skill));
            }
        } catch (error) {
            setImportError(error instanceof Error ? error.message : "提取 GitHub Skill 失败");
        } finally {
            setLoading(false);
        }
    };

    const extractFromFile = async (pathOverride?: string) => {
        if (!selectedFile) {
            setImportError("请选择要上传的技能压缩包或 Markdown 文件");
            return;
        }
        setImportError("");
        setLoading(true);
        try {
            const result = await importAgentSkillFromFile({
                file: selectedFile,
                path: pathOverride || selectedPath || undefined,
            });
            setCandidates(result.candidates);
            if (result.candidates.length && !result.skill) {
                setSelectedPath(result.candidates[0].path);
                setImportedSkill(undefined);
                return;
            }
            if (result.skill) {
                setImportedSkill(result.skill);
                form.setFieldsValue(valuesFromSkill(result.skill));
            }
        } catch (error) {
            setImportError(error instanceof Error ? error.message : "解析本地压缩包 Skill 失败");
        } finally {
            setLoading(false);
        }
    };

    const submit = async (values: SkillFormValues) => {
        const idBase = importedSkill?.id || `skill-${nanoid(8)}`;
        const id = uniqueId(idBase, existingSkills);
        const defaultConfig: AgentSkill["defaultConfig"] = {};
        if (values.size.trim()) defaultConfig.size = values.size.trim();
        if (values.quality.trim()) defaultConfig[values.workspaces?.includes("video") ? "vquality" : "quality"] = values.quality.trim();
        if (values.workspaces?.includes("image")) defaultConfig.count = Math.max(1, Number(values.count) || 1);
        if (values.workspaces?.includes("video")) defaultConfig.videoSeconds = Math.max(1, Number(values.videoSeconds) || 5);
        setLoading(true);
        try {
            const saved = await onCreate({
                id,
                name: values.name.trim(),
                description: values.description.trim(),
                plannerSummary: importedSkill?.plannerSummary || values.description.trim(),
                instructions: values.instructions.trim(),
                enabled: importedSkill ? false : true,
                keywords: values.keywords
                    .split(/[、,，\n]/)
                    .map((item) => item.trim())
                    .filter(Boolean),
                workspaces: values.workspaces?.length ? values.workspaces : ["image"],
                action: values.action || "generate",
                requiresReference: Boolean(values.requiresReference),
                defaultConfig,
                sourceUrl: importedSkill?.sourceUrl,
                sourceRepository: importedSkill?.repository,
                sourcePath: importedSkill?.sourcePath,
                sourceVersion: importedSkill?.sourceVersion,
                sourceCommit: importedSkill?.sourceCommit,
                sourceContentHash: importedSkill?.sourceContentHash,
                license: importedSkill?.license,
            });
            if (saved) form.resetFields();
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal
            title="新增 Agent Skill"
            open={open}
            centered
            width={760}
            destroyOnHidden
            okText="添加并保存"
            cancelText="取消"
            confirmLoading={loading}
            keyboard={!loading}
            onCancel={onClose}
            onOk={() => form.submit()}
            mask={{ closable: !loading }}
            styles={{ body: { maxHeight: "min(72dvh, 720px)", overflowY: "auto", paddingTop: 8 } }}
        >
            <div className="space-y-4">
                <Segmented
                    block
                    aria-label="Skill 创建方式"
                    value={mode}
                    options={[
                        {
                            value: "file",
                            label: (
                                <span className="inline-flex items-center justify-center gap-2">
                                    <FileArchive className="size-4" aria-hidden />
                                    本地文件
                                </span>
                            ),
                        },
                        {
                            value: "github",
                            label: (
                                <span className="inline-flex items-center justify-center gap-2">
                                    <GitBranch className="size-4" aria-hidden />
                                    GitHub
                                </span>
                            ),
                        },
                        {
                            value: "manual",
                            label: (
                                <span className="inline-flex items-center justify-center gap-2">
                                    <PencilLine className="size-4" aria-hidden />
                                    手动创建
                                </span>
                            ),
                        },
                    ]}
                    onChange={(value) => setMode(value as "file" | "github" | "manual")}
                />

                {mode === "file" ? (
                    <div className="space-y-3 rounded-lg border border-purple-200 bg-purple-50/60 p-4 dark:border-purple-900/70 dark:bg-purple-950/20">
                        <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">上传本地 Skill 压缩包 (.zip / .rar / .md)</div>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <Upload
                                accept=".zip,.rar,.md,.markdown,application/zip,application/vnd.rar,text/markdown"
                                beforeUpload={(file) => {
                                    const extension = file.name.split(".").at(-1)?.toLowerCase() || "";
                                    if (!["zip", "rar", "md", "markdown"].includes(extension)) {
                                        setImportError("只支持 .zip、.rar、.md 或 .markdown Skill 文件");
                                        return Upload.LIST_IGNORE;
                                    }
                                    if (file.size > AGENT_SKILL_ARCHIVE_MAX_BYTES) {
                                        setImportError(`Skill 文件不能超过 ${Math.floor(AGENT_SKILL_ARCHIVE_MAX_BYTES / 1024 / 1024)}MB`);
                                        return Upload.LIST_IGNORE;
                                    }
                                    setSelectedFile(file);
                                    setImportError("");
                                    setCandidates([]);
                                    setSelectedPath("");
                                    setImportedSkill(undefined);
                                    return false;
                                }}
                                maxCount={1}
                                showUploadList={{ showRemoveIcon: true }}
                                onRemove={() => {
                                    setSelectedFile(null);
                                    setCandidates([]);
                                    setSelectedPath("");
                                    setImportedSkill(undefined);
                                }}
                            >
                                <Button icon={<UploadCloud className="size-4" />}>选择压缩包或文件</Button>
                            </Upload>
                            <Button
                                type="primary"
                                icon={<Download className="size-4" />}
                                loading={loading}
                                disabled={!selectedFile}
                                onClick={() => void extractFromFile()}
                            >
                                解析并导入
                            </Button>
                        </div>
                        {importError ? <Alert type="error" showIcon message={importError} /> : null}
                        {candidates.length ? (
                            <div className="space-y-2">
                                <div className="text-xs text-stone-600 dark:text-stone-300">
                                    压缩包中发现 {candidates.length} 个候选文件，请选择一个并提取：
                                </div>
                                <Select
                                    className="w-full"
                                    value={selectedPath}
                                    options={candidates.map((item) => ({ value: item.path, label: `${item.name} · ${item.path}` }))}
                                    onChange={setSelectedPath}
                                />
                                <Button
                                    icon={<Download className="size-4" />}
                                    loading={loading}
                                    onClick={() => void extractFromFile(selectedPath)}
                                >
                                    读取选中的 Skill
                                </Button>
                            </div>
                        ) : null}
                        {importedSkill ? (
                            <Alert
                                type="success"
                                showIcon
                                message={<span>AI 解析完成：{importedSkill.name}</span>}
                                description={
                                    <span className="break-all">
                                        来源：{importedSkill.sourcePath}
                                        {importedSkill.license ? ` · ${importedSkill.license}` : ""}
                                    </span>
                                }
                            />
                        ) : (
                            <div className="text-xs leading-5 text-stone-600 dark:text-stone-400">
                                只读取 SKILL.md 及同目录参考文档，不执行压缩包内脚本；解析后可继续编辑名称和规则。
                            </div>
                        )}
                    </div>
                ) : null}

                {mode === "github" ? (
                    <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900/70 dark:bg-blue-950/20">
                        <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">公开 Skill 地址</div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                                name="sourceUrl"
                                value={sourceUrl}
                                prefix={<GitBranch className="size-4 text-stone-400" />}
                                placeholder="https://github.com/owner/repo 或 .../SKILL.md"
                                onChange={(event) => {
                                    setSourceUrl(event.target.value);
                                    setImportError("");
                                    setCandidates([]);
                                    setSelectedPath("");
                                    setImportedSkill(undefined);
                                }}
                            />
                            <Button type="primary" icon={<Download className="size-4" />} loading={loading} onClick={() => void extractFromGithub()}>
                                提取
                            </Button>
                        </div>
                        {importError ? <Alert type="error" showIcon message={importError} /> : null}
                        {candidates.length ? (
                            <div className="space-y-2">
                                <div className="text-xs text-stone-600 dark:text-stone-300">发现 {candidates.length} 个 SKILL.md，请选择一个后读取。</div>
                                <Select className="w-full" value={selectedPath} options={candidates.map((item) => ({ value: item.path, label: `${item.name} · ${item.path}` }))} onChange={setSelectedPath} />
                                <Button icon={<Download className="size-4" />} loading={loading} onClick={() => void extractFromGithub()}>
                                    读取选中的 Skill
                                </Button>
                            </div>
                        ) : null}
                        {importedSkill ? (
                            <Alert
                                type="success"
                                showIcon
                                message={<span>AI 提取完成：{importedSkill.name}</span>}
                                description={
                                    <span className="break-all">
                                        {importedSkill.sourcePath}
                                        {importedSkill.license ? ` · ${importedSkill.license}` : ""} · 导入后默认停用
                                    </span>
                                }
                            />
                        ) : (
                            <div className="text-xs leading-5 text-stone-600 dark:text-stone-400">读取公开仓库中的 SKILL.md 后，由后台默认文本模型整理为中文原生规则；不会执行仓库代码，整理后仍可编辑确认。</div>
                        )}
                    </div>
                ) : null}

                <Form form={form} layout="vertical" requiredMark={false} onFinish={submit}>
                    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                        <Form.Item label="Skill 名称（可编辑）" name="name" rules={[{ required: true, message: "请输入 Skill 名称" }]}>
                            <Input placeholder="例如：电商海报策划" />
                        </Form.Item>
                        <Form.Item label="触发关键词" name="keywords">
                            <Input placeholder="用逗号分隔，例如：海报, 电商" />
                        </Form.Item>
                    </div>
                    <Form.Item label="用途说明" name="description">
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={240} placeholder="说明这个 Skill 适合处理什么任务" />
                    </Form.Item>
                    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                        <Form.Item label="适用工作区" name="workspaces" rules={[{ required: true, message: "请选择工作区" }]}>
                            <Select mode="multiple" options={workspaceOptions} placeholder="选择工作区" />
                        </Form.Item>
                        <Form.Item label="执行方式" name="action">
                            <Select
                                options={[
                                    { value: "generate", label: "生成" },
                                    { value: "edit", label: "编辑" },
                                ]}
                            />
                        </Form.Item>
                    </div>
                    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                        <Form.Item label="默认比例" name="size">
                            <Input placeholder="例如 1:1 或 16:9" />
                        </Form.Item>
                        <Form.Item label="默认质量" name="quality">
                            <Input placeholder="例如 high / 1080" />
                        </Form.Item>
                    </div>
                    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                        <Form.Item label="默认图片数量" name="count">
                            <InputNumber className="w-full" min={1} max={10} />
                        </Form.Item>
                        <Form.Item label="默认视频时长（秒）" name="videoSeconds">
                            <InputNumber className="w-full" min={1} max={60} />
                        </Form.Item>
                    </div>
                    <Form.Item label="执行规则" name="instructions" rules={[{ required: true, message: "请输入执行规则" }]}>
                        <Input.TextArea autoSize={{ minRows: 8, maxRows: 18 }} maxLength={8000} placeholder="写明 Agent 应如何规划与执行任务" />
                    </Form.Item>
                    <Form.Item name="requiresReference" valuePropName="checked" className="mb-0">
                        <Space>
                            <Switch size="small" />
                            <span className="text-sm text-stone-700 dark:text-stone-300">必须使用参考素材</span>
                        </Space>
                    </Form.Item>
                </Form>
                {importedSkill?.sourceUrl ? (
                    <a href={importedSkill.sourceUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 break-all text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
                        <GitBranch className="size-3.5 shrink-0" />
                        {importedSkill.sourceUrl}
                    </a>
                ) : null}
            </div>
        </Modal>
    );
}

function valuesFromSkill(skill: ImportedAgentSkill): SkillFormValues {
    return {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        keywords: skill.keywords.join("、"),
        workspaces: skill.workspaces || ["image"],
        action: skill.action || "generate",
        requiresReference: Boolean(skill.requiresReference),
        size: String(skill.defaultConfig?.size || ""),
        quality: String(skill.defaultConfig?.quality || skill.defaultConfig?.vquality || ""),
        count: Number(skill.defaultConfig?.count || 1),
        videoSeconds: Number(skill.defaultConfig?.videoSeconds || 5),
    };
}

function uniqueId(base: string, skills: AgentSkill[]) {
    const ids = new Set(skills.map((skill) => skill.id));
    if (!ids.has(base)) return base;
    let index = 2;
    while (ids.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
}

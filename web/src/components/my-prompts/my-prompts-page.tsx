"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Copy, FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";

import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCopyText } from "@/hooks/use-copy-text";
import { createMyPrompt, deleteMyPrompt, listMyPrompts, updateMyPrompt } from "@/services/api/my-prompts";
import type { Prompt } from "@/services/api/prompts";
import { PromptImageInput, promptCoverFileError } from "./prompt-image-input";

const PAGE_SIZE = 8;

type PromptFormValue = {
    title: string;
    prompt: string;
    category?: string;
    tags?: string;
    coverUrl?: string;
    preview?: string;
};

export function MyPromptsPage() {
    const { message } = App.useApp();
    const [form] = Form.useForm<PromptFormValue>();
    const [items, setItems] = useState<Prompt[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [deletingId, setDeletingId] = useState("");
    const [modalOpen, setModalOpen] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const copyText = useCopyText();
    const addAsset = useAssetStore((state) => state.addAsset);
    const coverUrl = Form.useWatch("coverUrl", form) || "";

    const loadPrompts = useCallback(
        async (targetPage: number) => {
            setLoading(true);
            try {
                const payload = await listMyPrompts({ page: targetPage, pageSize: PAGE_SIZE });
                setItems(payload.items);
                setTotal(payload.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "获取我的提示词失败");
            } finally {
                setLoading(false);
            }
        },
        [message],
    );

    useEffect(() => {
        void loadPrompts(page);
    }, [loadPrompts, page]);

    const savePrompt = async (value: PromptFormValue) => {
        setSubmitting(true);
        try {
            const input = { ...value, tags: splitTags(value.tags) };
            if (editingPrompt) {
                await updateMyPrompt(editingPrompt.id, input, coverFile);
                message.success("提示词已更新");
                await loadPrompts(page);
            } else {
                await createMyPrompt(input, coverFile);
                message.success("提示词已保存");
                if (page === 1) await loadPrompts(1);
                else setPage(1);
            }
            setModalOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : editingPrompt ? "更新提示词失败" : "新增提示词失败");
        } finally {
            setSubmitting(false);
        }
    };

    const openCreate = () => {
        setEditingPrompt(null);
        setCoverFile(null);
        form.resetFields();
        setModalOpen(true);
    };

    const openEdit = (item: Prompt) => {
        setEditingPrompt(item);
        setCoverFile(null);
        form.setFieldsValue({ ...item, tags: item.tags.join(", ") });
        setModalOpen(true);
    };

    const closeModal = () => {
        if (submitting) return;
        setModalOpen(false);
    };

    const selectCover = (file: File) => {
        const error = promptCoverFileError(file);
        if (error) return void message.warning(error);
        setCoverFile(file);
        form.setFieldValue("coverUrl", "");
    };

    const deletePrompt = async (id: string) => {
        setDeletingId(id);
        try {
            await deleteMyPrompt(id);
            message.success("提示词已删除");
            const targetPage = Math.min(page, Math.max(1, Math.ceil(Math.max(0, total - 1) / PAGE_SIZE)));
            if (targetPage === page) await loadPrompts(targetPage);
            else setPage(targetPage);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除提示词失败");
        } finally {
            setDeletingId("");
        }
    };

    const savePromptAsset = async (item: Prompt) => {
        try {
            await addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "my-prompts", promptId: item.id } });
            message.success("已加入我的素材");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材保存失败");
        }
    };

    const columns: TableColumnsType<Prompt> = [
        {
            title: "标题",
            dataIndex: "title",
            render: (_, record) => (
                <div className="flex min-w-0 gap-3">
                    {record.coverUrl ? <img src={imagePreviewUrl(record.coverUrl, 320)} alt={record.title} className="h-14 w-20 shrink-0 rounded-md border border-border object-cover" loading="lazy" /> : null}
                    <div className="min-w-0">
                        <div className="font-medium text-stone-950 dark:text-stone-100">{record.title}</div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{record.prompt}</div>
                        <div className="mt-2 flex flex-wrap gap-1">
                            {record.tags.map((tag) => (
                                <Tag key={tag} className="m-0 text-[11px]">
                                    {tag}
                                </Tag>
                            ))}
                        </div>
                    </div>
                </div>
            ),
        },
        {
            title: "分类",
            dataIndex: "category",
            width: 120,
            responsive: ["md"],
        },
        {
            title: "操作",
            width: 230,
            render: (_, record) => (
                <Space wrap size="small">
                    <Button size="small" aria-label={`编辑提示词 ${record.title}`} icon={<Pencil className="size-3.5" />} onClick={() => openEdit(record)}>
                        编辑
                    </Button>
                    <Button size="small" aria-label="复制提示词" icon={<Copy className="size-3.5" />} onClick={() => copyText(record.prompt, "提示词已复制")}>
                        <span className="hidden sm:inline">复制</span>
                    </Button>
                    <Button size="small" aria-label="加入我的素材" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(record)}>
                        <span className="hidden sm:inline">素材</span>
                    </Button>
                    <Popconfirm title="删除提示词？" okText="删除" cancelText="取消" onConfirm={() => deletePrompt(record.id)}>
                        <Button size="small" danger aria-label="删除提示词" loading={deletingId === record.id} icon={<Trash2 className="size-3.5" />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6 sm:py-8">
                <div className="mx-auto max-w-7xl space-y-3 sm:space-y-6">
                    <div className="flex flex-row items-center justify-between gap-3 sm:items-end sm:gap-4">
                        <div>
                            <h1 className="text-xl font-semibold text-stone-950 sm:text-2xl dark:text-stone-100">我的提示词</h1>
                            <p className="mt-1.5 text-xs leading-5 text-stone-500 sm:mt-2 sm:text-sm dark:text-stone-400">保存自己的提示词记录，复制使用或沉淀到我的素材。</p>
                        </div>
                        <Button type="primary" size="small" className="shrink-0 sm:!h-9" icon={<Plus className="size-3.5 sm:size-4" />} onClick={openCreate}>
                            添加提示词
                        </Button>
                    </div>

                    <section className="overflow-hidden rounded-lg border border-border bg-card">
                        <div className="border-b border-border px-3 py-2.5 sm:px-5 sm:py-4">
                            <h2 className="text-base font-semibold text-stone-950 sm:text-lg dark:text-stone-100">我的记录</h2>
                        </div>
                        <Table
                            className="[&_.ant-table-tbody>tr>td]:!py-2 sm:[&_.ant-table-tbody>tr>td]:!py-3 [&_.ant-table-thead>tr>th]:!py-2"
                            rowKey="id"
                            loading={loading}
                            columns={columns}
                            dataSource={items}
                            tableLayout="fixed"
                            pagination={{ current: page, pageSize: PAGE_SIZE, total, hideOnSinglePage: true, showSizeChanger: false, onChange: setPage }}
                            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有保存提示词" /> }}
                        />
                    </section>
                </div>
            </main>
            <Modal
                title={editingPrompt ? "编辑提示词" : "添加提示词"}
                open={modalOpen}
                footer={null}
                centered
                width={720}
                destroyOnHidden
                mask={{ closable: !submitting }}
                keyboard={!submitting}
                onCancel={closeModal}
                afterClose={() => {
                    form.resetFields();
                    setEditingPrompt(null);
                    setCoverFile(null);
                }}
            >
                <Form
                    form={form}
                    layout="vertical"
                    onFinish={savePrompt}
                    requiredMark={false}
                    className="pt-3"
                    onPaste={(event) => {
                        const files = clipboardImageFiles(event.clipboardData);
                        if (!files.length) return;
                        event.preventDefault();
                        selectCover(files[0]);
                    }}
                >
                    <Form.Item label="封面图片">
                        <PromptImageInput
                            file={coverFile}
                            currentUrl={coverUrl}
                            onChange={selectCover}
                            onRemove={() => {
                                setCoverFile(null);
                                form.setFieldValue("coverUrl", "");
                            }}
                        />
                    </Form.Item>
                    <div className="grid gap-x-4 sm:grid-cols-2">
                        <Form.Item label="标题" name="title" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input placeholder="例如：产品摄影主视觉" />
                        </Form.Item>
                        <Form.Item label="分类" name="category">
                            <Input placeholder="例如：商业海报" />
                        </Form.Item>
                        <Form.Item label="标签" name="tags">
                            <Input placeholder="用逗号分隔，例如：摄影, 电商, 写实" />
                        </Form.Item>
                        <Form.Item label="图片 URL（可选）" name="coverUrl" extra="也可以粘贴已有图片地址；本地图片优先。">
                            <Input placeholder="https://example.com/image.png" onChange={() => coverFile && setCoverFile(null)} />
                        </Form.Item>
                    </div>
                    <Form.Item label="提示词内容" name="prompt" rules={[{ required: true, message: "请输入提示词内容" }]}>
                        <Input.TextArea rows={5} placeholder="输入完整提示词..." />
                    </Form.Item>
                    <Form.Item label="备注 / 预览" name="preview">
                        <Input.TextArea rows={2} placeholder="可选，记录使用场景、参考图说明或效果备注" />
                    </Form.Item>
                    <div className="flex justify-end gap-3">
                        <Button disabled={submitting} onClick={closeModal}>
                            取消
                        </Button>
                        <Button type="primary" htmlType="submit" loading={submitting} icon={editingPrompt ? <Pencil className="size-4" /> : <Plus className="size-4" />}>
                            {editingPrompt ? "保存修改" : "保存提示词"}
                        </Button>
                    </div>
                </Form>
            </Modal>
        </div>
    );
}

function splitTags(value?: string) {
    return (value || "")
        .split(/[,，\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean);
}

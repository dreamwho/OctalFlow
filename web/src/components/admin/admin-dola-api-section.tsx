"use client";

import { Alert, App, Button, Card, Descriptions, Empty, Input, Modal, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Upload } from "antd";
import type { UploadProps } from "antd";
import { Activity, Bot, CheckCircle2, FileKey2, KeyRound, Play, RefreshCw, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createDolaApiKey, deleteDolaAccount, getDolaAdminState, getDolaTestTask, importDolaAccounts, refreshDolaAccount, testDolaVideo, updateDolaAccount, updateDolaGateway, type DolaAdminState, type DolaApiKey, type DolaAccount, type DolaTestResult } from "@/services/api/dola";
import { DolaVerificationDialog } from "@/app/(user)/canvas/components/dola-verification-dialog";
import { MagicProxyBindingCard } from "@/components/admin/magic-proxy-binding-card";
import { DolaRequestLogPanel } from "@/components/admin/dola-request-log-panel";

type DolaTab = "accounts" | "statistics" | "gateway" | "logs" | "proxy";

export function AdminDolaApiSection() {
    const { message } = App.useApp();
    const [state, setState] = useState<DolaAdminState | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [activeTab, setActiveTab] = useState<DolaTab>("accounts");
    const [importOpen, setImportOpen] = useState(false);
    const [importItems, setImportItems] = useState<Array<{ cookie: string; sourceFileName: string; sourceOrdinal: number }>>([]);
    const [pastedCookies, setPastedCookies] = useState("");
    const [importing, setImporting] = useState(false);
    const [testOpen, setTestOpen] = useState(false);
    const [testModel, setTestModel] = useState("dola-seedance-2-5");
    const [testDuration, setTestDuration] = useState(5);
    const [testRatio, setTestRatio] = useState("16:9");
    const [testPrompt, setTestPrompt] = useState("让参考图中的主体自然移动，保持主体外观和构图稳定。");
    const [testReference, setTestReference] = useState<{ dataUrl: string; name: string; mime: string } | null>(null);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<DolaTestResult | null>(null);
    const [queryingTest, setQueryingTest] = useState(false);
    const [testVerification, setTestVerification] = useState<{ taskId: string; verificationId: string } | null>(null);
    const [rawKey, setRawKey] = useState("");
    const [keyOpen, setKeyOpen] = useState(false);
    const [keyName, setKeyName] = useState("Dola 外部调用");

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try { setState(await getDolaAdminState()); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 Dola API 配置"); } finally { setLoading(false); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const selectedModel = useMemo(() => state?.models.find((model) => model.id === testModel) || state?.models[0], [state?.models, testModel]);
    useEffect(() => { if (selectedModel && !selectedModel.durations.includes(testDuration)) setTestDuration(selectedModel.durations[0] || 5); }, [selectedModel, testDuration]);

    const fileProps: UploadProps = {
        accept: ".txt,text/plain",
        multiple: true,
        showUploadList: false,
        beforeUpload: async (file) => {
            const text = await file.text();
            const items = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((cookie, index) => ({ cookie, sourceFileName: file.name, sourceOrdinal: index + 1 }));
            setImportItems((current) => [...current, ...items]);
            return false;
        },
    };

    const submitImport = async () => {
        const pastedItems = pastedCookies.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((cookie, index) => ({ cookie, sourceFileName: "粘贴内容", sourceOrdinal: index + 1 }));
        const items = [...importItems, ...pastedItems];
        if (!items.length) { message.warning("请先选择 Cookie 文本文件或粘贴 Cookie Header"); return; }
        setImporting(true);
        try {
            const result = await importDolaAccounts(items);
            message.success(`已处理 ${result.results.length} 条 Cookie`);
            setImportItems([]); setPastedCookies(""); setImportOpen(false); await load();
        } catch (reason) { message.error(reason instanceof Error ? reason.message : "Cookie 导入失败"); } finally { setImporting(false); }
    };

    const runTest = async () => {
        if (!selectedModel) return;
        setTesting(true); setTestResult(null);
        try {
            setTestResult(await testDolaVideo({ model: selectedModel.id, prompt: testPrompt, duration: testDuration, ratio: testRatio, references: testReference ? [{ dataUrl: testReference.dataUrl, role: "reference", name: testReference.name, mime: testReference.mime }] : [] }));
            message.success("测试请求已提交");
        } catch (reason) { message.error(reason instanceof Error ? reason.message : "Dola 测试失败"); } finally { setTesting(false); }
    };
    const queryTest = async () => {
        if (!testResult?.taskId) return;
        setQueryingTest(true);
        try { const next = await getDolaTestTask(testResult.taskId); setTestResult((current) => current ? { ...current, ...next } : current); } catch (reason) { message.error(reason instanceof Error ? reason.message : "查询 Dola 测试任务失败"); } finally { setQueryingTest(false); }
    };

    const toggleGateway = async (enabled: boolean) => { try { await updateDolaGateway(enabled); await load(); message.success(enabled ? "Dola 网关已启用" : "Dola 网关已停用"); } catch (reason) { message.error(reason instanceof Error ? reason.message : "保存网关设置失败"); } };
    const toggleAutoWatermark = async (enabled: boolean) => { try { await updateDolaGateway(undefined, enabled); await load(); message.success(enabled ? "已开启自动去水印" : "已关闭自动去水印"); } catch (reason) { message.error(reason instanceof Error ? reason.message : "保存自动去水印设置失败"); } };
    return <div className="space-y-4">
        {error ? <Alert type="error" showIcon message="Dola API 状态读取失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
        <Tabs activeKey={activeTab} onChange={(key) => setActiveTab(key as DolaTab)} items={[
            { key: "accounts", label: "账号与渠道" }, { key: "statistics", label: "统计报表" }, { key: "gateway", label: "反代网关与 API 密钥" }, { key: "logs", label: "请求日志" }, { key: "proxy", label: "代理管理" },
        ]} />
        {loading && !state ? <Card><Spin /> 读取 Dola API 状态…</Card> : null}
        {activeTab === "accounts" ? <AccountsPanel state={state} onRefresh={load} onImport={() => setImportOpen(true)} onTest={() => setTestOpen(true)} onMessage={(content) => message.error(content)} /> : null}
        {activeTab === "statistics" ? <StatisticsPanel state={state} /> : null}
        {activeTab === "gateway" ? <GatewayPanel state={state} onToggle={toggleGateway} onToggleAutoWatermark={toggleAutoWatermark} rawKey={rawKey} setRawKey={setRawKey} open={keyOpen} setOpen={setKeyOpen} name={keyName} setName={setKeyName} onCreated={load} /> : null}
        {activeTab === "logs" ? <DolaRequestLogPanel active models={state?.models || []} accounts={state?.accounts || []} /> : null}
        {activeTab === "proxy" ? <MagicProxyBindingCard provider="dola" /> : null}
        <Modal title="导入 Dola Cookie 账号" open={importOpen} onCancel={() => { if (!importing) { setImportOpen(false); setImportItems([]); setPastedCookies(""); } }} onOk={() => void submitImport()} okButtonProps={{ loading: importing, disabled: !importItems.length && !pastedCookies.trim() }} okText="开始导入">
            <Alert type="info" showIcon message="支持 Cookie Header 粘贴和文本文件" description="每行一个 Cookie Header；一个文件可按非空行导入多个账号，也支持同时选择多个文件。Cookie 值不会回显到列表、审计或响应。" />
            <Input.TextArea className="mt-4" rows={5} value={pastedCookies} onChange={(event) => setPastedCookies(event.target.value)} placeholder="粘贴 Cookie: name=value; other=value&#10;也可以逐行粘贴多个账号" />
            <Upload.Dragger {...fileProps} className="mt-4"><p className="ant-upload-drag-icon"><UploadCloud className="mx-auto size-8" /></p><p>选择一个或多个 .txt 文件</p><p className="text-xs text-zinc-500">已解析 {importItems.length} 条，不显示 Cookie 内容</p></Upload.Dragger>
        </Modal>
        <Modal title="Dola 视频通信测试" open={testOpen} onCancel={() => setTestOpen(false)} onOk={() => void runTest()} okButtonProps={{ loading: testing, disabled: !selectedModel }} okText="提交一次测试">
            <div className="space-y-3"><Select className="w-full" value={testModel} options={(state?.models || []).map((model) => ({ value: model.id, label: model.name }))} onChange={setTestModel} /><div className="grid grid-cols-2 gap-3"><Select value={testDuration} options={(selectedModel?.durations || []).map((value) => ({ value, label: `${value} 秒` }))} onChange={setTestDuration} /><Select value={testRatio} options={(selectedModel?.aspectRatios || []).map((value) => ({ value, label: value }))} onChange={setTestRatio} /></div><Upload accept="image/*" maxCount={1} showUploadList={false} beforeUpload={async (file) => { try { setTestReference({ dataUrl: await readFileDataUrl(file), name: file.name, mime: file.type || "image/png" }); } catch (error) { message.error(error instanceof Error ? error.message : "参考图读取失败"); } return false; }}><Button icon={<UploadCloud className="size-4" />}>{testReference ? `已选择：${testReference.name}` : "可选：上传参考图"}</Button></Upload><Input.TextArea rows={4} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} />{testResult ? <Alert type={testResult.status === "failed" ? "error" : "warning"} message={testResult.status === "failed" ? testResult.error : `状态：${testResult.status}`} description={<Space direction="vertical" size={4}><span>{testResult.taskId ? `任务：${testResult.taskId}` : "已记录 Provider 响应"}</span>{testResult.taskId ? <Space wrap><Button size="small" loading={queryingTest} onClick={() => void queryTest()}>查询状态</Button>{testResult.verificationId ? <Button size="small" type="primary" onClick={() => setTestVerification({ taskId: testResult.taskId!, verificationId: testResult.verificationId! })}>处理验证</Button> : null}</Space> : null}</Space>} /> : null}</div>
        </Modal>
        <DolaVerificationDialog request={testVerification} admin onClose={() => setTestVerification(null)} onResolved={() => { setTestVerification(null); void queryTest(); message.success("验证已完成，正在查询原测试任务"); }} />
    </div>;
}

function readFileDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("参考图读取失败"));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("参考图读取失败"));
        reader.readAsDataURL(file);
    });
}

function AccountsPanel({ state, onRefresh, onImport, onTest, onMessage }: { state: DolaAdminState | null; onRefresh: () => Promise<void>; onImport: () => void; onTest: () => void; onMessage: (content: string) => void }) {
    const accounts = state?.accounts || [];
    return <><Card title="Dola API" extra={<Space><Button icon={<RefreshCw className="size-4" />} onClick={() => void onRefresh()}>刷新</Button><Button icon={<FileKey2 className="size-4" />} onClick={onImport}>导入 Cookie</Button><Button type="primary" icon={<Play className="size-4" />} disabled={!state?.models.length} onClick={onTest}>通信测试</Button></Space>}><Descriptions size="small" column={{ xs: 1, sm: 3 }} items={[{ key: "transport", label: "提交方式", children: <Tag color="blue">Camoufox 页面会话</Tag> }, { key: "provider", label: "Provider", children: state?.healthy ? <Tag color="green">正常</Tag> : <Tag>待连接</Tag> }, { key: "proxy", label: "代理策略", children: <Tag>请在“代理管理”配置</Tag> }]} /></Card><Card title="账号池"><Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={accounts} columns={[{ title: "账号", dataIndex: "name" }, { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "ready" ? "green" : value === "disabled" ? "default" : "gold"}>{value}</Tag> }, { title: "请求", dataIndex: "requestCount" }, { title: "成功", dataIndex: "successCount" }, { title: "额度", render: (_: unknown, row: DolaAccount) => row.quota?.length ? row.quota.map((quota) => quota.remaining === null ? "未知" : `${quota.remaining}/${quota.limit ?? "—"}`).join("、") : "未知" }, { title: "操作", render: (_: unknown, row: DolaAccount) => <Space><Button size="small" onClick={() => void updateDolaAccount(row.id, { enabled: !row.enabled }).then(() => onRefresh()).catch((error) => onMessage(error instanceof Error ? error.message : "操作失败"))}>{row.enabled ? "停用" : "启用"}</Button><Button size="small" onClick={() => void refreshDolaAccount(row.id).then(() => onRefresh()).catch((error) => onMessage(error instanceof Error ? error.message : "刷新失败"))}>刷新额度</Button><Button danger size="small" onClick={() => void deleteDolaAccount(row.id).then(() => onRefresh()).catch((error) => onMessage(error instanceof Error ? error.message : "删除失败"))}>删除</Button></Space> }]} /></Card></>;
}

function StatisticsPanel({ state }: { state: DolaAdminState | null }) { const stats = state?.stats; return <div className="grid gap-4 sm:grid-cols-3"><Card><Statistic title="账号总数" value={stats?.totalAccounts || 0} prefix={<Bot className="size-4" />} /></Card><Card><Statistic title="成功请求" value={stats?.successCount || 0} prefix={<CheckCircle2 className="size-4" />} /></Card><Card><Statistic title="失败请求" value={stats?.errorCount || 0} prefix={<Activity className="size-4" />} /></Card></div>; }

function GatewayPanel({ state, onToggle, onToggleAutoWatermark, rawKey, setRawKey, open, setOpen, name, setName, onCreated }: { state: DolaAdminState | null; onToggle: (enabled: boolean) => Promise<void>; onToggleAutoWatermark: (enabled: boolean) => Promise<void>; rawKey: string; setRawKey: (value: string) => void; open: boolean; setOpen: (value: boolean) => void; name: string; setName: (value: string) => void; onCreated: () => Promise<void> }) {
    const [creating, setCreating] = useState(false);
    const [keys, setKeys] = useState<DolaApiKey[]>(state?.apiKeys || []);
    useEffect(() => setKeys(state?.apiKeys || []), [state?.apiKeys]);
    const create = async () => { setCreating(true); try { const result = await createDolaApiKey({ name }); setRawKey(result.rawKey); setOpen(false); await onCreated(); } finally { setCreating(false); } };
    return <div className="grid gap-4 xl:grid-cols-2"><Card title="反代网关" extra={<Space><span className="text-xs text-zinc-500">网关</span><Switch checked={state?.gateway.enabled} onChange={(checked) => void onToggle(checked)} /></Space>}><Alert type="info" showIcon message="外部接口前缀：/api/dola/v1" description="网关只接受 Dola API 密钥，内部 Provider 请求不复用外部密钥。" /><div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"><div><div className="text-sm font-medium">自动去水印</div><div className="text-xs text-zinc-500">Dola 返回可验证 VOD 地址时，任务保存前自动切换到无水印地址；默认关闭。</div></div><Switch checked={state?.gateway.autoWatermark} onChange={(checked) => void onToggleAutoWatermark(checked)} /></div></Card><Card title="API 密钥" extra={<Button icon={<KeyRound className="size-4" />} onClick={() => setOpen(true)}>创建密钥</Button>}>{rawKey ? <Alert className="mb-3" type="warning" message="新密钥只显示一次" description={<code className="break-all">{rawKey}</code>} /> : null}{keys.length ? keys.map((key) => <div key={key.id} className="flex items-center justify-between border-b py-2 last:border-b-0"><span>{key.name} <Tag>{key.prefix}…</Tag></span><span className="text-xs text-zinc-500">{key.requestCount} 次</span></div>) : <Empty description="尚未创建密钥" />}</Card><Modal title="创建 Dola API 密钥" open={open} onCancel={() => setOpen(false)} onOk={() => void create()} confirmLoading={creating}><Input prefix={<KeyRound className="size-4" />} value={name} onChange={(event) => setName(event.target.value)} /></Modal></div>;
}

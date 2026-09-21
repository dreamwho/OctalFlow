"use client";

import { Alert, App, Button, Card, Descriptions, Empty, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Upload } from "antd";
import type { UploadProps } from "antd";
import { Activity, Bot, CheckCircle2, Eye, FileKey2, KeyRound, Play, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { batchDeleteDolaAccounts, createDolaApiKey, deleteDolaAccount, getDolaAdminState, getDolaTestTask, importDolaAccounts, refreshDolaAccount, startDolaGoogleLogin, testDolaVideo, updateDolaAccount, updateDolaGateway, verifyDolaAccount, type DolaAdminState, type DolaApiKey, type DolaAccount, type DolaTestResult } from "@/services/api/dola";
import { dolaErrorHint } from "@/lib/dola-errors";
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
    const [testPrompt, setTestPrompt] = useState("清晨的海边，一只白色海鸟掠过波光粼粼的海面，镜头平稳跟随，画面自然流畅。");
    const [testReference, setTestReference] = useState<{ dataUrl: string; name: string; mime: string } | null>(null);
    const [testHeadless, setTestHeadless] = useState(true);
    const [testCredentialMode, setTestCredentialMode] = useState<"auto" | "account" | "custom">("auto");
    const [testAccountId, setTestAccountId] = useState("");
    const [testCustomCookie, setTestCustomCookie] = useState("");
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

    const openTestModal = (options?: { accountId?: string; model?: string; headless?: boolean }) => {
        if (options?.accountId) {
            setTestAccountId(options.accountId);
            setTestCredentialMode("account");
        } else {
            setTestCredentialMode("auto");
        }
        if (options?.model) setTestModel(options.model);
        if (options?.headless !== undefined) setTestHeadless(options.headless);
        setTestOpen(true);
    };

    const selectedModel = useMemo(() => state?.models.find((model) => model.id === testModel) || state?.models[0], [state?.models, testModel]);
    const isImageTestModel = Boolean(selectedModel?.capabilities?.includes("image"));
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
            setTestResult(await testDolaVideo({
                model: selectedModel.id,
                prompt: testPrompt,
                duration: testDuration,
                ratio: testRatio,
                references: testReference ? [{ dataUrl: testReference.dataUrl, role: "reference", name: testReference.name, mime: testReference.mime }] : [],
                headless: testHeadless,
                customCookie: testCredentialMode === "custom" ? testCustomCookie.trim() || undefined : undefined,
                accountId: testCredentialMode === "account" ? testAccountId || undefined : undefined,
            }));
            message.success(testHeadless ? "测试请求已提交 (无头模式)" : "已启动全新隔离 Camoufox 窗口并提交协议请求，请在桌面查看");
        } catch (reason) { message.error(reason instanceof Error ? reason.message : "Dola 测试失败"); } finally { setTesting(false); }
    };
    const queryTest = async () => {
        if (!testResult?.taskId) return;
        setQueryingTest(true);
        try { const next = await getDolaTestTask(testResult.taskId); setTestResult((current) => current ? { ...current, ...next } : current); } catch (reason) { message.error(reason instanceof Error ? reason.message : "查询 Dola 测试任务失败"); } finally { setQueryingTest(false); }
    };
    const testHint = testResult?.status === "failed" && testResult.error ? dolaErrorHint(testResult.error) : null;

    const toggleGateway = async (enabled: boolean) => { try { await updateDolaGateway(enabled); await load(); message.success(enabled ? "Dola 网关已启用" : "Dola 网关已停用"); } catch (reason) { message.error(reason instanceof Error ? reason.message : "保存网关设置失败"); } };
    const toggleAutoWatermark = async (enabled: boolean) => { try { await updateDolaGateway(undefined, enabled); await load(); message.success(enabled ? "已开启自动去水印" : "已关闭自动去水印"); } catch (reason) { message.error(reason instanceof Error ? reason.message : "保存自动去水印设置失败"); } };
    const saveRotationLimit = async (limit: number) => { try { await updateDolaGateway(undefined, undefined, limit); await load(); message.success("账号轮换次数上限已保存"); } catch (reason) { message.error(reason instanceof Error ? reason.message : "保存账号轮换次数失败"); } };
    const toggleCaptureVerificationScreenshot = async (enabled: boolean) => { try { await updateDolaGateway(undefined, undefined, undefined, enabled); await load(); message.success(enabled ? "已开启异常页面截图捕获" : "已关闭异常页面截图捕获"); } catch (reason) { message.error(reason instanceof Error ? reason.message : "保存异常截图设置失败"); } };
    return <div className="space-y-4">
        {error ? <Alert type="error" showIcon message="Dola API 状态读取失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
        <Tabs activeKey={activeTab} onChange={(key) => setActiveTab(key as DolaTab)} items={[
            { key: "accounts", label: "账号与渠道" }, { key: "statistics", label: "统计报表" }, { key: "gateway", label: "反代网关与 API 密钥" }, { key: "logs", label: "请求日志" }, { key: "proxy", label: "代理管理" },
        ]} />
        {loading && !state ? <Card><Spin /> 读取 Dola API 状态…</Card> : null}
        {activeTab === "accounts" ? <AccountsPanel state={state} onRefresh={load} onImport={() => setImportOpen(true)} onTest={() => openTestModal()} onTestAccount={(accountId, headless) => openTestModal({ accountId, headless })} onSaveRotationLimit={saveRotationLimit} /> : null}
        {activeTab === "statistics" ? <StatisticsPanel state={state} /> : null}
        {activeTab === "gateway" ? <GatewayPanel state={state} onToggle={toggleGateway} onToggleAutoWatermark={toggleAutoWatermark} onToggleCaptureScreenshot={toggleCaptureVerificationScreenshot} rawKey={rawKey} setRawKey={setRawKey} open={keyOpen} setOpen={setKeyOpen} name={keyName} setName={setKeyName} onCreated={load} /> : null}
        {activeTab === "logs" ? <DolaRequestLogPanel active models={state?.models || []} accounts={state?.accounts || []} captureVerificationScreenshot={state?.gateway.captureVerificationScreenshot} onToggleCaptureVerificationScreenshot={toggleCaptureVerificationScreenshot} onLaunchHeadedTest={(accountId, model) => openTestModal({ accountId, model, headless: false })} /> : null}
        {activeTab === "proxy" ? <MagicProxyBindingCard provider="dola" /> : null}
        <Modal title="导入 Dola Cookie 账号" open={importOpen} onCancel={() => { if (!importing) { setImportOpen(false); setImportItems([]); setPastedCookies(""); } }} onOk={() => void submitImport()} okButtonProps={{ loading: importing, disabled: !importItems.length && !pastedCookies.trim() }} okText="开始导入">
            <Alert type="info" showIcon message="支持 Cookie Header 粘贴和文本文件" description="每行一个 Cookie Header；一个文件可按非空行导入多个账号，也支持同时选择多个文件。Cookie 值不会回显到列表、审计或响应。" />
            <Input.TextArea className="mt-4" rows={5} value={pastedCookies} onChange={(event) => setPastedCookies(event.target.value)} placeholder="粘贴 Cookie: name=value; other=value&#10;也可以逐行粘贴多个账号" />
            <Upload.Dragger {...fileProps} className="mt-4"><p className="ant-upload-drag-icon"><UploadCloud className="mx-auto size-8" /></p><p>选择一个或多个 .txt 文件</p><p className="text-xs text-zinc-500">已解析 {importItems.length} 条，不显示 Cookie 内容</p></Upload.Dragger>
        </Modal>
        <Modal title={isImageTestModel ? "Dola 图片通信测试" : "Dola 视频通信测试"} open={testOpen} onCancel={() => setTestOpen(false)} onOk={() => void runTest()} okButtonProps={{ loading: testing, disabled: !selectedModel }} okText={testHeadless ? "提交一次测试 (无头)" : "启动有头浏览器测试"}>
            <div className="space-y-3">
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/40">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">运行模式</div>
                            <div className="text-[11px] text-zinc-500">
                                {testHeadless ? "无头模式 (Headless)：后台隐式执行" : "有头浏览器 (Headed)：在桌面弹出真实 Camoufox 窗口实时查看"}
                            </div>
                        </div>
                        <Switch
                            checkedChildren="无头"
                            unCheckedChildren="有头"
                            checked={testHeadless}
                            onChange={(checked) => setTestHeadless(checked)}
                        />
                    </div>
                    {!testHeadless ? (
                        <div className="mt-2 text-[11px] leading-relaxed text-blue-600 dark:text-blue-400">
                            * 有头模式将在本地启动全新独立隔离环境的 Camoufox 浏览器窗口，直接使用协议提交任务，不进入网页手动点击；提交完成后窗口将自动保留供您观察验证挑战与网络详情。
                        </div>
                    ) : null}
                </div>
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">测试凭据来源</label>
                    <Select
                        className="w-full"
                        value={testCredentialMode}
                        onChange={(mode) => {
                            setTestCredentialMode(mode);
                            if (mode === "auto") {
                                setTestAccountId("");
                                setTestCustomCookie("");
                            }
                        }}
                        options={[
                            { value: "auto", label: "账号池自动轮询 (推荐)" },
                            { value: "account", label: "指定已有账号" },
                            { value: "custom", label: "临时自定义 Cookie (独立沙箱不入库)" },
                        ]}
                    />
                </div>
                {testCredentialMode === "account" ? (
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">选择要测试的账号</label>
                        <Select
                            className="w-full"
                            showSearch
                            placeholder="选择要测试的账号"
                            value={testAccountId || undefined}
                            onChange={setTestAccountId}
                            options={(state?.accounts || []).map((acc) => ({
                                value: acc.id,
                                label: `${acc.name} (${acc.authType === "google" ? "Google" : "Cookie"}) · ${DOLA_STATUS_TAGS[acc.status]?.label || acc.status}`,
                            }))}
                        />
                    </div>
                ) : null}
                {testCredentialMode === "custom" ? (
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">临时 Cookie Header</label>
                        <Input.TextArea
                            rows={3}
                            placeholder="粘贴测试 Cookie: name=value; other=value"
                            value={testCustomCookie}
                            onChange={(e) => setTestCustomCookie(e.target.value)}
                        />
                    </div>
                ) : null}
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">测试模型</label>
                    <Select className="w-full" value={testModel} options={(state?.models || []).map((model) => ({ value: model.id, label: model.name }))} onChange={setTestModel} />
                </div>
                {isImageTestModel ? (
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">宽高比</label>
                        <Select className="w-full" value={testRatio} options={(selectedModel?.aspectRatios || []).map((value) => ({ value, label: value }))} onChange={setTestRatio} />
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">时长</label>
                            <Select className="w-full" value={testDuration} options={(selectedModel?.durations || []).map((value) => ({ value, label: `${value} 秒` }))} onChange={setTestDuration} />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">宽高比</label>
                            <Select className="w-full" value={testRatio} options={(selectedModel?.aspectRatios || []).map((value) => ({ value, label: value }))} onChange={setTestRatio} />
                        </div>
                    </div>
                )}
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">参考图（选填）</label>
                    <div className="flex flex-wrap items-center gap-2">
                        <Upload accept="image/*" maxCount={1} showUploadList={false} beforeUpload={async (file) => { try { setTestReference({ dataUrl: await readFileDataUrl(file), name: file.name, mime: file.type || "image/png" }); } catch (error) { message.error(error instanceof Error ? error.message : "参考图读取失败"); } return false; }}><Button icon={<UploadCloud className="size-4" />}>{testReference ? `更换：${testReference.name}` : "上传参考图"}</Button></Upload>
                        {testReference ? <Button onClick={() => setTestReference(null)}>移除参考图</Button> : <span className="text-[11px] text-zinc-500">不上传时直接按文字提示词生成视频</span>}
                    </div>
                </div>
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">提示词</label>
                    <Input.TextArea rows={4} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} />
                </div>
                {testResult ? <Alert type={testResult.status === "failed" ? "error" : "warning"} message={testResult.status === "failed" ? testResult.error : `状态：${testResult.status}`} description={<Space direction="vertical" size={4}><span>{testResult.taskId ? `任务：${testResult.taskId}` : "已记录 Provider 响应"}</span>{testHint && !testResult.error?.includes(testHint) ? <span className="text-xs">{testHint}</span> : null}{testResult.taskId ? <Space wrap><Button size="small" loading={queryingTest} onClick={() => void queryTest()}>查询状态</Button>{testResult.verificationId ? <Button size="small" type="primary" onClick={() => setTestVerification({ taskId: testResult.taskId!, verificationId: testResult.verificationId! })}>处理验证</Button> : null}</Space> : null}</Space>} /> : null}
            </div>
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

const DOLA_STATUS_TAGS: Record<string, { label: string; color: string }> = {
    ready: { label: "可用", color: "green" },
    unverified: { label: "未验证", color: "gold" },
    needs_login: { label: "登录失效", color: "orange" },
    verification_required: { label: "待页面验证", color: "gold" },
    quota_exhausted: { label: "额度用尽", color: "volcano" },
    rate_limited: { label: "限流冷却", color: "gold" },
    restricted: { label: "已风控", color: "red" },
    disabled: { label: "已停用", color: "default" },
};

const DOLA_CHECK_VERDICTS: Record<string, string> = {
    ready: "登录、页面签名与只读协议均已通过",
    login_ready: "启动协议确认 Cookie 登录有效",
    login_unknown: "启动协议未能确认登录态，需要浏览器复核",
    unverified: "页面可访问，但签名协议验证未通过",
    needs_login: "Cookie 已失效，需要重新导入或登录",
    verification_required: "检测到安全验证页面，请先处理验证",
    quota_exhausted: "账号额度已用尽",
    rate_limited: "账号触发限流，冷却中",
    restricted: "账号已被上游风控限制",
    disabled: "账号已停用",
};

type RefreshAllPhase = "idle" | "running" | "backgrounded" | "done";
type RefreshItemState = "pending" | "running" | "success" | "failed" | "stopped";
const REFRESH_ITEM_TAGS: Record<RefreshItemState, { label: string; color: string }> = {
    pending: { label: "等待中", color: "default" },
    running: { label: "验证中", color: "processing" },
    success: { label: "已完成", color: "success" },
    failed: { label: "失败", color: "error" },
    stopped: { label: "已停止", color: "default" },
};

function GoogleLoginModal({
    open,
    onClose,
    onSuccess,
}: {
    open: boolean;
    onClose: () => void;
    onSuccess: () => Promise<void>;
}) {
    const { message } = App.useApp();
    const [mode, setMode] = useState<"browser" | "manual">("browser");
    const [accountName, setAccountName] = useState("");
    const [manualCookie, setManualCookie] = useState("");
    const [authorizing, setAuthorizing] = useState(false);

    const submit = async () => {
        setAuthorizing(true);
        try {
            if (mode === "browser") {
                message.loading({ content: "正在启动全新隔离环境的 Camoufox 浏览器，请在桌面弹出的窗口中登录 Google…", key: "dola-google", duration: 15 });
                const result = await startDolaGoogleLogin({
                    name: accountName.trim() || undefined,
                    timeoutSeconds: 180,
                });
                if (result.account) {
                    message.success({ content: `Google 授权成功！已添加账号 ${result.account.name}`, key: "dola-google" });
                    setAccountName("");
                    onClose();
                    await onSuccess();
                } else {
                    message.warning({ content: "未能获取到有效的登录凭据", key: "dola-google" });
                }
            } else {
                if (!manualCookie.trim()) {
                    message.warning("请粘贴已授权的 Google Session 或 Cookie");
                    setAuthorizing(false);
                    return;
                }
                const result = await startDolaGoogleLogin({
                    name: accountName.trim() || undefined,
                    manualCookie: manualCookie.trim(),
                });
                if (result.account) {
                    message.success({ content: `Google 账号已成功添加：${result.account.name}`, key: "dola-google" });
                    setManualCookie("");
                    setAccountName("");
                    onClose();
                    await onSuccess();
                } else {
                    message.error({ content: "账号添加失败", key: "dola-google" });
                }
            }
        } catch (error) {
            message.error({ content: error instanceof Error ? error.message : "Google 授权失败", key: "dola-google" });
        } finally {
            setAuthorizing(false);
        }
    };

    return (
        <Modal
            title="添加 Dola Google 授权账号"
            open={open}
            onCancel={() => { if (!authorizing) onClose(); }}
            onOk={() => void submit()}
            okButtonProps={{ loading: authorizing }}
            okText={mode === "browser" ? "启动浏览器并授权" : "确认添加"}
            width={520}
        >
            <div className="space-y-4">
                <Alert
                    type="info"
                    showIcon
                    message="Google 账号独立管理与全新安全指纹"
                    description="Google 授权账号采用独立分类管理，支持在本机弹出全新隔离的 Camoufox 浏览器窗口直接进行 Google 登录；授权成功后自动同步并参与视频与生图任务调度。"
                />

                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">授权方式</label>
                    <Select
                        className="w-full"
                        value={mode}
                        onChange={setMode}
                        options={[
                            { value: "browser", label: "本地 Camoufox 自动授权 (推荐 - 弹出真实窗口快捷登录)" },
                            { value: "manual", label: "录入已有 Google 授权 Session / Cookie" },
                        ]}
                    />
                </div>

                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">账号别名 (可选)</label>
                    <Input
                        placeholder="例如：Google 账号 01，留空将自动根据编号命名"
                        value={accountName}
                        onChange={(e) => setAccountName(e.target.value)}
                    />
                </div>

                {mode === "browser" ? (
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                        <p className="font-medium text-zinc-800 dark:text-zinc-200">授权流程说明：</p>
                        <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                            <li>点击下方“启动浏览器并授权”后，系统将在桌面打开一个独立的 Camoufox 浏览器窗口。</li>
                            <li>环境完全隔离、无共享缓存与历史记录，您可在该窗口中直接点击“Continue with Google”完成登录。</li>
                            <li>登录成功后系统将自动捕获 Dola 登录会话凭据并关闭窗口，账号自动进入「Google 授权」池。</li>
                        </ol>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Session / Cookie Header</label>
                        <Input.TextArea
                            rows={4}
                            placeholder="粘贴由 Google 登录提取的 Cookie Header 或 Session 凭据"
                            value={manualCookie}
                            onChange={(e) => setManualCookie(e.target.value)}
                        />
                    </div>
                )}
            </div>
        </Modal>
    );
}

function AccountsPanel({ state, onRefresh, onImport, onTest, onTestAccount, onSaveRotationLimit }: { state: DolaAdminState | null; onRefresh: () => Promise<void>; onImport: () => void; onTest: () => void; onTestAccount: (accountId: string, headless: boolean) => void; onSaveRotationLimit: (limit: number) => Promise<void> }) {
    const { message } = App.useApp();
    const accounts = state?.accounts || [];
    const [busyId, setBusyId] = useState("");
    const [activeIds, setActiveIds] = useState<string[]>([]);
    const [refreshPhase, setRefreshPhase] = useState<RefreshAllPhase>("idle");
    const [refreshItems, setRefreshItems] = useState<Array<{ id: string; name: string; state: RefreshItemState; verdict?: string }>>([]);
    const [refreshModalOpen, setRefreshModalOpen] = useState(false);
    const [googleModalOpen, setGoogleModalOpen] = useState(false);
    const [rotationLimit, setRotationLimit] = useState<number | null>(state?.gateway.rotationLimit ?? 2);
    const [savingRotation, setSavingRotation] = useState(false);
    const stopRefreshRef = useRef(false);
    useEffect(() => setRotationLimit(state?.gateway.rotationLimit ?? 2), [state?.gateway.rotationLimit]);
    const saveRotation = async () => { if (rotationLimit === null) return; setSavingRotation(true); try { await onSaveRotationLimit(rotationLimit); } finally { setSavingRotation(false); } };
    const refreshDone = refreshItems.filter((item) => item.state === "success" || item.state === "failed" || item.state === "stopped").length;
    const refreshFailed = refreshItems.filter((item) => item.state === "failed").length;
    const refreshRunning = refreshPhase === "running" || refreshPhase === "backgrounded";

    const runFor = async (id: string, action: () => Promise<unknown>) => {
        setBusyId(id);
        try {
            await action();
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "操作失败");
        } finally {
            setBusyId("");
        }
    };

    const checkAccount = (row: DolaAccount) =>
        runFor(row.id, async () => {
            const result = await refreshDolaAccount(row.id);
            await onRefresh();
            message.info(`检测完成：${DOLA_CHECK_VERDICTS[result.status] || result.status}`);
        });

    const verifyAccount = (row: DolaAccount) =>
        runFor(row.id, async () => {
            const result = await verifyDolaAccount(row.id);
            if (result.verificationId) {
                setAccountVerification({ verificationId: result.verificationId, accountId: row.id });
                message.info(result.status === "verification_required" ? "检测到真实安全验证，请在弹层中处理" : `已打开该账号的实际页面（状态：${DOLA_CHECK_VERDICTS[result.pageState || result.status] || result.pageState || result.status}）`);
            } else if (result.status === "ready") {
                message.success("该账号页面与协议状态正常，无需人工处理");
                await onRefresh();
            } else if (result.status === "needs_login") {
                message.warning("该账号登录态已失效，请重新导入 Cookie");
                await onRefresh();
            } else {
                message.info(`账号检测结果：${DOLA_CHECK_VERDICTS[result.status] || result.status}`);
                await onRefresh();
            }
        });

    const startRefreshAll = () => {
        // 旧状态来自早期协议，只跳过管理员已停用账号；其余账号都必须按当前协议重新判定。
        const runnable = accounts.filter(isValidatableAccount);
        if (!runnable.length) {
            message.warning("没有已启用的账号可验证");
            return;
        }
        const items = runnable.map((account) => ({ id: account.id, name: account.name, state: "pending" as RefreshItemState }));
        stopRefreshRef.current = false;
        setRefreshItems(items);
        setRefreshPhase("running");
        setRefreshModalOpen(true);
        let done = 0;
        const queue = [...items];
        // 每个账号先走轻量 HTTP 登录态检测；只有登录状态正常或不明确时才进入 Camoufox 完整协议验证。
        const worker = async () => {
            while (queue.length && !stopRefreshRef.current) {
                const next = queue.shift();
                if (!next) return;
                setRefreshItems((current) => current.map((item) => (item.id === next.id ? { ...item, state: "running" } : item)));
                setActiveIds((current) => [...current, next.id]);
                let failed = false;
                let verdict = "";
                try {
                    const result = await refreshDolaAccount(next.id, true);
                    verdict = DOLA_CHECK_VERDICTS[result.status] || result.status;
                } catch {
                    failed = true;
                }
                done += 1;
                setRefreshItems((current) => current.map((item) => (item.id === next.id ? { ...item, state: failed ? "failed" : "success", verdict } : item)));
                setActiveIds((current) => current.filter((id) => id !== next.id));
                await onRefresh();
            }
        };
        void Promise.all([worker(), worker()]).then(() => {
            const stopRequested = stopRefreshRef.current;
            setRefreshItems((current) => current.map((item) => (item.state === "pending" ? { ...item, state: "stopped" } : item)));
            setRefreshPhase("done");
            if (stopRequested) message.info("已停止刷新，剩余账号未处理");
        });
    };

    const stopRefreshAll = () => {
        stopRefreshRef.current = true;
    };

    const backgroundRefreshAll = () => {
        setRefreshPhase("backgrounded");
        setRefreshModalOpen(false);
    };

    const closeRefreshModal = () => {
        setRefreshModalOpen(false);
        if (refreshPhase === "running") stopRefreshRef.current = true;
    };

    const refreshAllButtonText = refreshRunning ? `正在检测全部登录态 ${refreshDone}/${refreshItems.length}` : "检测全部登录状态";

    // 只有本次代理出口的签名协议实测通过，账号才进入生成轮询；异常账号仍允许重新验证。
    const isRunnableAccount = (account: DolaAccount) => account.enabled && account.status === "ready" && account.loginState !== "needs_login";
    const isValidatableAccount = (account: DolaAccount) => account.enabled && account.status !== "disabled";
    const [accountTab, setAccountTab] = useState<"all" | "google" | "cookie" | "available" | "login_failed">("all");
    const [poolRefreshing, setPoolRefreshing] = useState(false);
    const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
    const [batchDeleting, setBatchDeleting] = useState(false);
    const [accountVerification, setAccountVerification] = useState<{ verificationId: string; accountId: string } | null>(null);
    const accountTabCounts = useMemo(() => ({
        all: accounts.length,
        google: accounts.filter((account) => account.authType === "google").length,
        cookie: accounts.filter((account) => account.authType !== "google").length,
        available: accounts.filter(isRunnableAccount).length,
        login_failed: accounts.filter((account) => account.status === "needs_login").length,
    }), [accounts]);
    const visibleAccounts = useMemo(() => {
        if (accountTab === "google") return accounts.filter((account) => account.authType === "google");
        if (accountTab === "cookie") return accounts.filter((account) => account.authType !== "google");
        if (accountTab === "available") return accounts.filter(isRunnableAccount);
        if (accountTab === "login_failed") return accounts.filter((account) => account.status === "needs_login");
        return accounts;
    }, [accountTab, accounts]);
    useEffect(() => {
        // 清理已不存在的选中项；内容未变时返回原引用让 React 跳过更新，
        // 否则 accounts 为不稳定引用（state 未加载时每次渲染都是新 []）会触发无限重渲染（React #185）。
        setSelectedAccountIds((current) => {
            const next = current.filter((id) => accounts.some((account) => account.id === id));
            return next.length === current.length ? current : next;
        });
    }, [accounts]);
    const refreshPool = async () => {
        setPoolRefreshing(true);
        try {
            await onRefresh();
        } finally {
            setPoolRefreshing(false);
        }
    };
    const batchDeleteSelected = async () => {
        if (!selectedAccountIds.length) return;
        setBatchDeleting(true);
        try {
            const result = await batchDeleteDolaAccounts(selectedAccountIds);
            message.success(result.skipped ? `已删除 ${result.deleted} 个账号，${result.skipped} 个因仍有运行中任务被跳过` : `已删除 ${result.deleted} 个账号`);
            setSelectedAccountIds([]);
            await onRefresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量删除失败");
        } finally {
            setBatchDeleting(false);
        }
    };
    const accountTabs = [
        { key: "all", label: `全部 ${accountTabCounts.all}` },
        { key: "google", label: `Google 授权 ${accountTabCounts.google}` },
        { key: "cookie", label: `Cookie 导入 ${accountTabCounts.cookie}` },
        { key: "available", label: `正常可轮询 ${accountTabCounts.available}` },
        { key: "login_failed", label: `登录失效 ${accountTabCounts.login_failed}` },
    ] as const;

    return <><Card title="Dola API" extra={<Space wrap><Button icon={<RefreshCw className="size-4" />} onClick={() => void onRefresh()}>刷新</Button><Button icon={<FileKey2 className="size-4" />} onClick={onImport}>导入 Cookie</Button><Button icon={<KeyRound className="size-4" />} onClick={() => setGoogleModalOpen(true)}>Google 授权登录</Button><Button type="primary" icon={<Play className="size-4" />} disabled={!state?.models.length} onClick={onTest}>通信测试</Button></Space>}><Descriptions size="small" column={{ xs: 1, sm: 3 }} items={[{ key: "transport", label: "提交方式", children: <Tag color="blue">Camoufox 页面会话</Tag> }, { key: "provider", label: "Provider", children: state?.healthy ? <Tag color="green">正常</Tag> : <Tag>待连接</Tag> }, { key: "proxy", label: "代理策略", children: <Tag>请在“代理管理”配置</Tag> }]} /><div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"><div className="min-w-0"><div className="text-sm font-medium">账号轮换次数上限</div><div className="text-xs text-zinc-500">站内画布/工作台与外部 API 生成视频遇账号限额（rate_limited）时自动切换账号的最大次数；0 表示不切换，配额用尽后任务保持轮询等待上游真实结果，不再提前判失败。</div></div><div className="flex shrink-0"><Space.Compact><InputNumber min={0} precision={0} style={{ width: 224 }} value={rotationLimit ?? 0} onChange={(value) => setRotationLimit(value ?? 0)} /><Button type="primary" loading={savingRotation} disabled={rotationLimit === null || rotationLimit === state?.gateway.rotationLimit} onClick={() => void saveRotation()}>保存</Button></Space.Compact></div></div></Card><Card title="账号池" extra={<Space wrap><Button icon={<RefreshCw className={`size-4 ${poolRefreshing ? "animate-spin" : ""}`} />} disabled={poolRefreshing} onClick={() => void refreshPool()}>刷新</Button><Popconfirm title={`删除选中的 ${selectedAccountIds.length} 个 Dola 账号？`} description="只移除账号记录，不影响已生成任务；仍有运行中任务的账号会被跳过。" okText="删除" cancelText="取消" onConfirm={() => void batchDeleteSelected()}><Button danger icon={<Trash2 className="size-4" />} loading={batchDeleting} disabled={!selectedAccountIds.length}>批量删除</Button></Popconfirm><Button icon={<RefreshCw className={`size-4 ${refreshRunning ? "animate-spin" : ""}`} />} disabled={!accounts.filter(isValidatableAccount).length} onClick={() => (refreshRunning ? setRefreshModalOpen(true) : startRefreshAll())}>{refreshAllButtonText}</Button></Space>}><Tabs size="small" className="mb-1" activeKey={accountTab} onChange={(key) => { setAccountTab(key as typeof accountTab); setSelectedAccountIds([]); }} items={accountTabs.map((tab) => ({ key: tab.key, label: tab.label }))} /><Table rowKey="id" size="small" pagination={{ pageSize: 10 }} rowSelection={{ selectedRowKeys: selectedAccountIds, onChange: (keys) => setSelectedAccountIds(keys as string[]) }} dataSource={visibleAccounts} columns={[{ title: "账号", render: (_: unknown, row: DolaAccount) => (<div className="flex flex-col gap-0.5"><div className="flex items-center gap-1.5"><span className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</span>{row.authType === "google" ? (<Tag color="purple" className="m-0 text-[10px]">Google 授权</Tag>) : (<Tag color="default" className="m-0 text-[10px]">Cookie 导入</Tag>)}</div>{row.email ? <span className="text-[11px] text-zinc-500">{row.email}</span> : null}</div>) }, { title: "账号 ID", render: (_: unknown, row: DolaAccount) => <button type="button" className="max-w-[150px] truncate rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700" title={`点击复制完整 ID：${row.id}`} onClick={() => { void navigator.clipboard.writeText(row.id); message.success("账号 ID 已复制"); }}>{row.id}</button> }, { title: "登录状态", render: (_: unknown, row: DolaAccount) => row.status === "needs_login" || row.loginState === "needs_login" ? <Tag color="error">Cookie 失效</Tag> : <Tag color="success">登录有效 · 可轮询</Tag> }, { title: "最近生成验证", render: (_: unknown, row: DolaAccount) => row.validation?.generation ? <Tag className="m-0" color={row.validation.generation.status === "success" ? "success" : row.validation.generation.status === "unknown" ? "gold" : "error"}>{row.validation.generation.status === "success" ? "生成通过" : row.validation.generation.status === "unknown" ? "生成结果未知" : "生成失败"}</Tag> : <span className="text-[11px] text-zinc-500">未做真实生成</span> }, { title: "请求", dataIndex: "requestCount" }, { title: "成功", dataIndex: "successCount" }, { title: "额度", render: (_: unknown, row: DolaAccount) => row.quota?.length ? row.quota.map((quota) => quota.remaining === null ? (quota.source === "unknown" ? "上游未公开" : "未知") : `${quota.remaining}/${quota.limit ?? "—"}`).join("、") : "未知" }, { title: "操作", render: (_: unknown, row: DolaAccount) => {
        const busy = busyId === row.id || activeIds.includes(row.id);
        return <Space wrap><Button size="small" loading={busy} onClick={() => void runFor(row.id, () => updateDolaAccount(row.id, { enabled: !row.enabled }).then(() => onRefresh()))}>{row.enabled ? "停用" : "启用"}</Button><Button size="small" loading={busy} onClick={() => void checkAccount(row)}>检测登录状态</Button><Button size="small" icon={<Play className="size-3" />} onClick={() => onTestAccount(row.id, false)}>真实生成验证</Button><Button size="small" loading={busy} onClick={() => void verifyAccount(row)}>查看账号页面</Button><Popconfirm title="删除该 Dola 账号？" description="只移除账号记录，不影响已生成任务；仍有运行中任务的账号会被跳过。" okText="删除" cancelText="取消" onConfirm={() => void runFor(row.id, () => deleteDolaAccount(row.id).then(() => onRefresh()))}><Button danger size="small" loading={busy}>删除</Button></Popconfirm></Space>;
    } }]} /></Card><Modal title="检测全部登录状态" open={refreshModalOpen} onCancel={closeRefreshModal} maskClosable={false} footer={<Space wrap><Button danger disabled={!refreshRunning} onClick={stopRefreshAll}>停止验证</Button>{refreshPhase === "running" ? <Button onClick={backgroundRefreshAll}>转入后台</Button> : null}<Button type="primary" onClick={closeRefreshModal}>{refreshPhase === "done" ? "关闭" : "收起"}</Button></Space>}><div className="space-y-3"><div className="flex flex-wrap items-center gap-2 text-sm"><span>{refreshPhase === "done" ? "检测结束" : "正在通过只读启动协议检测全部已启用 Cookie，不启动浏览器"}</span><Tag color={refreshFailed ? "error" : "processing"} className="m-0">{refreshDone}/{refreshItems.length}{refreshFailed ? ` · 失败 ${refreshFailed}` : ""}</Tag></div><div className="max-h-80 divide-y divide-zinc-200 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">{refreshItems.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-2"><span className="min-w-0 truncate text-sm" title={item.name}>{item.name}</span><Tag color={REFRESH_ITEM_TAGS[item.state].color} className="m-0">{REFRESH_ITEM_TAGS[item.state].label}</Tag>{item.verdict ? <span className="min-w-0 flex-1 truncate text-right text-xs text-zinc-500" title={item.verdict}>{item.verdict}</span> : null}</div>)}</div>
                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                        {(() => {
                                            const done = refreshItems.filter((item) => item.verdict);
                                            const count = (keyword: string) => done.filter((item) => (item.verdict || "").includes(keyword)).length;
                                            return (
                                                <>
                                                    <Tag color="green" className="m-0">登录有效 {count("登录有效")}</Tag>
                                                    <Tag color="gold" className="m-0">需要浏览器复核 {count("浏览器复核")}</Tag>
                                                    <Tag color="orange" className="m-0">Cookie 失效 {count("失效")}</Tag>
                                                    <Tag color="red" className="m-0">检测失败 {refreshFailed}</Tag>
                                                </>
                                            );
                                        })()}
                                    </div><div className="text-xs text-zinc-500">关闭弹层（未转入后台）会停止剩余账号的验证；转入后台后可点击「正在验证账号」按钮重新查看进度。</div></div></Modal><DolaVerificationDialog request={accountVerification ? { taskId: "", verificationId: accountVerification.verificationId } : null} admin onClose={() => setAccountVerification(null)} onResolved={async () => { message.success("账号页面已重新检测，并同步当前凭据与状态"); setAccountVerification(null); await onRefresh(); }} /><GoogleLoginModal open={googleModalOpen} onClose={() => setGoogleModalOpen(false)} onSuccess={onRefresh} /></>;
}

function StatisticsPanel({ state }: { state: DolaAdminState | null }) { const stats = state?.stats; return <div className="grid gap-4 sm:grid-cols-3"><Card><Statistic title="账号总数" value={stats?.totalAccounts || 0} prefix={<Bot className="size-4" />} /></Card><Card><Statistic title="成功请求" value={stats?.successCount || 0} prefix={<CheckCircle2 className="size-4" />} /></Card><Card><Statistic title="失败请求" value={stats?.errorCount || 0} prefix={<Activity className="size-4" />} /></Card></div>; }

function GatewayPanel({ state, onToggle, onToggleAutoWatermark, onToggleCaptureScreenshot, rawKey, setRawKey, open, setOpen, name, setName, onCreated }: { state: DolaAdminState | null; onToggle: (enabled: boolean) => Promise<void>; onToggleAutoWatermark: (enabled: boolean) => Promise<void>; onToggleCaptureScreenshot?: (enabled: boolean) => Promise<void>; rawKey: string; setRawKey: (value: string) => void; open: boolean; setOpen: (value: boolean) => void; name: string; setName: (value: string) => void; onCreated: () => Promise<void> }) {
    const [creating, setCreating] = useState(false);
    const [keys, setKeys] = useState<DolaApiKey[]>(state?.apiKeys || []);
    useEffect(() => setKeys(state?.apiKeys || []), [state?.apiKeys]);
    const create = async () => { setCreating(true); try { const result = await createDolaApiKey({ name }); setRawKey(result.rawKey); setOpen(false); await onCreated(); } finally { setCreating(false); } };
    return <div className="grid gap-4 xl:grid-cols-2"><Card title="反代网关" extra={<Space><span className="text-xs text-zinc-500">网关</span><Switch checked={state?.gateway.enabled} onChange={(checked) => void onToggle(checked)} /></Space>}><Alert type="info" showIcon message="外部接口前缀：/api/dola/v1" description="网关只接受 Dola API 密钥，内部 Provider 请求不复用外部密钥。" /><div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"><div><div className="text-sm font-medium">自动去水印</div><div className="text-xs text-zinc-500">Dola 返回可验证 VOD 地址时，任务保存前自动切换到无水印地址；默认关闭。</div></div><Switch checked={state?.gateway.autoWatermark} onChange={(checked) => void onToggleAutoWatermark(checked)} /></div><div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"><div><div className="text-sm font-medium">异常页面截图</div><div className="text-xs text-zinc-500">协议提交发生安全验证、登录失效、限流或未知提交错误时，保存浏览器真实页面并在请求日志中提供放大查看；默认开启。</div></div><Switch checked={state?.gateway.captureVerificationScreenshot ?? true} onChange={(checked) => void onToggleCaptureScreenshot?.(checked)} /></div></Card><Card title="API 密钥" extra={<Button icon={<KeyRound className="size-4" />} onClick={() => setOpen(true)}>创建密钥</Button>}>{rawKey ? <Alert className="mb-3" type="warning" message="新密钥只显示一次" description={<code className="break-all">{rawKey}</code>} /> : null}{keys.length ? keys.map((key) => <div key={key.id} className="flex items-center justify-between border-b py-2 last:border-b-0"><span>{key.name} <Tag>{key.prefix}…</Tag></span><span className="text-xs text-zinc-500">{key.requestCount} 次</span></div>) : <Empty description="尚未创建密钥" />}</Card><Modal title="创建 Dola API 密钥" open={open} onCancel={() => setOpen(false)} onOk={() => void create()} confirmLoading={creating}><Input prefix={<KeyRound className="size-4" />} value={name} onChange={(event) => setName(event.target.value)} /></Modal></div>;
}

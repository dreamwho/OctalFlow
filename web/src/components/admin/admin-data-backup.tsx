"use client";

import { useEffect, useRef, useState } from "react";
import { App, Button, Input, InputNumber, Modal } from "antd";
import { saveAs } from "file-saver";
import { DatabaseBackup, Download, FileJson2, HardDrive, ShieldCheck, Upload } from "lucide-react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { ADMIN_BACKUP_MAX_BYTES, downloadAdminBackup, importAdminBackup } from "@/services/api/admin-backup";

const sectionLabels: Record<string, string> = {
    auth: "账号与系统业务设置",
    prompts: "公共提示词",
    generationLogs: "生成记录",
};

type AutoBackupStatus = { enabled: boolean; destination?: string; intervalDays?: number; lastAt?: string | null; lastError?: string };
type DesktopBackupBridge = {
    prepareWorkspaceOperation(kind: "backup" | "restore"): Promise<{ token: string } | null>;
    beginWorkspaceOperation(token: string, password: string): void;
    openDataDirectory(): Promise<boolean>;
    getAutoBackup(): Promise<AutoBackupStatus>;
    configureAutoBackup(password: string, intervalDays: number): Promise<AutoBackupStatus | null>;
    disableAutoBackup(): Promise<AutoBackupStatus>;
};
const desktopBridge = () => (window as typeof window & { dreamyoDesktop?: DesktopBackupBridge }).dreamyoDesktop;

export function AdminDataBackup({ desktopEdition }: { desktopEdition?: "commercial" | "admin" | null }) {
    const { message, modal } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [lastImported, setLastImported] = useState<string[]>([]);
    const [workspaceAction, setWorkspaceAction] = useState<"backup" | "restore" | null>(null);
    const [workspacePassword, setWorkspacePassword] = useState("");
    const [workspacePasswordConfirm, setWorkspacePasswordConfirm] = useState("");
    const [workspacePreparing, setWorkspacePreparing] = useState(false);
    const [autoBackup, setAutoBackup] = useState<AutoBackupStatus>({ enabled: false });
    const [autoBackupOpen, setAutoBackupOpen] = useState(false);
    const [autoBackupPassword, setAutoBackupPassword] = useState("");
    const [autoBackupConfirm, setAutoBackupConfirm] = useState("");
    const [autoBackupDays, setAutoBackupDays] = useState(1);
    const [autoBackupSaving, setAutoBackupSaving] = useState(false);
    useEffect(() => {
        if (desktopEdition !== "admin") return;
        void desktopBridge()?.getAutoBackup().then((status) => { setAutoBackup(status); if (status.intervalDays) setAutoBackupDays(status.intervalDays); }).catch(() => {});
    }, [desktopEdition]);
    const startWorkspaceOperation = async () => {
        if (!workspaceAction || !workspacePassword.trim()) { message.warning("请输入工作区备份密码"); return; }
        if (workspaceAction === "backup" && workspacePassword !== workspacePasswordConfirm) { message.warning("两次输入的密码不一致"); return; }
        setWorkspacePreparing(true);
        try {
            const desktop = desktopBridge();
            if (!desktop) throw new Error("请在管理员桌面应用中操作");
            const prepared = await desktop.prepareWorkspaceOperation(workspaceAction);
            if (!prepared) return;
            desktop.beginWorkspaceOperation(prepared.token, workspacePassword);
            setWorkspaceAction(null);
            setWorkspacePassword("");
            setWorkspacePasswordConfirm("");
            message.info("本地服务将暂停并在工作区操作完成后自动重新启动");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "工作区操作无法启动");
        } finally { setWorkspacePreparing(false); }
    };
    const openLocalData = async () => {
        try {
            const desktop = desktopBridge();
            if (!desktop) throw new Error("请在管理员桌面应用中打开");
            await desktop.openDataDirectory();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法打开本地工作区");
        }
    };
    const configureAutoBackup = async () => {
        if (!autoBackupPassword.trim() || autoBackupPassword !== autoBackupConfirm) { message.warning("请输入两次相同的自动备份密码"); return; }
        setAutoBackupSaving(true);
        try {
            const status = await desktopBridge()?.configureAutoBackup(autoBackupPassword, autoBackupDays);
            if (status) { setAutoBackup(status); setAutoBackupOpen(false); setAutoBackupPassword(""); setAutoBackupConfirm(""); message.success("已设置启动时自动备份"); }
        } catch (error) { message.error(error instanceof Error ? error.message : "自动备份设置失败"); }
        finally { setAutoBackupSaving(false); }
    };
    const disableAutoBackup = async () => {
        try { const status = await desktopBridge()?.disableAutoBackup(); if (status) { setAutoBackup(status); message.success("已关闭自动备份"); } }
        catch (error) { message.error(error instanceof Error ? error.message : "关闭自动备份失败"); }
    };

    const exportBackup = async () => {
        setExporting(true);
        try {
            const backup = await downloadAdminBackup();
            saveAs(backup.blob, backup.fileName);
            message.success("业务数据备份已导出");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出备份失败");
        } finally {
            setExporting(false);
        }
    };

    const selectBackup = (file?: File) => {
        if (inputRef.current) inputRef.current.value = "";
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".json")) {
            message.error("请选择 JSON 备份文件");
            return;
        }
        if (file.size > ADMIN_BACKUP_MAX_BYTES) {
            message.error("备份文件不能超过 30MB");
            return;
        }
        modal.confirm({
            title: "恢复业务数据？",
            content: `将从“${file.name}”恢复可识别的数据，并在服务器创建恢复前安全备份。当前敏感凭据不会被上传文件覆盖。`,
            okText: "确认恢复",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                setImporting(true);
                try {
                    const result = await importAdminBackup(file);
                    setLastImported(result.imported);
                    message.success("业务数据已恢复，请刷新后台确认最新状态");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "导入备份失败");
                    throw error;
                } finally {
                    setImporting(false);
                }
            },
        });
    };

    return (
        <>
            <Panel>
                <PanelHeader
                    title="数据备份"
                    description={desktopEdition === "admin" ? "业务记录 JSON 与完整本地工作区分开备份；项目和媒体需复制整个数据目录。" : "导出和恢复脱敏业务数据；文件模式与 PostgreSQL 使用同一备份格式。"}
                    actions={
                        <Button type="primary" icon={<Download className="size-4" />} loading={exporting} onClick={() => void exportBackup()}>
                            导出备份
                        </Button>
                    }
                />
                <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    <section className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div className="flex min-w-0 gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                                <FileJson2 className="size-5" />
                            </span>
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">{desktopEdition === "admin" ? "本地业务记录导出" : "跨 Provider 业务备份"}</h3>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{desktopEdition === "admin" ? "导出非敏感设置与生成记录；JSON 不包含画布项目素材、渠道密钥或账号 Cookie。" : "包含账号权益与非敏感系统设置、公共提示词和生成记录。导出文件不包含登录凭据、渠道密钥、支付密钥或 OSS 凭据。"}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                            <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                            脱敏导出
                        </div>
                    </section>

                    <section className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div className="flex min-w-0 gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                                <DatabaseBackup className="size-5" />
                            </span>
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">{desktopEdition === "admin" ? "恢复本地业务记录" : "恢复业务数据"}</h3>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{desktopEdition === "admin" ? "导入前会保留当前业务记录的安全副本；JSON 恢复不替换本机渠道凭据，也不恢复画布或媒体文件。" : "导入前自动保留当前业务数据的安全副本。恢复不会替换当前服务器保存的敏感凭据，也不会修改媒体文件位置。"}</p>
                                {lastImported.length ? <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">最近恢复：{lastImported.map((key) => sectionLabels[key] || key).join("、")}</p> : null}
                            </div>
                        </div>
                        <Button icon={<Upload className="size-4" />} loading={importing} onClick={() => inputRef.current?.click()}>
                            导入备份
                        </Button>
                        <input ref={inputRef} className="hidden" type="file" accept="application/json,.json" onChange={(event) => selectBackup(event.target.files?.[0])} />
                    </section>

                    <section className="grid gap-4 bg-zinc-50/70 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center dark:bg-zinc-900/35">
                        <div className="flex min-w-0 gap-3">
                            <HardDrive className="mt-0.5 size-5 shrink-0 text-zinc-500 dark:text-zinc-400" />
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">{desktopEdition === "admin" ? "完整本地工作区备份" : "完整数据库与媒体备份"}</h3>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{desktopEdition === "admin" ? "用密码加密备份完整的项目、媒体与渠道凭据，可恢复到另一台电脑。手动备份和恢复期间本地服务会暂停并自动重启；也可以单独导出含素材的画布 ZIP。" : "PostgreSQL 整库、支付流水、媒体原文件和对象存储应继续使用当前部署环境的数据库、服务器或云存储备份能力。"}</p>
                                {desktopEdition === "admin" && autoBackup.enabled ? <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">启动时每 {autoBackup.intervalDays} 天备份到 {autoBackup.destination}；上次完成：{autoBackup.lastAt ? new Date(autoBackup.lastAt).toLocaleString("zh-CN") : "尚未执行"}</p> : null}
                                {desktopEdition === "admin" && autoBackup.lastError ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">上次自动备份失败：{autoBackup.lastError}</p> : null}
                            </div>
                        </div>
                        {desktopEdition === "admin" ? <div className="flex flex-wrap justify-end gap-2"><Button onClick={() => setWorkspaceAction("backup")}>备份完整工作区</Button><Button onClick={() => setWorkspaceAction("restore")}>恢复完整工作区</Button><Button onClick={() => setAutoBackupOpen(true)}>设置自动备份</Button>{autoBackup.enabled ? <Button onClick={() => void disableAutoBackup()}>关闭自动备份</Button> : null}<Button icon={<HardDrive className="size-4" />} onClick={() => void openLocalData()}>打开数据目录</Button></div> : <span className="text-xs text-zinc-500 dark:text-zinc-400">宝塔 / Docker / 云数据库分别管理</span>}
                    </section>
                </div>
            </Panel>
            <Modal
                title={workspaceAction === "backup" ? "加密备份完整工作区" : "恢复完整工作区"}
                open={workspaceAction !== null}
                okText={workspaceAction === "backup" ? "选择保存位置" : "选择备份文件夹并恢复"}
                okButtonProps={{ danger: workspaceAction === "restore", loading: workspacePreparing }}
                onOk={() => void startWorkspaceOperation()}
                onCancel={() => { setWorkspaceAction(null); setWorkspacePassword(""); setWorkspacePasswordConfirm(""); }}
                destroyOnHidden
            >
                <p className="mb-4 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{workspaceAction === "backup" ? "备份生成 .dreamyo-workspace 文件夹。请妥善保管密码；没有密码无法恢复渠道密钥、Cookie 和项目。" : "恢复将替换本机项目、媒体和模型配置。恢复前会校验密码与备份完整性，启动失败则回滚原工作区。"}</p>
                <Input.Password autoComplete="new-password" placeholder="备份密码" value={workspacePassword} onChange={(event) => setWorkspacePassword(event.target.value)} />
                {workspaceAction === "backup" ? <Input.Password className="mt-3" autoComplete="new-password" placeholder="再次输入备份密码" value={workspacePasswordConfirm} onChange={(event) => setWorkspacePasswordConfirm(event.target.value)} /> : null}
            </Modal>
            <Modal title="启动时自动备份" open={autoBackupOpen} okText="选择备份目录并保存" okButtonProps={{ loading: autoBackupSaving }} onOk={() => void configureAutoBackup()} onCancel={() => { setAutoBackupOpen(false); setAutoBackupPassword(""); setAutoBackupConfirm(""); }} destroyOnHidden>
                <p className="mb-4 text-sm leading-6 text-zinc-600 dark:text-zinc-300">应用每次启动时检查是否达到所设天数；到期后先备份再启动本地服务。目录可以选择移动硬盘或已挂载的 NAS，目录不可用时会继续启动并显示失败原因。密码仅由本机系统安全存储加密保存，恢复备份时仍需输入密码。</p>
                <div className="mb-3 flex items-center gap-3 text-sm"><span>备份周期</span><InputNumber min={1} precision={0} value={autoBackupDays} onChange={(value) => setAutoBackupDays(value || 1)} /><span>天</span></div>
                <Input.Password autoComplete="new-password" placeholder="备份密码" value={autoBackupPassword} onChange={(event) => setAutoBackupPassword(event.target.value)} />
                <Input.Password className="mt-3" autoComplete="new-password" placeholder="再次输入备份密码" value={autoBackupConfirm} onChange={(event) => setAutoBackupConfirm(event.target.value)} />
            </Modal>
        </>
    );
}

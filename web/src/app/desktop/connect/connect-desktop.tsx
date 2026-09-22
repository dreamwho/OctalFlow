"use client";

import { useEffect, useState } from "react";

type Authorization = { userCode: string; verificationUrl: string; expiresAt: string };
type DesktopBridge = {
    cloudStatus(): Promise<{ configured: boolean; origin: string }>;
    cloudStart(): Promise<Authorization>;
    cloudFinish(): Promise<{ status: "pending" | "authorized" }>;
    openExternal(url: string): Promise<boolean>;
};

function bridge() { return (window as typeof window & { dreamyoDesktop?: DesktopBridge }).dreamyoDesktop; }

export default function ConnectDesktop() {
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [authorization, setAuthorization] = useState<Authorization | null>(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => { void bridge()?.cloudStatus().then((result) => setConfigured(result.configured)).catch(() => setConfigured(false)); }, []);

    async function start() {
        setBusy(true);
        setMessage("");
        try { setAuthorization(await bridge()!.cloudStart()); }
        catch (error) { setMessage(error instanceof Error ? error.message : "无法发起云端授权"); }
        finally { setBusy(false); }
    }

    async function finish() {
        setBusy(true);
        try {
            const result = await bridge()!.cloudFinish();
            setMessage(result.status === "pending" ? "网页尚未确认授权，请核对授权码后再检查。" : "授权成功，正在打开画布…");
        } catch (error) { setMessage(error instanceof Error ? error.message : "验证云端授权失败"); }
        finally { setBusy(false); }
    }

    return <main data-cloud-ready={configured !== null} className="app-scroll-page flex min-h-full items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <section className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-7 shadow-xl">
            <h1 className="text-2xl font-semibold">连接云端账号</h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">商用桌面版使用云端账号登录。请在系统浏览器登录 Dreamyo，再确认设备授权；密码不会交给桌面应用。</p>
            {configured === false ? <p role="alert" className="mt-5 rounded-lg border border-amber-700 bg-amber-950 p-3 text-sm text-amber-100">云端站点地址未配置。请配置 DREAMYO_DESKTOP_CLOUD_ORIGIN 后重启应用。</p> : <>
                {!authorization ? <button type="button" onClick={start} disabled={busy || configured !== true} className="mt-6 rounded-lg bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-500 disabled:opacity-60">{busy ? "正在连接…" : "开始设备授权"}</button> : <>
                    <div className="mt-6 rounded-xl border border-slate-600 bg-slate-800 p-4">
                        <p className="text-sm text-slate-300">请确认网页显示同一授权码</p>
                        <p className="mt-2 font-mono text-xl font-semibold tracking-widest">{authorization.userCode}</p>
                    </div>
                    <div className="mt-5 flex flex-wrap gap-3">
                        <button type="button" onClick={() => void bridge()!.openExternal(authorization.verificationUrl).catch(() => setMessage("无法打开系统浏览器，请复制链接手动访问。"))} className="rounded-lg border border-slate-500 px-4 py-2 text-slate-100 hover:bg-slate-800">在浏览器打开授权页</button>
                        <button type="button" onClick={finish} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-60">{busy ? "正在检查…" : "我已在网页授权，检查状态"}</button>
                        <button type="button" onClick={start} disabled={busy} className="rounded-lg border border-slate-500 px-4 py-2 text-slate-100 hover:bg-slate-800 disabled:opacity-60">重新发起授权</button>
                    </div>
                    <p className="mt-3 break-all text-xs text-slate-400">{authorization.verificationUrl}</p>
                </>}
            </>}
            {message && <p role="status" className="mt-5 text-sm text-slate-200">{message}</p>}
        </section>
    </main>;
}

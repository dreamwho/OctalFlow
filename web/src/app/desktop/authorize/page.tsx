import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { DesktopDeviceAuthError, getDesktopDeviceAuthorization } from "@/lib/server/desktop-device-auth";

import ApproveDeviceButton from "./approve-device-button";

export const dynamic = "force-dynamic";

export default async function DesktopAuthorizePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
    const code = (await searchParams).code || "";
    const user = await getCurrentUser();
    if (!user) redirect(`/login?next=${encodeURIComponent(`/desktop/authorize?code=${encodeURIComponent(code)}`)}`);

    let request: Awaited<ReturnType<typeof getDesktopDeviceAuthorization>> | null = null;
    try { request = await getDesktopDeviceAuthorization(code); }
    catch (error) { if (!(error instanceof DesktopDeviceAuthError)) throw error; }

    return <main className="app-scroll-page flex min-h-full items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <section className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
            <h1 className="text-xl font-semibold">授权 Dreamyo 桌面应用</h1>
            {request ? <>
                <p className="mt-4 text-sm leading-6 text-slate-300">请确认桌面应用中显示的授权码与下方完全相同。只有您正在登录自己的设备时才继续。</p>
                <div className="mt-5 rounded-xl border border-slate-600 bg-slate-800 p-4">
                    <p className="text-sm text-slate-300">设备：{request.deviceLabel}</p>
                    <p className="mt-2 font-mono text-lg font-semibold tracking-widest">{request.userCode}</p>
                </div>
                <p className="mt-4 text-sm text-slate-300">将授权给当前登录账号：{user.displayName || user.username}</p>
                <ApproveDeviceButton userCode={request.userCode} alreadyApproved={request.status === "approved"} />
            </> : <p className="mt-4 text-sm text-slate-300">授权码不存在、已使用或已过期。请在桌面应用重新发起授权。</p>}
        </section>
    </main>;
}

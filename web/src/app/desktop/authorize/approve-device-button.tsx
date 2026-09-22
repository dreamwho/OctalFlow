"use client";

import { useState } from "react";

export default function ApproveDeviceButton({ userCode, alreadyApproved }: { userCode: string; alreadyApproved: boolean }) {
    const [status, setStatus] = useState(alreadyApproved ? "已授权，请返回桌面应用" : "");
    const [busy, setBusy] = useState(false);

    async function approve() {
        setBusy(true);
        try {
            const response = await fetch("/api/desktop/devices/approve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userCode }),
            });
            const result = await response.json();
            setStatus(response.ok ? "已授权，请返回桌面应用" : result.msg || "授权失败，请重试");
        } catch { setStatus("网络连接失败，请重试"); }
        finally { setBusy(false); }
    }

    return <div className="mt-6">
        <button type="button" onClick={approve} disabled={busy || alreadyApproved || status.startsWith("已授权")}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60">
            {busy ? "正在授权…" : "确认授权此设备"}
        </button>
        {status && <p role="status" className="mt-3 text-sm text-slate-200">{status}</p>}
    </div>;
}

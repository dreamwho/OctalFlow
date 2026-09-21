"use client";

import { Alert, Button, Modal, Spin, message } from "antd";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import type { CanvasDolaVerification } from "../[id]/use-canvas-page-state";

type Snapshot = { verificationId: string; taskId: string; status: string; pageState?: string; pageUrl?: string; decision?: { type?: string; subtype?: string; pageState?: string }; viewport: { width: number; height: number }; screenshotBase64: string; leaseToken?: string };
type VerificationRequest = { taskId: string; verificationId: string };

export function DolaVerificationDialog({ request, onClose, onResolved, admin = false }: { request: CanvasDolaVerification | VerificationRequest | null; onClose: () => void; onResolved: () => void; admin?: boolean }) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const pointerDownRef = useRef(false);
    const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => {
        if (!request) { setSnapshot(null); return; }
        let cancelled = false;
        setLoading(true);
        fetch(verificationPath(request, "open", admin), { method: "POST", cache: "no-store" })
            .then(async (response) => {
                const payload = await readVerificationPayload(response);
                if (!response.ok) throw new Error(errorMessage(payload, "无法打开 Dola 验证窗口"));
                if (!cancelled) setSnapshot(payload as Snapshot);
            })
            .catch((error) => { if (!cancelled) { message.error(error instanceof Error ? error.message : "无法打开 Dola 验证窗口"); onClose(); } })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [admin, onClose, request]);

    const sendInput = async (action: "down" | "move" | "up", point: { x: number; y: number }) => {
        if (!snapshot?.leaseToken || !request) return;
        if (busy && action === "move") { pendingMoveRef.current = point; return; }
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "input", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken, action, x: point.x, y: point.y }) });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "页面操作失败"));
            setSnapshot((current) => current ? { ...current, ...payload, leaseToken: current.leaseToken } : current);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "页面操作失败");
        } finally {
            setBusy(false);
            const pending = pendingMoveRef.current;
            pendingMoveRef.current = null;
            if (pending && pointerDownRef.current) void sendInput("move", pending);
        }
    };

    const pointForEvent = (event: PointerEvent<HTMLImageElement>) => {
        const rect = imageRef.current?.getBoundingClientRect();
        if (!rect || !snapshot) return null;
        return { x: Math.max(0, Math.min(snapshot.viewport.width, (event.clientX - rect.left) * snapshot.viewport.width / rect.width)), y: Math.max(0, Math.min(snapshot.viewport.height, (event.clientY - rect.top) * snapshot.viewport.height / rect.height)) };
    };
    const close = async () => {
        if (snapshot?.leaseToken && request) await fetch(verificationPath(request, "close", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken }) }).catch(() => undefined);
        onClose();
    };
    const resume = async () => {
        if (!snapshot?.leaseToken || !request) return;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "resume", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken }) });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "验证尚未通过"));
            if (payload?.status === "accepted") { onResolved(); return; }
            setSnapshot((current) => current ? { ...current, ...payload, leaseToken: current.leaseToken } : current);
            message.warning(payload?.status === "needs_login" ? "页面仍处于登录状态异常，请重新导入可用 Cookie 后再检测" : payload?.pageState === "protocol_unavailable" ? "页面已打开，但协议签名尚未就绪，请在页面中确认登录状态后重新检测" : "页面仍需要处理，请根据截图中的实际提示继续操作");
        } catch (error) { message.error(error instanceof Error ? error.message : "恢复 Dola 请求失败"); } finally { setBusy(false); }
    };

    const diagnostic = admin && snapshot?.decision?.type === "inspect";
    const ageConfirmation = snapshot?.decision?.subtype === "age_confirmation" || snapshot?.pageState === "age_confirmation_required";
    const diagnosticState = snapshot?.pageState === "needs_login" ? "登录失效" : snapshot?.pageState === "protocol_unavailable" ? "页面已打开，协议签名尚未就绪" : "页面与协议均正常";
    return <Modal open={Boolean(request)} title={diagnostic ? "Dola 账号页面诊断" : ageConfirmation ? "确认 Dola 账号年龄" : "完成 Dola 页面验证"} centered width={760} onCancel={() => void close()} footer={<div className="flex justify-end gap-2"><Button onClick={() => void close()}>{admin ? "关闭会话" : "取消任务"}</Button><Button type="primary" loading={busy} disabled={!snapshot?.leaseToken} onClick={() => void resume()}>{diagnostic ? "已处理，重新检测" : ageConfirmation ? "已人工确认，继续生成" : "处理完成，继续生成"}</Button></div>}>
        {loading ? <div className="flex min-h-56 items-center justify-center"><Spin tip="正在打开该账号的实际页面…" /></div> : snapshot?.screenshotBase64 ? <div className="space-y-3"><Alert type={diagnostic ? "info" : "warning"} showIcon message={diagnostic ? `当前页面状态：${diagnosticState}` : ageConfirmation ? "Dola 要求账号持有人确认已满 18 周岁" : snapshot.decision?.subtype === "slide" ? "已检测到滑块，请在截图中拖动完成验证" : "请按上游页面的实际提示完成验证"} description={ageConfirmation ? `${snapshot.pageUrl ? `页面：${snapshot.pageUrl}。` : ""}请仅在信息属实时点击截图中的“确认”；系统不会自动代替账号持有人作年龄声明。` : `${snapshot.pageUrl ? `页面：${snapshot.pageUrl}。` : ""}操作直接发送到当前 Camoufox 页面；系统只在检测到结构化挑战数据或真实验证页面时标记安全验证。`} /><div className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-2 dark:border-zinc-700"><img ref={imageRef} src={`data:image/png;base64,${snapshot.screenshotBase64}`} alt="Dola 账号实际页面" className="mx-auto block max-h-[60vh] max-w-full select-none touch-none" draggable={false} onPointerDown={(event) => { const point = pointForEvent(event); if (!point) return; pointerDownRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); void sendInput("down", point); }} onPointerMove={(event) => { if (!pointerDownRef.current) return; const point = pointForEvent(event); if (point) void sendInput("move", point); }} onPointerUp={(event) => { if (!pointerDownRef.current) return; const point = pointForEvent(event); pointerDownRef.current = false; if (point) void sendInput("up", point); }} onPointerCancel={() => { pointerDownRef.current = false; }} /></div></div> : <Alert type="error" showIcon message="账号页面截图不可用" description="请关闭会话后在管理后台重新检查 Cookie 或代理出口。" />}
    </Modal>;
}

function verificationPath(request: VerificationRequest, action: "open" | "input" | "resume" | "close", admin: boolean) {
    return admin
        ? `/api/admin/dola/verifications/${encodeURIComponent(request.verificationId)}/${action}`
        : `/api/video-tasks/${encodeURIComponent(request.taskId)}/verification/${action}`;
}

type VerificationPayload = Record<string, unknown>;

async function readVerificationPayload(response: Response): Promise<VerificationPayload | null> {
    const body = await response.json().catch(() => null) as VerificationPayload | null;
    if (body && body.code === 0 && body.data && typeof body.data === "object") return body.data as VerificationPayload;
    return body;
}

function errorMessage(payload: VerificationPayload | null, fallback: string) {
    return typeof payload?.error === "string" ? payload.error : typeof payload?.msg === "string" ? payload.msg : typeof payload?.detail === "string" ? payload.detail : fallback;
}

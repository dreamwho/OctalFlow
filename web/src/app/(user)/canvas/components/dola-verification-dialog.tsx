"use client";

import { Alert, Button, Input, Modal, Space, Spin, message } from "antd";
import { useEffect, useRef, useState } from "react";

import type { CanvasDolaVerification } from "../[id]/use-canvas-page-state";

type Snapshot = { verificationId: string; taskId: string; status: string; pageState?: string; pageUrl?: string; decision?: { type?: string; subtype?: string; pageState?: string }; viewport: { width: number; height: number }; screenshotBase64: string; leaseToken?: string };
type VerificationRequest = { taskId: string; verificationId: string };

export function DolaVerificationDialog({ request, onClose, onResolved, admin = false, headedTest = false }: { request: CanvasDolaVerification | VerificationRequest | null; onClose: () => void; onResolved: () => void; admin?: boolean; headedTest?: boolean }) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [typedText, setTypedText] = useState("");
    const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
    const [finishSaved, setFinishSaved] = useState(false);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const pointerDownRef = useRef(false);
    const pointerQueueRef = useRef<Promise<void>>(Promise.resolve());
    const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => {
        if (!request) { setSnapshot(null); setFinishSaved(false); setFinishConfirmOpen(false); return; }
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

    const sendInput = async (action: "down" | "move" | "up" | "wheel", point: { x: number; y: number; deltaY?: number }) => {
        if (!snapshot?.leaseToken || !request) return;
        if (busy && action === "move") { pendingMoveRef.current = point; return; }
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "input", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken, action, x: point.x, y: point.y, ...(action === "wheel" ? { deltaY: point.deltaY } : {}) }) });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "页面操作失败"));
            setSnapshot((current) => current ? { ...current, ...payload, leaseToken: current.leaseToken } : current);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "页面操作失败");
        } finally {
            setBusy(false);
            const pending = pendingMoveRef.current;
            pendingMoveRef.current = null;
            if (pending && pointerDownRef.current) queueInput("move", pending);
        }
    };
    const queueInput = (action: "down" | "move" | "up" | "wheel", point: { x: number; y: number; deltaY?: number }) => {
        pointerQueueRef.current = pointerQueueRef.current.then(() => sendInput(action, point));
    };

    const pointForEvent = (event: { clientX: number; clientY: number }) => {
        const rect = imageRef.current?.getBoundingClientRect();
        if (!rect || !snapshot) return null;
        return { x: Math.max(0, Math.min(snapshot.viewport.width, (event.clientX - rect.left) * snapshot.viewport.width / rect.width)), y: Math.max(0, Math.min(snapshot.viewport.height, (event.clientY - rect.top) * snapshot.viewport.height / rect.height)) };
    };
    const close = async () => {
        if (!snapshot?.leaseToken || !request) return;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "close", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken }) });
            if (!response.ok) throw new Error(errorMessage(await readVerificationPayload(response), "关闭浏览器失败"));
            setFinishConfirmOpen(false);
            if (finishSaved) onResolved(); else onClose();
        } catch (error) { message.error(error instanceof Error ? error.message : "关闭浏览器失败"); } finally { setBusy(false); }
    };
    const finalize = async () => {
        if (!snapshot?.leaseToken || !request) return;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "finalize", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken }) });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "保存账号 Cookie 失败"));
            if (payload?.status === "saved") {
                setFinishConfirmOpen(false);
                if (payload.windowClosed) { message.success(payload.changed ? "登录有效，新 Cookie 已保存到当前账号" : "登录有效，当前 Cookie 无变化"); onResolved(); }
                else { setFinishSaved(true); message.warning("Cookie 已保存，但浏览器未能自动关闭；请手动关闭测试窗口"); }
                return;
            }
            message.warning(payload?.status === "needs_login" ? "该浏览器当前未登录，不会覆盖原 Cookie；可继续操作或不保存关闭" : "尚未确认登录状态，未保存 Cookie；请检查页面后重试");
            setFinishConfirmOpen(false);
            void refresh();
        } catch (error) { message.error(error instanceof Error ? error.message : "保存账号 Cookie 失败"); } finally { setBusy(false); }
    };
    const refresh = async () => {
        if (!request) return;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "open", admin), { method: "POST" });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "刷新页面画面失败"));
            setSnapshot(payload as Snapshot);
        } catch (error) { message.error(error instanceof Error ? error.message : "刷新页面画面失败"); } finally { setBusy(false); }
    };
    const keyboard = async (text: string) => {
        if (!snapshot?.leaseToken || !request || !text) return;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "keyboard", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken, text }) });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "页面键盘操作失败"));
            setSnapshot((current) => current ? { ...current, ...payload, leaseToken: current.leaseToken } : current);
            setTypedText("");
        } catch (error) { message.error(error instanceof Error ? error.message : "页面键盘操作失败"); } finally { setBusy(false); }
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
    return <><Modal open={Boolean(request)} title={headedTest ? "Dola 有头测试" : diagnostic ? "Dola 账号页面诊断" : ageConfirmation ? "确认 Dola 账号年龄" : "完成 Dola 页面验证"} centered width={760} maskClosable={false} keyboard={!headedTest} onCancel={() => headedTest && !finishSaved ? setFinishConfirmOpen(true) : void close()} footer={<div className="flex justify-end gap-2">{headedTest ? <Button loading={busy} onClick={() => void refresh()}>刷新画面</Button> : null}<Button loading={busy} disabled={!snapshot?.leaseToken} onClick={() => headedTest && !finishSaved ? setFinishConfirmOpen(true) : void close()}>{headedTest ? finishSaved ? "关闭浏览器（Cookie 已保存）" : "结束测试" : admin ? "关闭会话" : "取消任务"}</Button><Button type="primary" loading={busy} disabled={!snapshot?.leaseToken || finishSaved} onClick={() => headedTest ? void finalize() : void resume()}>{headedTest ? "检测登录并保存 Cookie" : diagnostic ? "已处理，重新检测" : ageConfirmation ? "已人工确认，继续生成" : "处理完成，继续生成"}</Button></div>}>
        {loading ? <div className="flex min-h-56 items-center justify-center"><Spin tip="正在打开该账号的实际页面…" /></div> : snapshot?.screenshotBase64 ? <div className="space-y-3"><Alert type={diagnostic || headedTest ? "info" : "warning"} showIcon message={headedTest ? "独立账号环境已打开，浏览器由管理员手动关闭" : diagnostic ? `当前页面状态：${diagnosticState}` : ageConfirmation ? "Dola 要求账号持有人确认已满 18 周岁" : snapshot.decision?.subtype === "slide" ? "已检测到滑块，请在截图中拖动完成验证" : "请按上游页面的实际提示完成验证"} description={headedTest ? `页面：${snapshot.pageUrl || "Dola"}。本机可直接操作窗口；远程管理可点击截图、输入文字并刷新画面。` : ageConfirmation ? `${snapshot.pageUrl ? `页面：${snapshot.pageUrl}。` : ""}请仅在信息属实时点击截图中的“确认”；系统不会自动代替账号持有人作年龄声明。` : `${snapshot.pageUrl ? `页面：${snapshot.pageUrl}。` : ""}操作直接发送到当前 Camoufox 页面；系统只在检测到结构化挑战数据或真实验证页面时标记安全验证。`} /><div className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-2 dark:border-zinc-700"><img ref={imageRef} src={`data:image/png;base64,${snapshot.screenshotBase64}`} alt="Dola 账号实际页面" className="mx-auto block max-h-[60vh] max-w-full select-none touch-none" draggable={false} onPointerDown={(event) => { const point = pointForEvent(event); if (!point) return; pointerDownRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); queueInput("down", point); }} onPointerMove={(event) => { if (!pointerDownRef.current) return; const point = pointForEvent(event); if (point) queueInput("move", point); }} onPointerUp={(event) => { if (!pointerDownRef.current) return; const point = pointForEvent(event); pointerDownRef.current = false; if (point) queueInput("up", point); }} onPointerCancel={() => { pointerDownRef.current = false; }} onWheel={(event) => { if (!headedTest) return; const point = pointForEvent(event); if (point) queueInput("wheel", { ...point, deltaY: event.deltaY }); }} /></div>{headedTest ? <Space.Compact className="w-full"><Input value={typedText} maxLength={500} placeholder="发送文字到浏览器当前焦点（不会写入请求日志）" onChange={(event) => setTypedText(event.target.value)} onPressEnter={() => void keyboard(typedText)} /><Button disabled={!typedText || busy} onClick={() => void keyboard(typedText)}>输入</Button></Space.Compact> : null}{headedTest ? <Space wrap>{(["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown"] as const).map((key) => <Button key={key} size="small" disabled={busy} onClick={() => void keyboard(key)}>{key}</Button>)}</Space> : null}</div> : <Alert type="error" showIcon message="账号页面截图不可用" description="请刷新画面，或关闭会话后检查 Cookie 与代理出口。" />}
    </Modal>{headedTest ? <Modal title="结束有头测试" open={finishConfirmOpen} onCancel={() => setFinishConfirmOpen(false)} footer={<Space><Button onClick={() => setFinishConfirmOpen(false)}>继续测试</Button><Button loading={busy} onClick={() => void close()}>不保存，关闭浏览器</Button><Button type="primary" loading={busy} onClick={() => void finalize()}>检测登录并保存 Cookie</Button></Space>}>如果当前浏览器已正常登录，可以先检测登录状态并把更新后的 Cookie 保存到此账号；检测未通过时保留浏览器，不会覆盖原 Cookie。请在关闭原生浏览器窗口前完成保存；直接关闭原生窗口后可能无法读取 Cookie。</Modal> : null}</>;
}

function verificationPath(request: VerificationRequest, action: "open" | "input" | "keyboard" | "finalize" | "resume" | "close", admin: boolean) {
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

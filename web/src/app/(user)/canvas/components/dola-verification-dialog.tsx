"use client";

import { Alert, Button, Input, Modal, Space, Spin, message } from "antd";
import { useEffect, useRef, useState } from "react";

import type { CanvasDolaVerification } from "../[id]/use-canvas-page-state";

type Snapshot = { verificationId: string; taskId: string; status: string; pageState?: string; pageUrl?: string; screenshotError?: string; decision?: { type?: string; subtype?: string; pageState?: string }; viewport: { width: number; height: number }; screenshotBase64: string; leaseToken?: string };
type VerificationRequest = { taskId: string; verificationId: string; leaseToken?: string };

export function DolaVerificationDialog({ request, onClose, onResolved, admin = false, headedTest = false, googleLogin = false, googleAccountName = "" }: { request: CanvasDolaVerification | VerificationRequest | null; onClose: () => void; onResolved: () => void; admin?: boolean; headedTest?: boolean; googleLogin?: boolean; googleAccountName?: string }) {
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
    const moveQueuedRef = useRef(false);
    const pendingWheelRef = useRef<{ x: number; y: number; deltaY: number } | null>(null);
    const wheelQueuedRef = useRef(false);
    const leaseRef = useRef("");
    const closedRef = useRef(false);
    const closingRef = useRef(false);

    useEffect(() => {
        if (!googleLogin || !request) return;
        const path = verificationPath(request, "close", admin);
        const release = () => {
            if (closedRef.current || !leaseRef.current) return;
            closedRef.current = true;
            void fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: leaseRef.current }), keepalive: true }).catch(() => undefined);
        };
        window.addEventListener("pagehide", release);
        return () => { window.removeEventListener("pagehide", release); release(); };
    }, [admin, googleLogin, request]);

    useEffect(() => {
        if (!request) { setSnapshot(null); setFinishSaved(false); setFinishConfirmOpen(false); return; }
        let cancelled = false;
        leaseRef.current = "leaseToken" in request ? request.leaseToken || "" : "";
        closedRef.current = false;
        setLoading(true);
        fetch(verificationPath(request, "open", admin), { method: "POST", cache: "no-store" })
            .then(async (response) => {
                const payload = await readVerificationPayload(response);
                if (!response.ok) throw new Error(errorMessage(payload, "无法打开 Dola 验证窗口"));
                if (!cancelled) { leaseRef.current = typeof payload?.leaseToken === "string" ? payload.leaseToken : ""; closedRef.current = false; setSnapshot(payload as Snapshot); }
            })
            .catch((error) => { if (!cancelled) { message.error(error instanceof Error ? error.message : "无法打开 Dola 验证窗口"); closedRef.current = true; onClose(); } })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [admin, onClose, request]);

    const sendInput = async (action: "down" | "move" | "up" | "wheel", point: { x: number; y: number; deltaY?: number }) => {
        if (!snapshot?.leaseToken || !request || closedRef.current) return;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "input", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken, action, x: point.x, y: point.y, ...(action === "wheel" ? { deltaY: point.deltaY } : {}) }) });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "页面操作失败"));
            setSnapshot((current) => current ? { ...current, ...payload, leaseToken: current.leaseToken } : current);
        } catch (error) {
            const detail = error instanceof Error ? error.message : "页面操作失败";
            if (detail.includes("verification_not_found")) { closedRef.current = true; message.warning("授权会话已结束，请重新打开浏览器"); onClose(); }
            else message.error(detail);
        } finally {
            setBusy(false);
        }
    };
    const queueInput = (action: "down" | "move" | "up" | "wheel", point: { x: number; y: number; deltaY?: number }) => {
        if (action === "move") {
            pendingMoveRef.current = point;
            if (moveQueuedRef.current) return;
            moveQueuedRef.current = true;
            pointerQueueRef.current = pointerQueueRef.current.then(async () => {
                while (pointerDownRef.current && pendingMoveRef.current) {
                    const latest = pendingMoveRef.current;
                    pendingMoveRef.current = null;
                    await sendInput("move", latest);
                }
                moveQueuedRef.current = false;
            });
            return;
        }
        if (action === "wheel") {
            const previous = pendingWheelRef.current;
            pendingWheelRef.current = { x: point.x, y: point.y, deltaY: (previous?.deltaY || 0) + (point.deltaY || 0) };
            if (wheelQueuedRef.current) return;
            wheelQueuedRef.current = true;
            pointerQueueRef.current = pointerQueueRef.current.then(async () => {
                while (pendingWheelRef.current) {
                    const latest = pendingWheelRef.current;
                    pendingWheelRef.current = null;
                    await sendInput("wheel", latest);
                }
                wheelQueuedRef.current = false;
            });
            return;
        }
        if (action === "up") pendingMoveRef.current = null;
        pointerQueueRef.current = pointerQueueRef.current.then(() => sendInput(action, point));
    };

    const pointForEvent = (event: { clientX: number; clientY: number }) => {
        const rect = imageRef.current?.getBoundingClientRect();
        if (!rect || !snapshot) return null;
        return { x: Math.max(0, Math.min(snapshot.viewport.width, (event.clientX - rect.left) * snapshot.viewport.width / rect.width)), y: Math.max(0, Math.min(snapshot.viewport.height, (event.clientY - rect.top) * snapshot.viewport.height / rect.height)) };
    };
    const close = async () => {
        if (!request || closingRef.current) return;
        const leaseToken = snapshot?.leaseToken || ("leaseToken" in request ? request.leaseToken : undefined);
        if (!leaseToken || closedRef.current) { closedRef.current = true; onClose(); return; }
        closingRef.current = true;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, "close", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken }) });
            if (!response.ok && response.status !== 404) throw new Error(errorMessage(await readVerificationPayload(response), "关闭浏览器失败"));
            closedRef.current = true;
            setFinishConfirmOpen(false);
            if (finishSaved) onResolved(); else onClose();
        } catch (error) { message.error(error instanceof Error ? error.message : "关闭浏览器失败"); } finally { closingRef.current = false; setBusy(false); }
    };
    const finalize = async () => {
        if (!snapshot?.leaseToken || !request) return;
        setBusy(true);
        try {
            const response = await fetch(verificationPath(request, googleLogin ? "google-finalize" : "finalize", admin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: snapshot.leaseToken, ...(googleLogin && googleAccountName ? { name: googleAccountName } : {}) }) });
            const payload = await readVerificationPayload(response);
            if (!response.ok) throw new Error(errorMessage(payload, "保存账号 Cookie 失败"));
            if (payload?.status === "saved") {
                setFinishConfirmOpen(false);
                if (payload.windowClosed) { closedRef.current = true; message.success(googleLogin ? "Google 授权账号已保存，浏览器已关闭" : payload.changed ? "登录有效，新 Cookie 已保存到当前账号" : "登录有效，当前 Cookie 无变化"); onResolved(); }
                else { setFinishSaved(true); message.warning("账号已保存，但浏览器未能自动关闭；请点击关闭浏览器"); }
                return;
            }
            message.warning(payload?.status === "needs_login" ? googleLogin ? "Dola 登录尚未完成，请继续登录后再次检测" : "该浏览器当前未登录，不会覆盖原 Cookie；可继续操作或不保存关闭" : "尚未确认登录状态，未保存 Cookie；请检查页面后重试");
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
    return <><Modal open={Boolean(request)} title={googleLogin ? "Dola Google 远程授权" : headedTest ? "Dola 有头测试" : diagnostic ? "Dola 账号页面诊断" : ageConfirmation ? "确认 Dola 账号年龄" : "完成 Dola 页面验证"} centered width={googleLogin ? "min(760px, calc(100vw - 24px))" : 760} maskClosable={false} keyboard={!headedTest} onCancel={() => headedTest && !finishSaved ? setFinishConfirmOpen(true) : void close()} footer={<div className="flex flex-wrap justify-end gap-2">{headedTest ? <Button loading={busy} onClick={() => void refresh()}>刷新画面</Button> : null}<Button loading={busy} disabled={!snapshot?.leaseToken} onClick={() => headedTest && !finishSaved ? setFinishConfirmOpen(true) : void close()}>{googleLogin ? finishSaved ? "关闭浏览器（账号已保存）" : "取消授权" : headedTest ? finishSaved ? "关闭浏览器（Cookie 已保存）" : "结束测试" : admin ? "关闭会话" : "取消任务"}</Button><Button type="primary" loading={busy} disabled={!snapshot?.leaseToken || finishSaved} onClick={() => headedTest ? void finalize() : void resume()}>{googleLogin ? "检测登录并保存账号" : headedTest ? "检测登录并保存 Cookie" : diagnostic ? "已处理，重新检测" : ageConfirmation ? "已人工确认，继续生成" : "处理完成，继续生成"}</Button></div>}>
                {loading ? <div className="flex min-h-56 items-center justify-center"><Spin tip="正在打开该账号的实际页面…" /></div> : snapshot?.screenshotBase64 ? <div className="space-y-3"><Alert type={diagnostic || headedTest ? "info" : "warning"} showIcon message={googleLogin ? "请在画面中完成 Google 与 Dola 登录" : headedTest ? "独立账号环境已打开，浏览器由管理员手动关闭" : diagnostic ? `当前页面状态：${diagnosticState}` : ageConfirmation ? "Dola 要求账号持有人确认已满 18 周岁" : snapshot.decision?.subtype === "slide" ? "已检测到滑块，请在截图中拖动完成验证" : "请按上游页面的实际提示完成验证"} description={googleLogin ? `页面：${snapshot.pageUrl || "Dola"}。点击画面、粘贴或输入文字；完成登录后点击「检测登录并保存账号」。` : headedTest ? `页面：${snapshot.pageUrl || "Dola"}。本机可直接操作窗口；远程管理可点击截图、输入文字并刷新画面。` : ageConfirmation ? `${snapshot.pageUrl ? `页面：${snapshot.pageUrl}。` : ""}请仅在信息属实时点击截图中的“确认”；系统不会自动代替账号持有人作年龄声明。` : `${snapshot.pageUrl ? `页面：${snapshot.pageUrl}。` : ""}操作直接发送到当前 Camoufox 页面；系统只在检测到结构化挑战数据或真实验证页面时标记安全验证。`} /><div className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-2 dark:border-zinc-700" role="application" aria-label="Dola 远程浏览器画面，可粘贴文字" tabIndex={0} onPaste={(event) => { if (!headedTest) return; const text = event.clipboardData.getData("text/plain"); if (!text) return; event.preventDefault(); if (text.length > 500) { message.warning("一次最多粘贴 500 个字符"); return; } void keyboard(text); }} onKeyDown={(event) => { if (!headedTest || !["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); void keyboard(event.key); }}><img ref={imageRef} src={`data:image/png;base64,${snapshot.screenshotBase64}`} alt="Dola 账号实际页面" className="mx-auto block max-h-[60vh] max-w-full select-none touch-none" draggable={false} onPointerDown={(event) => { const point = pointForEvent(event); if (!point) return; event.currentTarget.parentElement?.focus(); event.currentTarget.setPointerCapture(event.pointerId); queueInput("down", point); pointerDownRef.current = true; }} onPointerMove={(event) => { if (!pointerDownRef.current) return; const point = pointForEvent(event); if (point) queueInput("move", point); }} onPointerUp={(event) => { if (!pointerDownRef.current) return; const point = pointForEvent(event); pointerDownRef.current = false; if (point) queueInput("up", point); }} onPointerCancel={() => { pointerDownRef.current = false; }} onWheel={(event) => { if (!headedTest) return; const point = pointForEvent(event); if (point) queueInput("wheel", { ...point, deltaY: event.deltaY }); }} /></div>{headedTest ? <Space.Compact className="w-full"><Input value={typedText} maxLength={500} placeholder="粘贴或输入文字，再发送到浏览器当前焦点" onChange={(event) => setTypedText(event.target.value)} onPressEnter={() => void keyboard(typedText)} /><Button disabled={!typedText || busy} onClick={() => void keyboard(typedText)}>发送文字</Button></Space.Compact> : null}{headedTest ? <Space wrap>{(["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown"] as const).map((key) => <Button key={key} size="small" disabled={busy} onClick={() => void keyboard(key)}>{key}</Button>)}</Space> : null}</div> : <Alert type="error" showIcon message="账号页面截图不可用" description={snapshot?.screenshotError || "请刷新画面，或关闭会话后检查 Cookie 与代理出口。"} />}
    </Modal>{headedTest ? <Modal title={googleLogin ? "结束 Google 授权" : "结束有头测试"} open={finishConfirmOpen} onCancel={() => setFinishConfirmOpen(false)} footer={<Space><Button onClick={() => setFinishConfirmOpen(false)}>{googleLogin ? "继续授权" : "继续测试"}</Button><Button loading={busy} onClick={() => void close()}>不保存，关闭浏览器</Button><Button type="primary" loading={busy} onClick={() => void finalize()}>{googleLogin ? "检测登录并保存账号" : "检测登录并保存 Cookie"}</Button></Space>}>{googleLogin ? "未完成登录时可以继续操作；取消授权会立即关闭服务器上的浏览器并释放资源。" : "如果当前浏览器已正常登录，可以先检测登录状态并把更新后的 Cookie 保存到此账号；检测未通过时保留浏览器，不会覆盖原 Cookie。请在关闭原生浏览器窗口前完成保存；直接关闭原生窗口后可能无法读取 Cookie。"}</Modal> : null}</>;
}

function verificationPath(request: VerificationRequest, action: "open" | "input" | "keyboard" | "finalize" | "google-finalize" | "resume" | "close", admin: boolean) {
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

"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal } from "antd";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { nanoid } from "nanoid";

import { AuthForm } from "@/components/auth/auth-form";
import { BillingPlansModal } from "@/components/billing/billing-plans-modal";
import { X } from "lucide-react";
import { SiteLogo } from "@/components/layout/site-logo";
import { createAgentPromptHref, type CreateAgentMode } from "@/lib/create-agent-prompt";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { useUserStore } from "@/stores/use-user-store";
import type { HomeSiteSettings } from "./home-data";
import { resolveSiteBrandName, resolveSiteTitle } from "@/lib/site-brand";
import { createCanvasProject } from "@/services/api/canvas-projects";
import { CanvasNodeType } from "@/app/(user)/canvas/types";

export type HomeCreateGenerateParams = {
    prompt: string;
    type: "image" | "video";
    modelIds?: string[];
    skillIds?: string[];
    aspectRatio?: string;
    duration?: string;
};

type HomeActions = {
    authenticated: boolean;
    sessionReady: boolean;
    site: HomeSiteSettings;
    openLogin: (nextPath?: string) => void;
    openBillingPlans: () => void;
    openProtectedPath: (path: string) => void;
    startCreating: (prompt?: string, mode?: CreateAgentMode, options?: { skillIds?: string[]; modelIds?: string[] }) => void;
    createCanvasAndGenerate: (params: HomeCreateGenerateParams) => Promise<void>;
};

const HomeActionsContext = createContext<HomeActions | null>(null);

export function HomeActionsProvider({ initialSite, children }: { initialSite: HomeSiteSettings; children: ReactNode }) {
    const router = useRouter();
    const [authOpen, setAuthOpen] = useState(false);
    const [authNextPath, setAuthNextPath] = useState("/canvas");
    const [methodOverride, setMethodOverride] = useState<"password" | "wechat" | null>(null);
    const [billingPlansOpen, setBillingPlansOpen] = useState(false);
    const user = useUserStore((state) => state.user);
    const session = usePublicSessionStore((state) => state.payload);
    const sessionReady = usePublicSessionStore((state) => state.ready);
    const sessionSite = session?.settings?.site;
    const sessionLoginMethods = session?.settings?.loginMethods;
    const loginMethods = useMemo(() => sessionLoginMethods || { password: true, wechat: false, defaultMethod: "password" as const }, [sessionLoginMethods]);
    const passwordEnabled = loginMethods.password !== false;
    const wechatEnabled = loginMethods.wechat === true;
    const site = useMemo<HomeSiteSettings>(
        () => ({
            ...initialSite,
            ...(sessionSite || {}),
            title: resolveSiteTitle(sessionSite?.title || initialSite.title),
            logoUrl: sessionSite?.logoUrl?.trim() || initialSite.logoUrl || "/brand/dreamyo/mark.png",
            friendLinks: sessionSite?.friendLinks || initialSite.friendLinks,
            socials: (sessionSite?.socials as HomeSiteSettings["socials"] | undefined) || initialSite.socials,
            announcementBar: (sessionSite as HomeSiteSettings | undefined)?.announcementBar || initialSite.announcementBar,
        }),
        [initialSite, sessionSite],
    );
    const authenticated = sessionReady && Boolean(user);

    const openLogin = (nextPath = "/canvas") => {
        setAuthNextPath(nextPath);
        setMethodOverride(null);
        setAuthOpen(true);
    };
    const openProtectedPath = (path: string) => {
        if (authenticated) router.push(path);
        else openLogin(path);
    };
    const startCreating = (prompt = "", mode: CreateAgentMode = "agent", options: { skillIds?: string[]; modelIds?: string[] } = {}) =>
        openProtectedPath(createAgentPromptHref(prompt, { source: "home", mode, skillIds: options.skillIds, modelIds: options.modelIds }));

    const createCanvasAndGenerate = async (params: HomeCreateGenerateParams) => {
        if (!authenticated) {
            openLogin("/canvas");
            return;
        }

        const nodeId = `node-${nanoid(8)}`;
        const isVideo = params.type === "video";
        const title = (params.prompt || (isVideo ? "视频生成" : "图片生成")).slice(0, 30);

        let width = isVideo ? 420 : 340;
        let height = isVideo ? 236 : 240;
        if (params.aspectRatio === "9:16") {
            width = isVideo ? 236 : 240;
            height = isVideo ? 420 : 340;
        } else if (params.aspectRatio === "16:9") {
            width = isVideo ? 420 : 340;
            height = isVideo ? 236 : 240;
        } else if (params.aspectRatio === "1:1") {
            width = 300;
            height = 300;
        }

        const node = {
            id: nodeId,
            type: isVideo ? CanvasNodeType.Video : CanvasNodeType.Image,
            title: isVideo ? "视频生成" : "图片生成",
            position: { x: 300, y: 200 },
            width,
            height,
            metadata: {
                prompt: params.prompt,
                model: params.modelIds?.[0] || "",
                selectedSkillIds: params.skillIds?.length ? params.skillIds : undefined,
                size: params.aspectRatio || "1:1",
                seconds: params.duration || "5",
                status: "idle",
            },
        };

        const res = await createCanvasProject({
            title: title || "新创意画布",
            project: {
                nodes: [node as any],
            },
        });

        if (res?.id) {
            router.push(`/canvas/${res.id}?autoGenerate=${nodeId}`);
        }
    };

    return (
        <HomeActionsContext.Provider value={{ authenticated, sessionReady, site, openLogin, openBillingPlans: () => setBillingPlansOpen(true), openProtectedPath, startCreating, createCanvasAndGenerate }}>
            {children}
            <Modal
                centered
                open={authOpen}
                width={590}
                footer={null}
                title={null}
                closable={false}
                destroyOnHidden
                onCancel={() => setAuthOpen(false)}
                className="landing-auth-modal landing-auth-jiaotu"
                styles={{ body: { padding: 0 } }}
            >
                <div className="landing-auth-jiaotu-hero">
                    <button type="button" className="landing-auth-jiaotu-close" aria-label="关闭登录弹窗" onClick={() => setAuthOpen(false)}>
                        <X aria-hidden="true" className="size-4" />
                    </button>
                    <img src="/brand/dreamyo/pure-mark.png" alt="" className="landing-auth-jiaotu-mark" />
                    <p className="landing-auth-jiaotu-title">登录 {resolveSiteBrandName(site.title)}</p>
                </div>
                <div className="landing-auth-jiaotu-body">
                    {passwordEnabled && (methodOverride || loginMethods.defaultMethod) !== "wechat" ? (
                        <>
                            <AuthForm mode="login" variant="embedded" submitLabel="登录" nextPath={authNextPath} className="min-h-0 bg-transparent p-0 shadow-none" />
                            {wechatEnabled ? (
                                <button type="button" className="landing-auth-wechat-pill" onClick={() => setMethodOverride("wechat")}>
                                    <WechatGlyph className="size-4.5" />
                                    <span>微信登录</span>
                                </button>
                            ) : null}
                        </>
                    ) : wechatEnabled ? (
                        <WechatLoginPanel onBack={passwordEnabled ? () => setMethodOverride("password") : undefined} />
                    ) : passwordEnabled ? (
                        <AuthForm mode="login" variant="embedded" submitLabel="登录" nextPath={authNextPath} className="min-h-0 bg-transparent p-0 shadow-none" />
                    ) : null}
                    <p className="landing-auth-jiaotu-legal">
                        登录即代表同意
                        <Link href={site.termsUrl || "/terms"} className="landing-auth-jiaotu-link">服务条款</Link>
                        和
                        <Link href={site.privacyUrl || "/privacy"} className="landing-auth-jiaotu-link">隐私政策</Link>
                    </p>
                </div>
            </Modal>
                        <BillingPlansModal open={billingPlansOpen} onClose={() => setBillingPlansOpen(false)} onSelect={(product) => openProtectedPath(`/billing/checkout?product=${encodeURIComponent(product.id)}`)} />
        </HomeActionsContext.Provider>
    );
}

export function useHomeActions() {
    const value = useContext(HomeActionsContext);
    if (!value) throw new Error("useHomeActions must be used within HomeActionsProvider");
    return value;
}

function WechatGlyph({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
            <path d="M9.34 4.5c-3.6 0-6.5 2.4-6.5 5.36 0 1.71.93 3.24 2.38 4.24l-.6 1.8 2.09-1.05c.6.17 1.23.28 1.9.3a4.9 4.9 0 0 1-.13-1.1c0-2.94 2.77-5.32 6.2-5.32.22 0 .44.01.66.03-.6-2.44-3.1-4.26-6-4.26Zm-2.2 2.36a.77.77 0 1 1 0 1.54.77.77 0 0 1 0-1.54Zm4.44 0a.77.77 0 1 1 0 1.54.77.77 0 0 1 0-1.54Z" />
            <path d="M21.16 13.9c0-2.5-2.5-4.53-5.58-4.53s-5.58 2.03-5.58 4.53 2.5 4.53 5.58 4.53c.62 0 1.21-.08 1.77-.24l1.86.93-.53-1.58c1.5-.83 2.48-2.15 2.48-3.64Zm-7.5-.9a.68.68 0 1 1 0-1.36.68.68 0 0 1 0 1.36Zm3.84 0a.68.68 0 1 1 0-1.36.68.68 0 0 1 0 1.36Z" />
        </svg>
    );
}

function WechatLoginPanel({ onBack }: { onBack?: () => void }) {
    const [state, setState] = useState<{ status: "loading" | "ready" | "error"; url?: string; message?: string }>({ status: "loading" });
    useEffect(() => {
        let alive = true;
        fetch("/api/auth/wechat/qrcode")
            .then(async (response) => ({ ok: response.ok, ...(await response.json().catch(() => ({}))) }))
            .then((payload: { ok?: boolean; data?: { qrconnectUrl?: string }; msg?: string }) => {
                if (!alive) return;
                const url = payload.data?.qrconnectUrl;
                if (payload.ok && url) setState({ status: "ready", url });
                else setState({ status: "error", message: payload.msg || "微信登录暂时不可用" });
            })
            .catch(() => {
                if (alive) setState({ status: "error", message: "微信登录暂时不可用" });
            });
        return () => {
            alive = false;
        };
    }, []);
    return (
        <div className="landing-auth-wechat-panel">
            <p className="landing-auth-wechat-title">微信扫码登录</p>
            <div className="landing-auth-wechat-qr">
                {state.status === "loading" ? <span className="landing-auth-wechat-state">正在获取二维码…</span> : null}
                {state.status === "ready" && state.url ? <iframe src={state.url} title="微信登录二维码" frameBorder="0" /> : null}
                {state.status === "error" ? <span className="landing-auth-wechat-state landing-auth-wechat-error">{state.message}</span> : null}
            </div>
            <p className="landing-auth-wechat-tip">请使用微信扫一扫登录</p>
            {onBack ? (
                <button type="button" className="landing-auth-wechat-back" onClick={onBack}>
                    使用账号密码登录
                </button>
            ) : null}
        </div>
    );
}

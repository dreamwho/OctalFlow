"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App } from "antd";
import { ArrowRight, BookOpen, ChevronDown, CircleHelp, Gift, History, LogOut, Megaphone, Menu, Search, ShoppingBag, User, UserCog, X } from "lucide-react";

import { SiteLogo } from "@/components/layout/site-logo";
import { SiteWordmark } from "@/components/layout/site-wordmark";
import { AccountActionsCluster } from "@/components/layout/account-actions-cluster";
import { CreditSymbol, formatCreditAmount } from "@/constant/credits";
import { resetClientSessionState } from "@/lib/client-session-reset";
import { useUserStore } from "@/stores/use-user-store";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { HOME_NAVIGATION, type HomeNavigationItem } from "./home-data";
import { useHomeActions } from "./home-actions";
import styles from "./home.module.css";

export function HomeHeader() {
    const [mobileOpen, setMobileOpen] = useState(false);
    const [announcementDismissed, setAnnouncementDismissed] = useState(true);
    const [accountOpen, setAccountOpen] = useState(false);
    const [accountAnchor, setAccountAnchor] = useState<DOMRect | null>(null);
    const router = useRouter();
    const { message } = App.useApp();
    const { authenticated, site, openLogin, openBillingPlans, openProtectedPath } = useHomeActions();
    const storeUser = useUserStore((state) => state.user);
    const adminLocal = usePublicSessionStore((state) => state.payload?.desktop?.edition === "admin");
    const announcement = site.announcementBar;
    const announcementVisible = announcement?.enabled === true && Boolean(announcement.text?.trim()) && !announcementDismissed;
    const accountId = String(storeUser?.accountId || "").padStart(4, "0");

    useEffect(() => {
        setAnnouncementDismissed(window.localStorage.getItem("dreamyo-announcement-dismissed") === (announcement?.text || ""));
    }, [announcement?.text]);

    const dismissAnnouncement = () => {
        setAnnouncementDismissed(true);
        window.localStorage.setItem("dreamyo-announcement-dismissed", announcement?.text || "");
    };

    const activate = (item: HomeNavigationItem) => {
        setMobileOpen(false);
        if (item.action === "billing") openBillingPlans();
        if (item.action === "protected") openProtectedPath(item.href);
    };


    const handleLogout = async () => {
        setAccountOpen(false);
        try {
            await fetch("/api/auth/logout", { method: "POST" });
            await resetClientSessionState();
            router.replace("/");
            router.refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "退出登录失败");
        }
    };


    const barContent = announcementVisible ? (
        <div className={styles.announcementBar} role="region" aria-label="站点公告">
            {announcement?.href?.trim() ? (
                <a href={announcement.href} className={styles.announcementLink} target={announcement.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                    <Megaphone className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{announcement.text}</span>
                </a>
            ) : (
                <span className={styles.announcementLink}>
                    <Megaphone className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{announcement?.text}</span>
                </span>
            )}
            <button type="button" className={styles.announcementClose} aria-label="关闭公告" onClick={dismissAnnouncement}>
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </div>
    ) : null;

    return (
        <>
            {barContent}
            <header className={styles.header} style={announcementVisible ? { top: "38px" } : undefined}>
            <div className={styles.headerInner}>
                <div className={styles.headerLeft}>
                    <button type="button" className={styles.navMenuButton} onClick={() => setMobileOpen((value) => !value)} aria-expanded={mobileOpen} aria-controls="home-navigation-menu" aria-label={mobileOpen ? "关闭导航菜单" : "打开导航菜单"}>
                        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
                    </button>
                    <Link href="/" className={styles.brand} aria-label={site.title || "dreamyo"}>
                        <SiteLogo logoUrl={site.logoUrl} className="size-10 object-contain" />
                        <SiteWordmark className="h-5" title={site.title || "dreamyo"} />
                    </Link>
                </div>

                <div className={styles.headerActions}>
                    {adminLocal ? <Link href="/admin?section=channels" className="rounded-lg border border-sky-300/30 px-3 py-2 text-xs font-medium text-sky-100">本地模式 · 上游配置</Link> :
                    <AccountActionsCluster
                        authenticated={authenticated}
                        displayName={storeUser?.displayName || storeUser?.username}
                        accountId={storeUser?.accountId}
                        avatarUrl={storeUser?.avatarUrl?.trim()}
                        pointsBalance={storeUser?.pointsBalance || 0}
                        onBilling={openBillingPlans}
                        onInvite={() => openProtectedPath("/profile")}
                        onNavigate={openProtectedPath}
                        onLogout={handleLogout}
                        onLogin={() => openLogin()}
                    />}
                </div>
            </div>


            {mobileOpen ? (
                <nav id="home-navigation-menu" className={styles.mobileNav} aria-label="首页导航菜单">
                    {HOME_NAVIGATION.filter((item) => !adminLocal || ["/canvas", "/assets", "/drama"].includes(item.href)).map((item) =>
                        item.action !== "link" ? (
                            <button key={item.href} type="button" onClick={() => activate(item)}>
                                {item.label}
                                <ArrowRight aria-hidden="true" />
                            </button>
                        ) : (
                            <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)}>
                                {item.label}
                                <ArrowRight aria-hidden="true" />
                            </Link>
                        ),
                    )}
                </nav>
            ) : null}
        </header>
        </>
    );
}

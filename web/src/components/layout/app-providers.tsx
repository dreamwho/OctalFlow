"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import { usePathname } from "next/navigation";
import "dayjs/locale/zh-cn";

import { ClientRootInit } from "@/components/layout/client-root-init";
import { DesktopAppShell } from "@/components/layout/desktop-app-shell";
import { SiteAnnouncementPopup } from "@/components/layout/site-announcement-popup";
import { getAntThemeConfig } from "@/lib/app-theme";
import { pageTitleForPath } from "@/lib/page-titles";
import { themeScopeForPathname } from "@/lib/theme-scope";
import { startThemeStoreSync, useAdminThemeStore, useThemeStore } from "@/stores/use-theme-store";
import { usePublicSessionStore } from "@/stores/use-public-session-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5 * 60_000,
            gcTime: 15 * 60_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

dayjs.locale("zh-cn");

export function AppProviders({ children, initialDesktopEdition, desktopPlatform }: { children: ReactNode; initialDesktopEdition?: "commercial" | "admin" | null; desktopPlatform?: string }) {
    const pathname = usePathname();
    const siteSettings = usePublicSessionStore((state) => state.payload?.settings?.site);
    const configuredFrontendTheme = siteSettings?.frontendTheme || "dark";
    const configuredAdminTheme = siteSettings?.adminTheme || "dark";
    const desktopTheme = useThemeStore((state) => state.theme);
    const [appearanceReady, setAppearanceReady] = useState(false);
    const siteTitle = siteSettings?.title;
    const scope = themeScopeForPathname(pathname);
    const theme = initialDesktopEdition === "admin" ? desktopTheme : scope === "admin" ? configuredAdminTheme : configuredFrontendTheme;
    const desktopWorkspace = initialDesktopEdition === "admin" && (pathname === "/canvas" || pathname.startsWith("/canvas/") || pathname === "/admin");
    const dark = theme === "dark";

    useEffect(() => {
        if (initialDesktopEdition === "admin") return;
        useThemeStore.getState().setTheme(configuredFrontendTheme);
        useAdminThemeStore.getState().setTheme(configuredAdminTheme);
    }, [configuredFrontendTheme, configuredAdminTheme, initialDesktopEdition]);

    useEffect(() => startThemeStoreSync(), []);

    useEffect(() => {
        if (initialDesktopEdition !== "admin") return;
        const bridge = (window as typeof window & { dreamyoDesktop?: { getAppearance(): Promise<"light" | "dark"> } }).dreamyoDesktop;
        let mounted = true;
        void bridge?.getAppearance().then((stored) => {
            if (!mounted || (stored !== "light" && stored !== "dark")) return;
            useThemeStore.getState().setTheme(stored);
            useAdminThemeStore.getState().setTheme(stored);
            setAppearanceReady(true);
        }).catch(() => undefined);
        return () => { mounted = false; };
    }, [initialDesktopEdition]);

    useEffect(() => {
        if (initialDesktopEdition !== "admin" || !appearanceReady) return;
        const bridge = (window as typeof window & { dreamyoDesktop?: { setAppearance(theme: "light" | "dark"): Promise<boolean> } }).dreamyoDesktop;
        void bridge?.setAppearance(desktopTheme).catch(() => undefined);
    }, [desktopTheme, appearanceReady, initialDesktopEdition]);

    useEffect(() => {
        const reloadOnceForChunkError = (reason: unknown) => {
            const text = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason);
            if (!/ChunkLoadError|Loading chunk|dynamically imported module|failed to fetch/i.test(text)) return;
            const key = "dreamyo:chunk-reload-attempted";
            const lastAttempt = Number(sessionStorage.getItem(key) || "0");
            if (Date.now() - lastAttempt < 30_000) return;
            sessionStorage.setItem(key, String(Date.now()));
            window.location.reload();
        };

        const handleError = (event: ErrorEvent) => reloadOnceForChunkError(event.error || event.message);
        const handleRejection = (event: PromiseRejectionEvent) => reloadOnceForChunkError(event.reason);
        window.addEventListener("error", handleError);
        window.addEventListener("unhandledrejection", handleRejection);
        return () => {
            window.removeEventListener("error", handleError);
            window.removeEventListener("unhandledrejection", handleRejection);
        };
    }, []);

    useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = theme;
    }, [dark, theme]);

    useEffect(() => {
        document.title = pageTitleForPath(pathname, siteTitle);
    }, [pathname, siteTitle]);

    return (
        <ConfigProvider locale={zhCN} theme={getAntThemeConfig(dark, initialDesktopEdition === "admin")} popupOverflow="viewport" getPopupContainer={() => document.body}>
            <App message={{ top: 84, duration: 2.4, maxCount: 3 }}>
                <QueryClientProvider client={queryClient}>
                    <ClientRootInit>{desktopWorkspace ? <DesktopAppShell platform={desktopPlatform || ""}>{children}</DesktopAppShell> : children}</ClientRootInit>
                    {initialDesktopEdition || pathname === "/install" ? null : <SiteAnnouncementPopup />}
                </QueryClientProvider>
            </App>
        </ConfigProvider>
    );
}

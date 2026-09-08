"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import { usePathname } from "next/navigation";
import "dayjs/locale/zh-cn";

import { ClientRootInit } from "@/components/layout/client-root-init";
import { getAntThemeConfig } from "@/lib/app-theme";
import { themeScopeForPathname } from "@/lib/theme-scope";
import { startThemeStoreSync, useAdminThemeStore, useThemeStore } from "@/stores/use-theme-store";

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

export function AppProviders({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const frontendTheme = useThemeStore((state) => state.theme);
    const adminTheme = useAdminThemeStore((state) => state.theme);
    const theme = themeScopeForPathname(pathname) === "admin" ? adminTheme : frontendTheme;
    const dark = theme === "dark";

    useEffect(() => startThemeStoreSync(), []);

    useEffect(() => {
        const reloadOnceForChunkError = (reason: unknown) => {
            const text = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason);
            if (!/ChunkLoadError|Loading chunk|dynamically imported module|failed to fetch/i.test(text)) return;
            const key = "octalaicanvas:chunk-reload-attempted";
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

    return (
        <ConfigProvider locale={zhCN} theme={getAntThemeConfig(dark)} popupOverflow="viewport" getPopupContainer={() => document.body}>
            <App message={{ top: 84, duration: 2.4, maxCount: 3 }}>
                <QueryClientProvider client={queryClient}>
                    <ClientRootInit>{children}</ClientRootInit>
                </QueryClientProvider>
            </App>
        </ConfigProvider>
    );
}

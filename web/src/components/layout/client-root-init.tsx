"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { App } from "antd";
import { usePathname } from "next/navigation";

import { applyPublicSystemSettings, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { loadPublicSession, PUBLIC_SETTINGS_CHANGED_EVENT } from "@/stores/use-public-session-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const pathname = usePathname();
    const installRoute = pathname === "/install";
    const setConfig = useConfigStore((state) => state.setConfig);
    const setUser = useUserStore((state) => state.setUser);

    useEffect(() => {
        if (installRoute) return;
        let cancelled = false;
        const hydrate = (force = false) => {
            void loadPublicSession({ force })
                .then((payload) => {
                    if (cancelled) return;
                    setUser(payload.user || null);
                    setConfig(applyPublicSystemSettings(useConfigStore.getState().config, payload.settings));
                })
                .catch(() => undefined);
        };
        const handleSettingsChanged = () => hydrate(true);
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") hydrate(true);
        };
        hydrate();
        window.addEventListener(PUBLIC_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            cancelled = true;
            window.removeEventListener(PUBLIC_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [installRoute, setConfig, setUser]);

    useEffect(() => {
        const handleMissingConfig = (event: Event) => {
            const detail = (event as CustomEvent<{ capability?: string }>).detail;
            const capability = detail?.capability;
            const label = capability === "image" ? "图片" : capability === "video" ? "视频" : capability === "audio" ? "音频" : capability === "text" ? "文本" : "";
            message.warning(label ? `当前账号没有可用的${label}模型，请联系管理员在后台配置模型渠道或在用户角色中开放${label}分类权限` : "请联系管理员在后台配置可用模型渠道");
        };
        window.addEventListener("dreamyo-system-config-missing", handleMissingConfig);
        return () => window.removeEventListener("dreamyo-system-config-missing", handleMissingConfig);
    }, [message]);

    return children;
}

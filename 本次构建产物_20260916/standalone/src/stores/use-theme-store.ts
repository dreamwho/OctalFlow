import { create } from "zustand";
import { persist } from "zustand/middleware";

import { themeBroadcastChannel, themeStorageKey, type ThemeScope } from "@/lib/theme-scope";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme: ThemeName) => void;
};

const THEME_BROADCAST_TYPE = "theme";

function isThemeName(value: unknown): value is ThemeName {
    return value === "light" || value === "dark";
}

function themeFromStoredValue(value: string | null) {
    if (value === null) return "light";
    try {
        const parsed = JSON.parse(value) as { state?: { theme?: unknown } };
        return isThemeName(parsed.state?.theme) ? parsed.state.theme : null;
    } catch {
        return null;
    }
}

function createThemeStore(scope: ThemeScope) {
    const storageKey = themeStorageKey(scope);
    const broadcastChannelName = themeBroadcastChannel(scope);
    let channel: BroadcastChannel | null = null;
    let stopSync: (() => void) | null = null;

    const useStore = create<ThemeStore>()(
        persist(
            (set, get) => ({
                theme: "light",
                setTheme: (theme) => {
                    if (get().theme === theme) return;
                    set({ theme });
                    try {
                        channel?.postMessage({ type: THEME_BROADCAST_TYPE, theme });
                    } catch {
                        // localStorage remains the cross-tab fallback when BroadcastChannel is unavailable.
                    }
                },
            }),
            { name: storageKey },
        ),
    );

    const startSync = () => {
        if (typeof window === "undefined") return () => undefined;
        if (stopSync) return stopSync;

        const applySyncedTheme = (theme: ThemeName) => {
            if (useStore.getState().theme !== theme) useStore.setState({ theme });
        };
        const onStorage = (event: StorageEvent) => {
            if (event.key !== storageKey) return;
            const theme = themeFromStoredValue(event.newValue);
            if (theme) applySyncedTheme(theme);
        };
        const onBroadcast = (event: MessageEvent<unknown>) => {
            const payload = event.data as { type?: unknown; theme?: unknown } | null;
            if (payload?.type === THEME_BROADCAST_TYPE && isThemeName(payload.theme)) applySyncedTheme(payload.theme);
        };

        window.addEventListener("storage", onStorage);
        try {
            channel = new BroadcastChannel(broadcastChannelName);
            channel.addEventListener("message", onBroadcast);
        } catch {
            channel = null;
        }

        const stop = () => {
            window.removeEventListener("storage", onStorage);
            channel?.removeEventListener("message", onBroadcast);
            channel?.close();
            channel = null;
            if (stopSync === stop) stopSync = null;
        };
        stopSync = stop;
        return stop;
    };

    return { startSync, useStore };
}

const frontendTheme = createThemeStore("frontend");
const adminTheme = createThemeStore("admin");

export const useThemeStore = frontendTheme.useStore;
export const useAdminThemeStore = adminTheme.useStore;

/** Keep independently opened pages in sync only within the same theme scope. */
export function startThemeStoreSync() {
    const stopFrontend = frontendTheme.startSync();
    const stopAdmin = adminTheme.startSync();
    return () => {
        stopFrontend();
        stopAdmin();
    };
}

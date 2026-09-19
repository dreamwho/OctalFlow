import { appStorageKey } from "@/lib/storage-keys";

export type ThemeScope = "frontend" | "admin";

export function themeScopeForPathname(pathname: string | null | undefined): ThemeScope {
    return pathname?.startsWith("/admin") ? "admin" : "frontend";
}

export function themeStorageKey(scope: ThemeScope) {
    return appStorageKey(scope === "admin" ? "admin_theme_store" : "theme_store");
}

export function themeBroadcastChannel(scope: ThemeScope) {
    return appStorageKey(scope === "admin" ? "admin_theme_sync" : "theme_sync");
}

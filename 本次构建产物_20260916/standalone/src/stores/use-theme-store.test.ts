import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { themeBroadcastChannel, themeStorageKey } from "@/lib/theme-scope";

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length() {
        return this.values.size;
    }

    clear() {
        this.values.clear();
    }

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    key(index: number) {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string) {
        this.values.delete(key);
    }

    setItem(key: string, value: string) {
        this.values.set(key, String(value));
    }
}

class FakeBroadcastChannel extends EventTarget {
    static instances: FakeBroadcastChannel[] = [];

    readonly sent: unknown[] = [];
    closed = false;

    constructor(readonly name: string) {
        super();
        FakeBroadcastChannel.instances.push(this);
    }

    postMessage(message: unknown) {
        this.sent.push(message);
    }

    close() {
        this.closed = true;
    }

    receive(data: unknown) {
        const event = new Event("message");
        Object.defineProperty(event, "data", { value: data });
        this.dispatchEvent(event);
    }
}

type ThemeModule = typeof import("./use-theme-store");
let windowTarget: EventTarget;
let storage: MemoryStorage;
let theme: ThemeModule;
let stopThemeSync: (() => void) | undefined;

beforeEach(async () => {
    vi.resetModules();
    FakeBroadcastChannel.instances = [];
    windowTarget = new EventTarget();
    storage = new MemoryStorage();
    Object.defineProperty(windowTarget, "localStorage", { value: storage });
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    theme = await import("./use-theme-store");
});

afterEach(() => {
    stopThemeSync?.();
    stopThemeSync = undefined;
    vi.unstubAllGlobals();
});

function channelFor(scope: "frontend" | "admin") {
    const channel = FakeBroadcastChannel.instances.find((item) => item.name === themeBroadcastChannel(scope));
    if (!channel) throw new Error(`${scope} 主题同步通道未创建`);
    return channel;
}

function dispatchStorage(key: string, nextTheme: "light" | "dark") {
    const event = new Event("storage");
    Object.defineProperties(event, {
        key: { value: key },
        newValue: { value: JSON.stringify({ state: { theme: nextTheme }, version: 0 }) },
    });
    windowTarget.dispatchEvent(event);
}

describe("scoped theme store sync", () => {
    it("persists front-end and admin selections under independent keys", () => {
        stopThemeSync = theme.startThemeStoreSync();

        theme.useThemeStore.getState().setTheme("dark");

        expect(theme.useThemeStore.getState().theme).toBe("dark");
        expect(theme.useAdminThemeStore.getState().theme).toBe("light");
        expect(JSON.parse(storage.getItem(themeStorageKey("frontend")) || "{}")).toMatchObject({ state: { theme: "dark" } });
        expect(storage.getItem(themeStorageKey("admin"))).toBeNull();
        expect(channelFor("frontend").sent).toEqual([{ type: "theme", theme: "dark" }]);
        expect(channelFor("admin").sent).toEqual([]);

        theme.useAdminThemeStore.getState().setTheme("dark");

        expect(JSON.parse(storage.getItem(themeStorageKey("admin")) || "{}")).toMatchObject({ state: { theme: "dark" } });
        expect(channelFor("admin").sent).toEqual([{ type: "theme", theme: "dark" }]);
    });

    it("applies cross-tab updates only to their matching theme scope", () => {
        stopThemeSync = theme.startThemeStoreSync();

        channelFor("frontend").receive({ type: "theme", theme: "dark" });
        expect(theme.useThemeStore.getState().theme).toBe("dark");
        expect(theme.useAdminThemeStore.getState().theme).toBe("light");

        dispatchStorage(themeStorageKey("admin"), "dark");
        expect(theme.useThemeStore.getState().theme).toBe("dark");
        expect(theme.useAdminThemeStore.getState().theme).toBe("dark");
        expect(channelFor("frontend").sent).toEqual([]);
        expect(channelFor("admin").sent).toEqual([]);
    });

    it("ignores malformed, unrelated, and opposite-scope updates", () => {
        stopThemeSync = theme.startThemeStoreSync();
        theme.useThemeStore.getState().setTheme("dark");

        for (const [key, newValue] of [
            ["another-setting", JSON.stringify({ state: { theme: "light" } })],
            [themeStorageKey("frontend"), "not-json"],
        ] as const) {
            const event = new Event("storage");
            Object.defineProperties(event, { key: { value: key }, newValue: { value: newValue } });
            windowTarget.dispatchEvent(event);
        }
        channelFor("admin").receive({ type: "theme", theme: "dark" });

        expect(theme.useThemeStore.getState().theme).toBe("dark");
        expect(theme.useAdminThemeStore.getState().theme).toBe("dark");
    });
});

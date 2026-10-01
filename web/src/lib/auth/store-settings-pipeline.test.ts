import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => false),
    postgresQuery: vi.fn(),
    withPostgresTransaction: vi.fn(),
}));

vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async (_fileName: string, fallback: unknown) => memory.value ?? fallback),
    writeJsonDataFile: vi.fn(async (_fileName: string, value: unknown) => {
        memory.value = structuredClone(value);
    }),
}));

import { DEFAULT_GENERATION_PROMPT_RULES } from "@/lib/generation-prompt-rules";
import { DEFAULT_SETTINGS, DEFAULT_SITE_SETTINGS } from "./store-foundation";
import { getAuthSettings, setAuthSettings } from "./store";

/** 回归：站点资料保存曾被历史乱码修复规则改写（含 dreamyo+AI 的标题被整体替换为默认标语）。 */
describe("admin site settings save pipeline", () => {
    beforeEach(() => {
        memory.value = undefined;
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("persists disabled rules and edited or empty contents across a fresh settings read", async () => {
        const rules = structuredClone(DEFAULT_GENERATION_PROMPT_RULES);
        rules.imageReference = { enabled: false, content: "不要保持服饰，只沿用面部。\n第二行" };
        rules.panorama = { enabled: true, content: "" };
        const saved = await setAuthSettings({ generationDefaults: { ...DEFAULT_SETTINGS.generationDefaults, promptRules: rules } });
        expect(saved.generationDefaults.promptRules).toEqual(rules);
        expect((await getAuthSettings()).generationDefaults.promptRules).toEqual(rules);
    });

    it("persists administrator-entered site copy verbatim", async () => {
        const saved = await setAuthSettings({
            site: {
                ...DEFAULT_SITE_SETTINGS,
                title: "dreamyo AI 平台",
                seoTitle: "dreamyo AI 平台 搜索",
                seoDescription: "dreamyo AI 平台 的创作描述",
                seoKeywords: "dreamyo,AI 平台",
                footerCopyright: "© 2026 dreamyo AI 平台",
            },
        });

        expect(saved.site).toMatchObject({
            title: "dreamyo AI 平台",
            seoTitle: "dreamyo AI 平台 搜索",
            seoDescription: "dreamyo AI 平台 的创作描述",
            seoKeywords: "dreamyo,AI 平台",
            footerCopyright: "© 2026 dreamyo AI 平台",
        });

        const reloaded = (await getAuthSettings()).site;
        expect(reloaded.title).toBe("dreamyo AI 平台");
    });

    it("persists the traffic display unit across a fresh settings read", async () => {
        const saved = await setAuthSettings({ trafficUnit: "GB" });

        expect(saved.trafficUnit).toBe("GB");
        expect((await getAuthSettings()).trafficUnit).toBe("GB");
    });
});

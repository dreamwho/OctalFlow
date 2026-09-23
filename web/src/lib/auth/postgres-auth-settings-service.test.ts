import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./store-foundation";
import { DEFAULT_USER_ROLE } from "@/lib/user-roles";

const mocks = vi.hoisted(() => ({
    lock: vi.fn(),
    updateSettings: vi.fn(),
    upsertEntitlementPlan: vi.fn(),
    removeEntitlementPlansNotIn: vi.fn(),
    upsertSystemModelChannel: vi.fn(),
    deleteSystemModelChannelsNotIn: vi.fn(),
    readSettings: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({
    createPostgresRepositories: vi.fn(() => ({ settings: mocks })),
    ensurePostgresSchema: vi.fn(),
    withPostgresTransaction: vi.fn(async (handler: (client: unknown) => Promise<unknown>) => handler({})),
}));

vi.mock("./store-repository", () => ({ readPostgresAuthSettings: mocks.readSettings }));

import { updatePostgresAuthSettings } from "./postgres-auth-settings-service";

describe("updatePostgresAuthSettings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readSettings.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
        mocks.removeEntitlementPlansNotIn.mockResolvedValue([]);
    });

    it("updates site settings without rewriting plans or channels", async () => {
        const site = {
            ...DEFAULT_SETTINGS.site,
            title: "新站点",
            socials: {
                ...DEFAULT_SETTINGS.site.socials,
                telegram: { enabled: true, label: "Telegram", url: "https://t.me/dreamyo_group" },
                x: { enabled: true, label: "X", url: "https://x.com/dreamyo" },
                instagram: { enabled: true, label: "Instagram", url: "https://instagram.com/dreamyo.pro" },
            },
        };

        const settings = await updatePostgresAuthSettings({ site });

        expect(mocks.updateSettings).toHaveBeenCalledWith({ site: expect.objectContaining({ title: "新站点", socials: site.socials }) });
        expect(settings.site.socials).toEqual(site.socials);
        expect(mocks.upsertEntitlementPlan).not.toHaveBeenCalled();
        expect(mocks.removeEntitlementPlansNotIn).not.toHaveBeenCalled();
        expect(mocks.upsertSystemModelChannel).not.toHaveBeenCalled();
        expect(mocks.deleteSystemModelChannelsNotIn).not.toHaveBeenCalled();
    });

    it("rewrites only entitlement rows when entitlements change", async () => {
        const entitlements = structuredClone(DEFAULT_SETTINGS.entitlements);

        await updatePostgresAuthSettings({ entitlements });

        expect(mocks.updateSettings).toHaveBeenCalledWith({ entitlementsEnabled: entitlements.enabled, defaultPlanId: entitlements.defaultPlanId });
        expect(mocks.upsertEntitlementPlan).toHaveBeenCalledTimes(entitlements.plans.length);
        expect(mocks.removeEntitlementPlansNotIn).toHaveBeenCalledWith(entitlements.plans.map((plan) => plan.id));
        expect(mocks.upsertSystemModelChannel).not.toHaveBeenCalled();
        expect(mocks.deleteSystemModelChannelsNotIn).not.toHaveBeenCalled();
    });

    it("rewrites only channel rows when channels change", async () => {
        const systemChannels = [
            {
                id: "channel-one",
                name: "主渠道",
                baseUrl: "https://api.example.com/v1",
                apiKey: "",
                apiFormat: "openai" as const,
                models: ["writer"],
                enabled: true,
            },
        ];

        await updatePostgresAuthSettings({ systemChannels });

        expect(mocks.updateSettings).not.toHaveBeenCalled();
        expect(mocks.upsertSystemModelChannel).toHaveBeenCalledTimes(1);
        expect(mocks.deleteSystemModelChannelsNotIn).toHaveBeenCalledWith(["channel-one"]);
        expect(mocks.upsertEntitlementPlan).not.toHaveBeenCalled();
        expect(mocks.removeEntitlementPlansNotIn).not.toHaveBeenCalled();
    });

    it("persists newly created user roles in PostgreSQL settings", async () => {
        const userRoles = [structuredClone(DEFAULT_USER_ROLE), { ...structuredClone(DEFAULT_USER_ROLE), id: "honor", name: "八进制荣誉会员", recordOnly: true }];

        await updatePostgresAuthSettings({ userRoles });

        expect(mocks.updateSettings).toHaveBeenCalledWith({ userRoles });
        expect(mocks.upsertEntitlementPlan).not.toHaveBeenCalled();
        expect(mocks.upsertSystemModelChannel).not.toHaveBeenCalled();
    });
});

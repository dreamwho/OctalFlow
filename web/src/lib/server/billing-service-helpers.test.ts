import { describe, expect, it } from "vitest";

import type { BillingOrderRecord, BillingProductRecord, QueryExecutor } from "./database";
import { assertStoragePurchaseAllowed, isAutomaticallyExpiredOrder, normalizeBillingProductInput, normalizeBillingProductPatch, normalizeProvider } from "./billing-service-helpers";

describe("billing payment provider normalization", () => {
    it("uses the same stable provider ids as checkout and webhooks", () => {
        expect(normalizeProvider("Stripe-Checkout")).toBe("stripe");
        expect(normalizeProvider("ALI")).toBe("alipay");
        expect(normalizeProvider("wechatPay")).toBe("wechat");
        expect(normalizeProvider("pay_ply")).toBe("payply");
    });
});

describe("billing product patch", () => {
    const current: BillingProductRecord = {
        id: "product",
        productKind: "points",
        name: "积分商品",
        description: "",
        amountCents: 100,
        currency: "CNY",
        pointsAmount: 10,
        dailyPoints: 0,
        periodDays: 0,
        enabled: true,
        sortOrder: 0,
        metadata: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };
    const db = null as unknown as QueryExecutor;
    const planCurrent: BillingProductRecord = { ...current, productKind: "plan", planId: "creator" };

    it("rejects changing an existing points product to free", async () => {
        await expect(normalizeBillingProductPatch({ amountCents: 0 }, current, db)).rejects.toThrow("积分充值商品价格必须大于零");
    });

    it("rejects adding points to a free product", async () => {
        await expect(normalizeBillingProductPatch({ pointsAmount: 10 }, { ...planCurrent, amountCents: 0, pointsAmount: 0 }, db)).rejects.toThrow("赠送积分的商品价格必须大于零");
    });

    it("allows a free product when points are removed together", async () => {
        await expect(normalizeBillingProductPatch({ amountCents: 0, pointsAmount: 0 }, planCurrent, db)).resolves.toMatchObject({ amountCents: 0, pointsAmount: 0 });
    });

    it("requires paid storage capacity and keeps it separate from points and plan rights", async () => {
        const storage = await normalizeBillingProductInput({ productKind: "storage", name: "云空间", amountCents: 990, storageBytes: 1_073_741_824, periodDays: 30, pointsAmount: 100 }, db);
        expect(storage).toMatchObject({ productKind: "storage", storageBytes: 1_073_741_824, pointsAmount: 0, dailyPoints: 0, periodDays: 30, planId: undefined });
        await expect(normalizeBillingProductInput({ productKind: "storage", name: "云空间", amountCents: 990, storageBytes: 0 }, db)).rejects.toThrow("云存储容量必须是有效的正整数字节数");
        await expect(normalizeBillingProductPatch({ storageBytes: 0 }, storage, db)).rejects.toThrow("云存储容量必须是有效的正整数字节数");
        await expect(normalizeBillingProductPatch({ amountCents: 0 }, storage, db)).rejects.toThrow("云存储商品价格必须大于零");
    });

    it("enforces stacking, renewal and per-user purchase limits", async () => {
        const storage = await normalizeBillingProductInput({ productKind: "storage", name: "云空间", amountCents: 990, storageBytes: 1_073_741_824, storageStackable: false, storageRenewable: true, storagePurchaseLimit: 2 }, db);
        expect(storage).toMatchObject({ storageStackable: false, storageRenewable: true, storagePurchaseLimit: 2 });
        expect(() => assertStoragePurchaseAllowed(storage, { orders: 1, pendingOrders: 0, units: 1 }, 1)).not.toThrow();
        expect(() => assertStoragePurchaseAllowed(storage, { orders: 1, pendingOrders: 1, units: 1 }, 1)).toThrow("已有待支付订单");
        expect(() => assertStoragePurchaseAllowed(storage, { orders: 1, pendingOrders: 0, units: 1 }, 2)).toThrow("每单只能购买一份");
        expect(() => assertStoragePurchaseAllowed(storage, { orders: 2, pendingOrders: 0, units: 2 }, 1)).toThrow("购买次数限制");
        expect(() => assertStoragePurchaseAllowed({ ...storage, storageRenewable: false }, { orders: 1, pendingOrders: 0, units: 1 }, 1)).toThrow("不支持再次购买");
        await expect(normalizeBillingProductPatch({ storagePurchaseLimit: -1 }, storage, db)).rejects.toThrow("购买次数限制必须是非负整数");
    });
});

describe("billing order expiration metadata", () => {
    const order = {
        id: "order",
        orderNo: "VZ-ORDER",
        productKind: "points",
        status: "closed",
        subject: "积分商品",
        listAmountCents: 100,
        promotionDiscountCents: 0,
        couponDiscountCents: 0,
        amountCents: 100,
        currency: "CNY",
        pointsAmount: 10,
        dailyPoints: 0,
        periodDays: 0,
        quantity: 1,
        provider: "stripe",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    } satisfies BillingOrderRecord;

    it("only recognizes system expiration closures", () => {
        expect(isAutomaticallyExpiredOrder({ ...order, metadata: { close: { source: "expiration-job" } } })).toBe(true);
        expect(isAutomaticallyExpiredOrder({ ...order, metadata: { close: { source: "admin" } } })).toBe(false);
        expect(isAutomaticallyExpiredOrder({ ...order, status: "pending", metadata: { close: { source: "expiration-job" } } })).toBe(false);
    });
});

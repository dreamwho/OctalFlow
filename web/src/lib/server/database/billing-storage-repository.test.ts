import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import type { BillingOrderRecord, BillingProductRecord } from "./repository-types";
import { BillingOrderRepository } from "./billing-order-repository";
import { BillingProductRepository } from "./billing-product-repository";

const now = "2026-09-22T00:00:00.000Z";

describe("storage product and order persistence", () => {
    it("writes all storage policy columns with matching product placeholders", async () => {
        const query = vi.fn(async (..._args: unknown[]) => ({ rows: [{ id: "storage-1", product_kind: "storage", storage_bytes: "1073741824", storage_stackable: false, storage_renewable: true, storage_purchase_limit: 2 }] }));
        const product: BillingProductRecord = { id: "storage-1", productKind: "storage", name: "云空间", description: "", amountCents: 990, currency: "CNY", pointsAmount: 0, dailyPoints: 0, periodDays: 30, storageBytes: 1_073_741_824, storageStackable: false, storageRenewable: true, storagePurchaseLimit: 2, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now };

        const saved = await new BillingProductRepository({ query } as unknown as QueryExecutor).upsertProduct(product);

        const [sql, values] = query.mock.calls[0] as [string, unknown[]];
        expect(Math.max(...Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])))).toBe(values.length);
        expect(values).toHaveLength(19);
        expect(values.slice(10, 14)).toEqual([1_073_741_824, false, true, 2]);
        expect(saved).toMatchObject({ productKind: "storage", storageBytes: 1_073_741_824, storageStackable: false, storageRenewable: true, storagePurchaseLimit: 2 });
    });

    it("persists the exact entitlement snapshot on an order", async () => {
        const query = vi.fn(async (..._args: unknown[]) => ({ rows: [{ id: "order-1", product_kind: "storage", storage_bytes: "1073741824", storage_stackable: false, storage_renewable: true, storage_purchase_limit: 2 }] }));
        const order: BillingOrderRecord = { id: "order-1", orderNo: "VZ-STORAGE", productId: "storage-1", userId: "user-one", productKind: "storage", status: "pending", subject: "云空间", listAmountCents: 990, promotionDiscountCents: 0, couponDiscountCents: 0, amountCents: 990, currency: "CNY", pointsAmount: 0, dailyPoints: 0, periodDays: 30, storageBytes: 1_073_741_824, storageStackable: false, storageRenewable: true, storagePurchaseLimit: 2, quantity: 1, provider: "manual", createdAt: now, updatedAt: now };

        const saved = await new BillingOrderRepository({ query } as unknown as QueryExecutor).createOrder(order);

        const [sql, values] = query.mock.calls[0] as [string, unknown[]];
        expect(Math.max(...Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])))).toBe(values.length);
        expect(values).toHaveLength(33);
        expect(values.slice(16, 20)).toEqual([1_073_741_824, false, true, 2]);
        expect(saved).toMatchObject({ productKind: "storage", storageBytes: 1_073_741_824, storageStackable: false, storageRenewable: true, storagePurchaseLimit: 2 });
    });
});

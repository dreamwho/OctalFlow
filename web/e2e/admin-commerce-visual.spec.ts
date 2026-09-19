import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");

test.describe.configure({ mode: "serial" });

test("admin commerce sections render isolated products, promotions and coupons in C01", async ({ page, request }) => {
    test.setTimeout(180_000);
    const suffix = randomUUID().slice(0, 8);
    const productName = `E2E 视觉商品 ${suffix}`;
    const promotionName = `E2E 视觉活动 ${suffix}`;
    const couponName = `E2E 视觉优惠券 ${suffix}`;
    const couponCode = `E2E${suffix.toUpperCase()}`;
    const dates = { startsAt: "2026-09-14T00:00:00.000Z", endsAt: "2027-09-14T00:00:00.000Z" };
    const buildId = await readCurrentBuildId();
    let productId = "";
    let promotionId = "";
    let couponId = "";
    let orderId = "";
    let orderDisplayName = "";
    let productDisplayName = productName;
    let promotionDisplayName = promotionName;
    let couponDisplayName = couponName;

    await mkdir(evidenceRoot, { recursive: true });
    try {
        const productResponse = await request.post("/api/admin/billing/products", {
            data: {
                productKind: "points",
                name: productName,
                description: "隔离后台视觉验收商品",
                amountCents: 1999,
                currency: "CNY",
                pointsAmount: 200,
                dailyPoints: 0,
                periodDays: 0,
                enabled: true,
                sortOrder: 999,
            },
        });
        expect(productResponse.ok(), await productResponse.text()).toBe(true);
        const createdProduct = (await productResponse.json()) as { product: { id: string; name: string } };
        productId = createdProduct.product.id;
        productDisplayName = createdProduct.product.name;

        const orderResponse = await request.post("/api/billing/orders", { data: { productId, quantity: 1, provider: "manual" } });
        expect(orderResponse.ok(), await orderResponse.text()).toBe(true);
        const createdOrder = (await orderResponse.json()) as { order: { id: string; orderNo: string } };
        orderId = createdOrder.order.id;
        orderDisplayName = createdOrder.order.orderNo;

        const promotionResponse = await request.post("/api/admin/billing/promotions", {
            data: { name: promotionName, label: "视觉验收限时优惠", enabled: true, ...dates, products: [{ productId, promotionalAmountCents: 1599 }] },
        });
        expect(promotionResponse.ok(), await promotionResponse.text()).toBe(true);
        const createdPromotion = (await promotionResponse.json()) as { data: { campaign: { id: string; name: string } } };
        promotionId = createdPromotion.data.campaign.id;
        promotionDisplayName = createdPromotion.data.campaign.name;

        const couponResponse = await request.post("/api/admin/billing/coupon-templates", {
            data: {
                code: couponCode,
                name: couponName,
                description: "隔离后台视觉验收优惠券",
                discountType: "fixed",
                discountValue: 300,
                minimumAmountCents: 0,
                maximumDiscountCents: 300,
                stackWithPromotion: false,
                claimable: true,
                enabled: true,
                ...dates,
                totalLimit: 20,
                perUserLimit: 1,
                productIds: [productId],
            },
        });
        expect(couponResponse.ok(), await couponResponse.text()).toBe(true);
        const createdCoupon = (await couponResponse.json()) as { data: { template: { id: string; name: string } } };
        couponId = createdCoupon.data.template.id;
        couponDisplayName = createdCoupon.data.template.name;

        for (const viewport of [
            { name: "desktop-1280", width: 1280, height: 720 },
            { name: "mobile-390", width: 390, height: 844 },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            for (const theme of ["light", "dark"] as const) {
                for (const section of [
                    { key: "products", name: productDisplayName },
                    { key: "orders", name: orderDisplayName },
                    { key: "promotions", name: promotionDisplayName },
                    { key: "coupons", name: couponDisplayName },
                    { key: "payments", name: "支付渠道配置" },
                ]) {
                    await setAdminTheme(page, theme);
                    await page.goto(`/admin?section=${section.key}`, { waitUntil: "domcontentloaded" });
                    await expect(page.locator("[data-hydrated='true']")).toBeVisible();
                    await expect(page.getByText(section.name, { exact: true })).toBeVisible();
                    const entity = page.getByText(section.name, { exact: true }).first();
                    const measurement = {
                        ...(await entity.evaluate((node, sectionKey) => {
                            const card = node.closest("article") || node.closest("section") || node.parentElement;
                            const bounds = card?.getBoundingClientRect();
                            return {
                                route: `/admin?section=${sectionKey}`,
                                viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                                entityVisible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
                                card: bounds ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : null,
                                overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                                adminTheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            };
                        }, section.key)),
                        buildId,
                    };
                    expect(measurement.entityVisible).toBe(true);
                    expect(measurement.overflow).toBe(false);
                    expect(measurement.adminTheme).toBe(theme);
                    const stem = `after-admin-commerce-${section.key}-${theme}-${viewport.name}`;
                    await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                    await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, state: "隔离真实实体卡片已加载", entity: section.name }, null, 2)}\n`, "utf8");
                }
            }
        }
    } finally {
        await deleteIfPresent(request, promotionId ? `/api/admin/billing/promotions/${encodeURIComponent(promotionId)}` : "");
        await deleteIfPresent(request, couponId ? `/api/admin/billing/coupon-templates/${encodeURIComponent(couponId)}` : "");
        await closeIfPresent(request, orderId ? `/api/admin/billing/orders/${encodeURIComponent(orderId)}/close` : "");
        await deleteIfPresent(request, productId ? `/api/admin/billing/products/${encodeURIComponent(productId)}` : "");
    }
});

test("admin operational sections render isolated user, CDK, points, wallet and referral states", async ({ page, request }) => {
    test.setTimeout(180_000);
    const suffix = randomUUID().slice(0, 8);
    const username = `e2e_visual_user_${suffix}`;
    const displayName = `E2E 视觉用户 ${suffix}`;
    const buildId = await readCurrentBuildId();
    let userId = "";
    let cdkIds: string[] = [];
    let productId = "";
    let orderId = "";
    await mkdir(evidenceRoot, { recursive: true });
    try {
        const userResponse = await request.post("/api/admin/users", {
            data: { username, displayName, email: `${username}@example.test`, password: "E2E-user-password-2026!", role: "user", adminPermissions: [], status: "active", pointsBalance: 73 },
        });
        expect(userResponse.ok(), await userResponse.text()).toBe(true);
        userId = ((await userResponse.json()) as { user: { id: string; displayName: string } }).user.id;

        const cdkResponse = await request.post("/api/admin/cdk", { data: { count: 1, points: 73, maxRedemptions: 1, expiresInDays: null, note: `E2E 视觉 CDK ${suffix}` } });
        expect(cdkResponse.ok(), await cdkResponse.text()).toBe(true);
        const createdCdk = (await cdkResponse.json()) as { codes: Array<{ id: string; code: string }> };
        cdkIds = createdCdk.codes.map((code) => code.id);
        expect(createdCdk.codes[0]?.code).toBeTruthy();

        const productResponse = await request.post("/api/admin/billing/products", {
            data: { productKind: "points", name: `E2E 钱包商品 ${suffix}`, description: "隔离财务视觉验收", amountCents: 299, currency: "CNY", pointsAmount: 73, enabled: true, sortOrder: 998 },
        });
        expect(productResponse.ok(), await productResponse.text()).toBe(true);
        productId = ((await productResponse.json()) as { product: { id: string } }).product.id;
        const orderResponse = await request.post("/api/billing/orders", { data: { productId, quantity: 1, provider: "payply" } });
        expect(orderResponse.ok(), await orderResponse.text()).toBe(true);
        orderId = ((await orderResponse.json()) as { order: { id: string } }).order.id;

        const entities = [
            { key: "points", heading: "积分规则", name: "e2e-text", locator: () => page.locator("main").getByText("e2e-text", { exact: true }).first() },
            { key: "users", heading: "用户管理", name: displayName, locator: () => page.locator("main").getByText(displayName, { exact: true }).first() },
            { key: "cdk", heading: "CDK 兑换", name: "CDK 密钥管理", locator: () => page.locator("main").getByText("CDK 密钥管理", { exact: true }).first() },
            { key: "wallet", heading: "财务流水", name: "财务口径说明", locator: () => page.locator("main").getByText("财务口径说明", { exact: true }).first() },
            { key: "referrals", heading: "邀请奖励", name: "邀请奖励", locator: () => page.getByRole("heading", { name: "邀请奖励", exact: true }).first() },
        ];
        for (const viewport of [
            { name: "desktop-1440", width: 1440, height: 900 },
            { name: "mobile-390", width: 390, height: 844 },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            for (const theme of ["light", "dark"] as const) {
                for (const entity of entities) {
                    await setAdminTheme(page, theme);
                    await page.goto(`/admin?section=${entity.key}`, { waitUntil: "domcontentloaded" });
                    await expect(page.locator("[data-hydrated='true']")).toBeVisible();
                    await expect(page.getByRole("heading", { name: entity.heading, exact: true }).first()).toBeVisible();
                    await expect(entity.locator()).toBeVisible();
                    const measurement = {
                        ...(await entity.locator().evaluate((element, sectionKey) => {
                            const card = element.closest("article") || element.closest("section") || element.parentElement;
                            const bounds = card?.getBoundingClientRect();
                            return {
                                route: `/admin?section=${sectionKey}`,
                                viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                                theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                                entityVisible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
                                card: bounds ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : null,
                                overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                            };
                        }, entity.key)),
                        buildId,
                    };
                    expect(measurement.entityVisible).toBe(true);
                    expect(measurement.overflow).toBe(false);
                    expect(measurement.theme).toBe(theme);
                    const stem = `after-admin-operational-${entity.key}-${theme}-${viewport.name}`;
                    await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                    await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, state: "隔离真实后台实体/配置已加载", entity: entity.name }, null, 2)}\n`, "utf8");
                }
            }
        }
    } finally {
        if (productId) {
            if (orderId) await closeIfPresent(request, `/api/admin/billing/orders/${encodeURIComponent(orderId)}/close`);
            await deleteIfPresent(request, `/api/admin/billing/products/${encodeURIComponent(productId)}`);
        }
        if (cdkIds.length) await request.delete("/api/admin/cdk", { data: { ids: cdkIds } });
        if (userId) await deleteIfPresent(request, `/api/admin/users/${encodeURIComponent(userId)}`);
    }
});

test("admin orders render refund and reconciliation states with isolated payment data", async ({ page, request }) => {
    test.setTimeout(180_000);
    const suffix = randomUUID().slice(0, 8);
    const productName = `E2E 退款商品 ${suffix}`;
    let productId = "";
    let orderId = "";
    let orderNo = "";
    const buildId = await readCurrentBuildId();
    await mkdir(evidenceRoot, { recursive: true });
    try {
        const productResponse = await request.post("/api/admin/billing/products", {
            data: { productKind: "points", name: productName, description: "隔离退款与对账视觉验收", amountCents: 299, currency: "CNY", pointsAmount: 30, enabled: true, sortOrder: 997 },
        });
        expect(productResponse.ok(), await productResponse.text()).toBe(true);
        productId = ((await productResponse.json()) as { product: { id: string } }).product.id;
        const orderResponse = await request.post("/api/billing/orders", { data: { productId, quantity: 1, provider: "payply" } });
        expect(orderResponse.ok(), await orderResponse.text()).toBe(true);
        const createdOrder = (await orderResponse.json()) as { order: { id: string; orderNo: string; provider?: string } };
        orderId = createdOrder.order.id;
        orderNo = createdOrder.order.orderNo;
        const orderProvider = createdOrder.order.provider || "payply";

        const completeResponse = await request.post(`/api/admin/billing/orders/${encodeURIComponent(orderId)}/complete`, { data: { provider: orderProvider, channel: orderProvider, providerTradeId: orderNo } });
        expect(completeResponse.ok(), await completeResponse.text()).toBe(true);
        const refundResponse = await request.post(`/api/admin/billing/orders/${encodeURIComponent(orderId)}/refund`, { data: { reason: "隔离视觉验收退款" } });
        expect(refundResponse.ok(), await refundResponse.text()).toBe(true);

        for (const viewport of [
            { name: "desktop-1440", width: 1440, height: 900 },
            { name: "mobile-390", width: 390, height: 844 },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            for (const theme of ["light", "dark"] as const) {
                await setAdminTheme(page, theme);
                await page.goto("/admin?section=orders", { waitUntil: "domcontentloaded" });
                await expect(page.locator("[data-hydrated='true']")).toBeVisible();
                await expect(page.getByRole("heading", { name: "订单管理", exact: true }).first()).toBeVisible();
                const orderSearch = page.getByPlaceholder("订单号 / 商品 / 支付单号 / 用户 ID");
                await orderSearch.fill(orderNo);
                await page.getByRole("button", { name: "查询", exact: true }).click();
                await expect(page.getByText(orderNo, { exact: true })).toBeVisible();
                await expect(page.getByText("已退款", { exact: true }).first()).toBeVisible();
                await page.getByRole("button", { name: "导入支付商账单" }).click();
                const reconciliationDialog = page.getByRole("dialog", { name: "导入支付商账单对账" });
                await expect(reconciliationDialog).toBeVisible();
                await reconciliationDialog.getByRole("combobox").first().click();
                await page.getByText("PayPly", { exact: true }).last().click();
                const csv = `商户订单号,支付流水号,金额,币种,状态,备注\n${orderNo},${orderNo},2.99,CNY,refunded,${theme}-${viewport.name}`;
                await reconciliationDialog.locator("textarea").fill(csv);
                await reconciliationDialog.getByRole("button", { name: "开始对账" }).click();
                await expect(reconciliationDialog.getByText("已保存批次", { exact: true })).toBeVisible();
                const measurement = {
                    ...(await reconciliationDialog.evaluate((element, state) => {
                        const rect = element.getBoundingClientRect();
                        return {
                            route: "/admin?section=orders",
                            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            state,
                            dialog: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                            visible: rect.width > 0 && rect.height > 0,
                            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                        };
                    }, "refund + reconciliation")),
                    buildId,
                };
                expect(measurement.visible).toBe(true);
                expect(measurement.overflow).toBe(false);
                expect(measurement.theme).toBe(theme);
                const stem = `after-admin-refund-reconciliation-${theme}-${viewport.name}`;
                await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, entity: orderNo }, null, 2)}\n`, "utf8");
                await reconciliationDialog.locator("button.ant-modal-close").click();
                await expect(reconciliationDialog).toBeHidden();
            }
        }
    } finally {
        if (productId) await deleteIfPresent(request, `/api/admin/billing/products/${encodeURIComponent(productId)}`);
    }
});

async function setAdminTheme(page: Page, theme: "light" | "dark") {
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:admin_theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function readCurrentBuildId() {
    return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
}

async function deleteIfPresent(request: APIRequestContext, url: string) {
    if (!url) return;
    const response = await request.delete(url);
    expect([200, 204, 404, 409]).toContain(response.status());
}

async function closeIfPresent(request: APIRequestContext, url: string) {
    if (!url) return;
    const response = await request.post(url, { data: { reason: "后台视觉回归清理" } });
    expect([200, 204, 404, 409]).toContain(response.status());
}

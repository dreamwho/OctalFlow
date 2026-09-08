import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.OCTALAICANVAS_E2E_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;
const protocolFixturePort = Number(process.env.OCTALAICANVAS_PROTOCOL_FIXTURE_PORT || 4010);
const paymentFixturePort = Number(process.env.OCTALAICANVAS_PAYMENT_FIXTURE_PORT || 4020);
const databaseUrl = process.env.OCTALAICANVAS_E2E_DATABASE_URL?.trim() || "";
const storageState = path.join(process.cwd(), ".e2e-data", "admin-state.json");

export default defineConfig({
    testDir: "./e2e",
    outputDir: ".e2e-artifacts",
    fullyParallel: false,
    timeout: 120_000,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI || !databaseUrl ? 1 : undefined,
    reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    projects: [
        { name: "setup", testMatch: /installation\.spec\.ts/ },
        { name: "chromium", testMatch: [/(?:all-pages|canvas|commerce|core|creative-video-result|home|responsive)\.spec\.ts/], dependencies: ["setup"], use: { ...devices["Desktop Chrome"], storageState } },
        { name: "my-prompts", testMatch: /my-prompts\.spec\.ts/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"] } },
        { name: "my-prompts-390", testMatch: /my-prompts\.spec\.ts/, dependencies: ["setup"], use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
        { name: "my-prompts-430", testMatch: /my-prompts\.spec\.ts/, dependencies: ["setup"], use: { ...devices["iPhone 14 Pro Max"], browserName: "chromium", viewport: { width: 430, height: 932 } } },
        { name: "mobile-390", testMatch: /(?:all-pages|commerce|creative-video-result|home|responsive)\.spec\.ts/, dependencies: ["setup"], use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 }, storageState } },
        {
            name: "mobile-430",
            testMatch: /(?:all-pages|commerce|creative-video-result|home|responsive)\.spec\.ts/,
            dependencies: ["setup"],
            use: { ...devices["iPhone 14 Pro Max"], browserName: "chromium", viewport: { width: 430, height: 932 }, storageState },
        },
    ],
    webServer: [
        {
            command: "node scripts/protocol-fixture-server.mjs",
            url: `http://127.0.0.1:${protocolFixturePort}/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            env: { ...process.env, OCTALAICANVAS_PROTOCOL_FIXTURE_PORT: String(protocolFixturePort) },
        },
        {
            command: "node scripts/payment-fixture-server.mjs",
            url: `http://127.0.0.1:${paymentFixturePort}/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            env: { ...process.env, OCTALAICANVAS_PAYMENT_FIXTURE_PORT: String(paymentFixturePort) },
        },
        {
            command: "pnpm run start",
            url: `${baseURL}/api/auth/session`,
            timeout: 120_000,
            reuseExistingServer: false,
            env: {
                ...process.env,
                PORT: String(port),
                NEXT_PUBLIC_SITE_URL: baseURL,
                OCTALAICANVAS_DATABASE_PROVIDER: databaseUrl ? "postgres" : "file",
                OCTALAICANVAS_DATA_DIR: path.join(process.cwd(), ".e2e-data"),
                OCTALAICANVAS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                OCTALAICANVAS_INSTALL_TOKEN: "octalaicanvas-e2e-install-token-32chars",
                OCTALAICANVAS_MAINTENANCE_TOKEN: "octalaicanvas-e2e-maintenance-token-32chars",
                OCTALAICANVAS_WORKER_TOKEN: "octalaicanvas-e2e-worker-token-separate-32chars",
                OCTALAICANVAS_ALLOW_PRIVATE_UPSTREAMS: "1",
                OCTALAICANVAS_PRIVATE_UPSTREAM_HOSTS: "127.0.0.1",
                ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
                OCTALAICANVAS_PAYPLY_API_KEY: "octalaicanvas-e2e-payply-production-key",
                OCTALAICANVAS_PAYPLY_CHECKOUT_URL: `http://127.0.0.1:${paymentFixturePort}/payply/checkout`,
                OCTALAICANVAS_PAYPLY_QUERY_URL: `http://127.0.0.1:${paymentFixturePort}/payply/query?orderId={{orderId}}&orderNo={{orderNo}}&tradeId={{providerTradeId}}&paymentId={{providerPaymentId}}`,
                OCTALAICANVAS_PAYPLY_REFUND_URL: `http://127.0.0.1:${paymentFixturePort}/payply/refund`,
                OCTALAICANVAS_PAYPLY_REFUND_QUERY_URL: `http://127.0.0.1:${paymentFixturePort}/payply/refund-query?refundId={{providerRefundId}}`,
                OCTALAICANVAS_PAYPLY_WEBHOOK_SECRET: "octalaicanvas-e2e-payply-webhook-secret",
            },
        },
    ],
});

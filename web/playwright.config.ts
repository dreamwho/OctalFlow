import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.DREAMYO_E2E_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;
const protocolFixturePort = Number(process.env.DREAMYO_PROTOCOL_FIXTURE_PORT || 4010);
const paymentFixturePort = Number(process.env.DREAMYO_PAYMENT_FIXTURE_PORT || 4020);
const databaseUrl = process.env.DREAMYO_E2E_DATABASE_URL?.trim() || "";
const storageState = path.join(process.cwd(), ".e2e-data", "admin-state.json");

export default defineConfig({
    testDir: "./e2e",
    outputDir: ".e2e-artifacts",
    fullyParallel: false,
    timeout: 120_000,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    // All projects share the same isolated data directory, database (when
    // configured), and fixture media limiter. Keep every run serial so one
    // project cannot mutate or exhaust shared state while another asserts it.
    workers: 1,
    reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    projects: [
        { name: "setup", testMatch: /installation\.spec\.ts/ },
        {
            name: "chromium",
            testMatch: [
                /(?:admin-brand-visual|admin-commerce-visual|admin-entry-matrix|admin-sections-matrix|all-pages|canvas|commerce|content-account-visual|core|creative-video-result|dola-admin|drama-visual|home|responsive|static-brand-visual|ui-rebuild|user-pages-matrix)\.spec\.ts/,
            ],
            dependencies: ["setup"],
            use: { ...devices["Desktop Chrome"], storageState },
        },
        { name: "my-prompts", testMatch: /my-prompts\.spec\.ts/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"] } },
        { name: "my-prompts-390", testMatch: /my-prompts\.spec\.ts/, dependencies: ["setup"], use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
        { name: "my-prompts-430", testMatch: /my-prompts\.spec\.ts/, dependencies: ["setup"], use: { ...devices["iPhone 14 Pro Max"], browserName: "chromium", viewport: { width: 430, height: 932 } } },
        {
            name: "mobile-390",
            testMatch: /(?:all-pages|commerce|content-account-visual|creative-video-result|drama-visual|home|responsive|static-brand-visual|ui-rebuild)\.spec\.ts/,
            dependencies: ["setup"],
            use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 }, storageState },
        },
        {
            name: "mobile-430",
            testMatch: /(?:all-pages|commerce|content-account-visual|creative-video-result|drama-visual|home|responsive|static-brand-visual|ui-rebuild)\.spec\.ts/,
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
            env: { ...process.env, DREAMYO_PROTOCOL_FIXTURE_PORT: String(protocolFixturePort) },
        },
        {
            command: "node scripts/payment-fixture-server.mjs",
            url: `http://127.0.0.1:${paymentFixturePort}/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            env: { ...process.env, DREAMYO_PAYMENT_FIXTURE_PORT: String(paymentFixturePort) },
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
                DREAMYO_INTERNAL_ORIGIN: baseURL,
                DREAMYO_WORKER_API_ORIGIN: baseURL,
                DREAMYO_DATABASE_PROVIDER: databaseUrl ? "postgres" : "file",
                DREAMYO_DATA_DIR: path.join(process.cwd(), ".e2e-data"),
                DREAMYO_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                DREAMYO_INSTALL_TOKEN: "dreamyo-e2e-install-token-32chars",
                DREAMYO_MAINTENANCE_TOKEN: "dreamyo-e2e-maintenance-token-32chars",
                DREAMYO_WORKER_TOKEN: "dreamyo-e2e-worker-token-separate-32chars",
                DREAMYO_ALLOW_PRIVATE_UPSTREAMS: "1",
                DREAMYO_PRIVATE_UPSTREAM_HOSTS: "127.0.0.1",
                DREAMYO_DOLA_API_ENABLED: "0",
                DREAMYO_DOLA_PROVIDER_URL: `http://127.0.0.1:${protocolFixturePort}`,
                DREAMYO_DOLA_PROVIDER_KEY: "dreamyo-e2e-dola-provider-key",
                ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
                DREAMYO_PAYPLY_API_KEY: "dreamyo-e2e-payply-production-key",
                DREAMYO_PAYPLY_CHECKOUT_URL: `http://127.0.0.1:${paymentFixturePort}/payply/checkout`,
                DREAMYO_PAYPLY_QUERY_URL: `http://127.0.0.1:${paymentFixturePort}/payply/query?orderId={{orderId}}&orderNo={{orderNo}}&tradeId={{providerTradeId}}&paymentId={{providerPaymentId}}`,
                DREAMYO_PAYPLY_REFUND_URL: `http://127.0.0.1:${paymentFixturePort}/payply/refund`,
                DREAMYO_PAYPLY_REFUND_QUERY_URL: `http://127.0.0.1:${paymentFixturePort}/payply/refund-query?refundId={{providerRefundId}}`,
                DREAMYO_PAYPLY_WEBHOOK_SECRET: "dreamyo-e2e-payply-webhook-secret",
                DREAMYO_PAYPLY_WEBHOOK_SIGNATURE_HEADER: "x-dreamyo-signature",
            },
        },
    ],
});

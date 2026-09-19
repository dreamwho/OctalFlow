import { defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";

const port = Number(process.env.DREAMYO_E2E_PORT);
const dataDir = process.env.DREAMYO_CHATGPT_TEST_DATA_DIR;
if (!port || !dataDir) throw new Error("Specify an unused DREAMYO_E2E_PORT and isolated DREAMYO_CHATGPT_TEST_DATA_DIR");
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(dataDir) && readdirSync(dataDir).length) throw new Error("DREAMYO_CHATGPT_TEST_DATA_DIR must be a new empty directory for each run");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
    testDir: "./e2e",
    testMatch: "chatgpt-api.spec.ts",
    outputDir: `${dataDir}/browser-artifacts`,
    workers: 1,
    retries: 0,
    timeout: 120_000,
    use: { ...devices["Desktop Chrome"], baseURL, actionTimeout: 10_000, screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: {
        command: "pnpm start",
        url: `${baseURL}/api/auth/session`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
            ...process.env,
            PORT: String(port),
            DATABASE_URL: "",
            NEXT_PUBLIC_SITE_URL: baseURL,
            DREAMYO_INTERNAL_ORIGIN: baseURL,
            DREAMYO_DATA_DIR: dataDir,
            DREAMYO_DATABASE_PROVIDER: "file",
            DREAMYO_INSTALL_TOKEN: "chatgpt-api-fixture-install-token-32chars",
            DREAMYO_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            DREAMYO_GEMINIAI_URL: "http://127.0.0.1:9",
            DREAMYO_GEMINIAI_API_KEY: "unused-fixture-provider-key-32chars",
            DREAMYO_CHATGPT_API_ENABLED: "0",
        },
    },
});

import { describe, expect, it } from "vitest";

import { localDolaApiRuntime } from "./dola-api-local-runtime.mjs";

const options = { repoRoot: "/project", webRoot: "/project/web", exists: () => true, tokenFactory: () => "fixture-runtime-key" };

describe("Dola API local runtime", () => {
    it("starts the bundled provider for the local configured endpoint", () => {
        const result = localDolaApiRuntime({ ...options, environment: { DREAMYO_DOLA_PROVIDER_URL: "http://127.0.0.1:18082", DREAMYO_DOLA_PROVIDER_KEY: "configured-key", DREAMYO_DATA_DIR: "/data" } });
        expect(result.environment).toMatchObject({ DREAMYO_DOLA_PROVIDER_URL: "http://127.0.0.1:18082", DREAMYO_DOLA_PROVIDER_KEY: "configured-key" });
        expect(result.service).toMatchObject({ name: "dola-api", cwd: "/project/services/dola-api", args: ["-m", "uvicorn", "dola_api.app:app", "--host", "127.0.0.1", "--port", "18082"] });
        expect(result.service.environment).toMatchObject({ DOLA_PROVIDER_KEY: "configured-key", DOLA_ENABLE_BROWSER: "1", DOLA_TASK_STATE_PATH: "/data/dola/provider-tasks.json" });
    });

    it("keeps an explicitly configured remote provider external", () => {
        const result = localDolaApiRuntime({ ...options, environment: { DREAMYO_DOLA_PROVIDER_URL: "https://dola.internal", DREAMYO_DOLA_PROVIDER_KEY: "configured-key" } });
        expect(result.service).toBeUndefined();
    });

    it("rejects an incomplete or invalid local configuration", () => {
        expect(() => localDolaApiRuntime({ ...options, environment: { DREAMYO_DOLA_PROVIDER_PORT: "0" } })).toThrow("端口");
        expect(() => localDolaApiRuntime({ ...options, environment: { DREAMYO_DOLA_PROVIDER_URL: "https://dola.internal" } })).toThrow("服务密钥");
    });
});

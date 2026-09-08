import { describe, expect, it } from "vitest";
import { localChatGptApiRuntime } from "./chatgpt-api-local-runtime.mjs";

const options = { repoRoot: "/project", webRoot: "/project/web", exists: () => true, tokenFactory: () => "fixture-runtime-key-32-characters-long" };
describe("ChatGPT API local runtime", () => {
    it("does not break installations without the optional Python environment", () => {
        expect(localChatGptApiRuntime({ ...options, exists: () => false, environment: {} }).service).toBeUndefined();
    });
    it("isolates provider data and database while sharing a private transport key", () => {
        const result = localChatGptApiRuntime({ ...options, environment: { DATABASE_URL: "postgres://private", OCTALAICANVAS_DATA_DIR: "/fixture", OCTALAICANVAS_ENCRYPTION_KEY: "fixture-key" } });
        expect(result.environment.DATABASE_URL).toBe("postgres://private");
        expect(result.service.environment.DATABASE_URL).toBe("");
        expect(result.service.environment.OCTALAICANVAS_CHATGPT_DATA_DIR).toBe("/fixture/chatgpt-api");
        expect(result.service.environment.OCTALAICANVAS_CHATGPT_API_KEY).toBe(result.environment.OCTALAICANVAS_CHATGPT_API_KEY);
        expect(result.environment.OCTALAICANVAS_CHATGPT_API_URL).toBe("http://127.0.0.1:8046");
    });
    it("requires authentication for explicit runtime configuration", () => {
        expect(() => localChatGptApiRuntime({ ...options, environment: { OCTALAICANVAS_CHATGPT_API_URL: "http://runtime" } })).toThrow("服务密钥");
    });
    it("supports explicitly disabling local startup and rejects invalid ports", () => {
        expect(localChatGptApiRuntime({ ...options, environment: { OCTALAICANVAS_CHATGPT_API_ENABLED: "0" } }).service).toBeUndefined();
        expect(() => localChatGptApiRuntime({ ...options, environment: { OCTALAICANVAS_CHATGPT_API_PORT: "0" } })).toThrow("端口");
        expect(() => localChatGptApiRuntime({ ...options, environment: { OCTALAICANVAS_CHATGPT_API_KEY: "short" } })).toThrow("服务密钥");
        expect(() => localChatGptApiRuntime({ ...options, exists: () => false, environment: { OCTALAICANVAS_CHATGPT_API_ENABLED: "1" } })).toThrow("未安装");
    });
});

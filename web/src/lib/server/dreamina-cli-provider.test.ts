import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTrafficLease } from "./traffic-meter-client";

import {
    DreaminaCliSubmissionUncertainError,
    assertDreaminaCliRegularFile,
    buildDreaminaCliProxyEnvironment,
    dreaminaCliTaskDirectory,
    dreaminaCliTrafficContext,
    dreaminaCliSourceProxyUrl,
    dreaminaCliProxyCoverageUnavailable,
    parseDreaminaCliCredit,
    parseDreaminaCliQueryResult,
    parseDreaminaCliVersion,
    queryDreaminaCliTask,
    removeDreaminaCliTaskDirectory,
    safeDreaminaCliMessage,
    submitDreaminaCliTask,
    withDreaminaCliTempDirectory,
} from "./dreamina-cli-provider";
import { withTrafficContext } from "./traffic-context";

vi.mock("./traffic-meter-client", () => ({ createTrafficLease: vi.fn() }));

describe("Dreamina CLI provider", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.mocked(createTrafficLease).mockReset();
    });

    it("parses only structured version and account snapshots", () => {
        expect(parseDreaminaCliVersion('{"version":"673dd28-dirty","commit":"673dd28","build_time":"2026-08-17T16:06:28Z"}')).toEqual({ version: "673dd28-dirty", commit: "673dd28", buildTime: "2026-08-17T16:06:28Z" });
        expect(parseDreaminaCliCredit('{"total_credit":5401,"user_id":109589671187480,"user_name":"","vip_level":"maestro"}')).toEqual({ totalCredit: 5401, userId: "109589671187480", vipLevel: "maestro" });
    });

    it("passes only the verified HTTP proxy environment to the CLI child", () => {
        const child = buildDreaminaCliProxyEnvironment({
            NODE_ENV: "test",
            PATH: "/bin",
            HTTP_PROXY: "http://source.example:8080",
            ALL_PROXY: "socks5://source.example:1080",
            NO_PROXY: "localhost",
        }, "http://meter.example:3128");

        expect(child.PATH).toBe("/bin");
        expect(child.HTTP_PROXY).toBe("http://meter.example:3128");
        expect(child.HTTPS_PROXY).toBe("http://meter.example:3128");
        expect(child.ALL_PROXY).toBeUndefined();
        expect(child.NO_PROXY).toBe("");
        expect(dreaminaCliSourceProxyUrl({ NODE_ENV: "test", HTTPS_PROXY: "http://source.example:8080" })).toBe("http://source.example:8080");
        expect(dreaminaCliSourceProxyUrl({ NODE_ENV: "test", ALL_PROXY: "socks5://source.example:1080" })).toBeUndefined();
        expect(dreaminaCliProxyCoverageUnavailable({ NODE_ENV: "test", ALL_PROXY: "socks5://source.example:1080" })).toBe("all_proxy_unverified");
        expect(dreaminaCliProxyCoverageUnavailable({ NODE_ENV: "test", HTTPS_PROXY: "socks5://source.example:1080" })).toBe("http_proxy_unverified");
    });

    it("inherits the server-owned channel and model context for CLI attribution", () => {
        const context = withTrafficContext({ channelId: "dreamina-channel", channelName: "Dreamina", model: "seedream-5", protocol: "dreamina-cli", role: "submit" }, () => dreaminaCliTrafficContext("fallback-model"));
        expect(context).toMatchObject({ channelId: "dreamina-channel", model: "seedream-5", protocol: "dreamina-cli", role: "submit" });
    });

    it("does not infer a proxy mode from an HTTP proxy URL alone", () => {
        vi.stubEnv("HTTP_PROXY", "http://source.example:8080");
        expect(dreaminaCliTrafficContext("seedream-5").connectionMode).toBe("unknown");
    });

    it("uses an argv-only injected runner and never requires a real CLI in tests", async () => {
        vi.stubEnv("DREAMYO_DREAMINA_CLI_PATH", process.execPath);
        const runner = vi.fn().mockResolvedValue({ stdout: '{"submit_id":"task_123","credit_count":6}', stderr: "", exitCode: 0 });

        await expect(submitDreaminaCliTask({ command: "image_upscale", images: ["/sandbox/source.png"], resolutionType: "2k" }, { runner })).resolves.toEqual({ submitId: "task_123", creditCost: 6 });

        expect(runner).toHaveBeenCalledWith(process.execPath, ["image_upscale", "--image=/sandbox/source.png", "--resolution_type=2k", "--poll=0"], {});
    });

    it("surfaces configured traffic-meter failures before spawning the CLI", async () => {
        vi.stubEnv("DREAMYO_DREAMINA_CLI_PATH", process.execPath);
        vi.stubEnv("DREAMYO_TRAFFIC_METER_URL", "http://meter.example");
        vi.stubEnv("DREAMYO_TRAFFIC_METER_KEY", "fixture-meter-key");
        vi.mocked(createTrafficLease).mockRejectedValue(new Error("全局流量计量服务尚未配置"));
        const runner = vi.fn();

        await expect(submitDreaminaCliTask({ command: "image_upscale", images: ["/sandbox/source.png"], resolutionType: "2k" }, { runner })).rejects.toMatchObject({
            message: "全局流量计量服务尚未配置",
            status: 503,
            submissionState: "not_started",
        });
        expect(runner).not.toHaveBeenCalled();
    });

    it("rejects an unverified ALL_PROXY route when metering is configured", async () => {
        vi.stubEnv("DREAMYO_DREAMINA_CLI_PATH", process.execPath);
        vi.stubEnv("DREAMYO_TRAFFIC_METER_URL", "http://meter.example");
        vi.stubEnv("DREAMYO_TRAFFIC_METER_KEY", "fixture-meter-key");
        vi.stubEnv("ALL_PROXY", "socks5://source.example:1080");
        const runner = vi.fn();

        await expect(submitDreaminaCliTask({ command: "image_upscale", images: ["/sandbox/source.png"], resolutionType: "2k" }, { runner })).rejects.toMatchObject({
            message: "即梦 CLI 当前代理类型未验证，流量计量覆盖不可用",
            status: 503,
            submissionState: "not_started",
        });
        expect(runner).not.toHaveBeenCalled();
        expect(createTrafficLease).not.toHaveBeenCalled();
    });

    it("never treats unparseable post-spawn output as safe to resubmit", async () => {
        vi.stubEnv("DREAMYO_DREAMINA_CLI_PATH", process.execPath);
        await expect(submitDreaminaCliTask({ command: "text2video", modelId: "dreamina-seedance-2-0", prompt: "测试", videoResolution: "720p" }, { runner: async () => ({ stdout: "queued", stderr: "", exitCode: 0 }) })).rejects.toBeInstanceOf(
            DreaminaCliSubmissionUncertainError,
        );
    });

    it("treats an explicit exit-zero gen_status failure as a safe rejected submit", async () => {
        const runner = vi.fn().mockResolvedValue({ stdout: '{"submit_id":"rejected","gen_status":"fail","fail_reason":"高峰期暂时无法提交"}', stderr: "", exitCode: 0 });
        await expect(submitDreaminaCliTask({ command: "text2video", modelId: "dreamina-seedance-2-0", prompt: "测试", videoResolution: "720p" }, { runner })).rejects.toMatchObject({
            message: "高峰期暂时无法提交",
            submissionState: "safe_failure",
        });
    });

    it("accepts only files in an owned temporary sandbox", async () => {
        await withDreaminaCliTempDirectory(async (directory) => {
            const file = join(directory, "result.png");
            const nested = join(directory, "nested");
            await mkdir(nested);
            await writeFile(file, "image");
            await expect(assertDreaminaCliRegularFile(file, directory)).resolves.toBe(file);
            const linked = join(nested, "link.png");
            await symlink(file, linked);
            await expect(assertDreaminaCliRegularFile(linked, directory)).rejects.toThrow("输出文件无效");
        });
    });

    it("retains a task-scoped query directory across polling leases", async () => {
        const root = await mkdtemp(join(tmpdir(), "dreamyo-dreamina-task-root-"));
        vi.stubEnv("DREAMYO_DREAMINA_CLI_TEMP_ROOT", root);
        try {
            const first = await dreaminaCliTaskDirectory("task:stable");
            await writeFile(join(first, "pending.marker"), "pending");
            const second = await dreaminaCliTaskDirectory("task:stable");
            expect(second).toBe(first);
            await expect(access(join(second, "pending.marker"))).resolves.toBeUndefined();
            await removeDreaminaCliTaskDirectory("task:stable");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("queries through a controlled download directory and exposes no raw output", async () => {
        vi.stubEnv("DREAMYO_DREAMINA_CLI_PATH", process.execPath);
        await withDreaminaCliTempDirectory(async (directory) => {
            const output = join(directory, "result.mp4");
            const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ status: "completed", files: [output] }), stderr: "", exitCode: 0 });
            await expect(queryDreaminaCliTask({ submitId: "submit_123", downloadDir: directory }, { runner })).resolves.toEqual({ state: "succeeded", status: "completed", files: [output] });
            expect(runner.mock.calls[0]?.[1]).toEqual(["query_result", "--submit_id=submit_123", `--download_dir=${directory}`]);
        });
    });

    it("rejects unsupported query output instead of guessing an external URL", () => {
        expect(() => parseDreaminaCliQueryResult('{"status":"completed","url":"https://secret.example/result.mp4"}', "/sandbox")).toThrow("状态未知");
        expect(safeDreaminaCliMessage("request failed /private/tmp/secret.png token=abc")).not.toContain("secret.png");
    });

    it("parses the real gen_status and downloaded result_json path contract", () => {
        expect(parseDreaminaCliQueryResult('{"gen_status":"generating","result_json":{"images":[]},"credit_count":1}', "/sandbox")).toEqual({ state: "pending", status: "generating", files: [], creditCost: 1 });
        expect(parseDreaminaCliQueryResult('{"gen_status":"success","result_json":{"images":[{"path":"/sandbox/result.png","width":1328,"height":1328}],"videos":[]},"credit_count":1}', "/sandbox")).toEqual({
            state: "succeeded",
            status: "success",
            files: ["/sandbox/result.png"],
            creditCost: 1,
        });
    });
});

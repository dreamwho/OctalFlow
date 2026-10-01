import path from "node:path";

import { describe, expect, it } from "vitest";

import { localTrafficMeterRuntime } from "./traffic-meter-local-runtime.mjs";

const options = {
    repoRoot: "/project",
    webRoot: "/project/web",
    exists: () => true,
    tokenFactory: () => "fixture-traffic-meter-key-32-characters-long",
};

describe("traffic meter local runtime", () => {
    it("keeps an explicitly configured remote meter external", () => {
        const result = localTrafficMeterRuntime({
            ...options,
            environment: {
                DREAMYO_TRAFFIC_METER_URL: "https://meter.internal:18083",
                DREAMYO_TRAFFIC_METER_KEY: "configured-traffic-meter-key-32-characters-long",
            },
        });
        expect(result.service).toBeUndefined();
        expect(result.environment.DREAMYO_TRAFFIC_METER_URL).toBe("https://meter.internal:18083");
    });

    it("starts the bundled meter with the Dola Python environment and persistent state", () => {
        const result = localTrafficMeterRuntime({
            ...options,
            environment: {
                DREAMYO_DATA_DIR: "/fixture",
                TRAFFIC_METER_PORT: "19083",
                TRAFFIC_METER_BIND_HOST: "0.0.0.0",
                TRAFFIC_METER_PUBLIC_HOST: "traffic-meter",
            },
        });
        expect(result.environment).toMatchObject({
            DREAMYO_TRAFFIC_METER_URL: "http://127.0.0.1:19083",
            DREAMYO_TRAFFIC_METER_KEY: "fixture-traffic-meter-key-32-characters-long",
        });
        expect(result.service).toMatchObject({
            name: "traffic-meter",
            port: 19083,
            command: path.join("/project", "services", "dola-api", ".venv", "bin", "python"),
            args: ["-m", "uvicorn", "traffic_meter.main:app", "--host", "127.0.0.1", "--port", "19083"],
            cwd: "/project/services/traffic-meter",
        });
        expect(result.service.environment).toMatchObject({
            TRAFFIC_METER_KEY: "fixture-traffic-meter-key-32-characters-long",
            TRAFFIC_METER_BIND_HOST: "127.0.0.1",
            TRAFFIC_METER_PUBLIC_HOST: "127.0.0.1",
            TRAFFIC_METER_STATE_PATH: "/fixture/traffic-meter/traffic.sqlite3",
            PYTHONPATH: path.join("/project", "services", "traffic-meter", "src"),
        });
    });

    it("rejects remote meters without a strong key and invalid ports", () => {
        expect(() => localTrafficMeterRuntime({ ...options, environment: { DREAMYO_TRAFFIC_METER_URL: "http://meter.internal" } })).toThrow(/至少 32/);
        expect(() => localTrafficMeterRuntime({ ...options, environment: { DREAMYO_TRAFFIC_METER_KEY: "short" } })).toThrow(/至少 32/);
        expect(() => localTrafficMeterRuntime({ ...options, environment: { TRAFFIC_METER_PORT: "0" } })).toThrow(/端口/);
    });

    it("does not fail an optional local runtime when the Python executable is absent", () => {
        const result = localTrafficMeterRuntime({ ...options, exists: () => false, environment: {} });
        expect(result.service).toBeUndefined();
    });
});

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { freeServicePort, generationRuntimeEnvironment, resolveGenerationWorkerOrigin, superviseGenerationRuntime } from "./generation-runtime.mjs";

describe("generation runtime environment", () => {
    it("uses distinct configured maintenance and worker tokens", () => {
        const maintenanceToken = "a".repeat(32);
        const workerToken = "b".repeat(32);
        const result = generationRuntimeEnvironment({ environment: { DREAMYO_MAINTENANCE_TOKEN: maintenanceToken, DREAMYO_WORKER_TOKEN: workerToken, PORT: "3100" } });

        expect(result).toMatchObject({ ephemeralToken: false, environment: { DREAMYO_MAINTENANCE_TOKEN: maintenanceToken, DREAMYO_WORKER_TOKEN: workerToken, DREAMYO_WORKER_API_ORIGIN: "http://127.0.0.1:3100" } });
    });

    it("generates a process-local token only for development", () => {
        const result = generationRuntimeEnvironment({ environment: {}, allowEphemeralToken: true });

        expect(result.ephemeralToken).toBe(true);
        expect(result.environment.DREAMYO_MAINTENANCE_TOKEN).toHaveLength(64);
        expect(result.environment.DREAMYO_WORKER_TOKEN).toHaveLength(64);
        expect(result.environment.DREAMYO_WORKER_TOKEN).not.toBe(result.environment.DREAMYO_MAINTENANCE_TOKEN);
    });

    it("fails production startup before the app can run without a valid token", () => {
        expect(() => generationRuntimeEnvironment({ environment: { DREAMYO_MAINTENANCE_TOKEN: "short", DREAMYO_WORKER_TOKEN: "b".repeat(32) } })).toThrow("distinct and contain at least 32 characters");
        expect(() => generationRuntimeEnvironment({ environment: { DREAMYO_MAINTENANCE_TOKEN: "a".repeat(32), DREAMYO_WORKER_TOKEN: "a".repeat(32) } })).toThrow("distinct and contain at least 32 characters");
    });

    it("normalizes a Render private hostport to an HTTP origin", () => {
        expect(resolveGenerationWorkerOrigin({ environment: { DREAMYO_WORKER_API_ORIGIN: "dreamyo:3000" } })).toBe("http://dreamyo:3000");
    });

    it("freeServicePort safely handles invalid or system ports without throwing", () => {
        expect(() => freeServicePort(undefined)).not.toThrow();
        expect(() => freeServicePort(0)).not.toThrow();
        expect(() => freeServicePort(80)).not.toThrow();
        expect(() => freeServicePort("invalid")).not.toThrow();
    });
});

class MockChild extends EventEmitter {
    constructor(name) {
        super();
        this.name = name;
        this.exitCode = null;
        this.signalCode = null;
        this.kills = [];
    }

    kill(signal) {
        this.kills.push(signal);
        return true;
    }

    close(code = 0) {
        this.exitCode = code;
        this.emit("close", code, null);
    }
}

function runtimeFixture() {
    const signalSource = new EventEmitter();
    const names = ["traffic-meter", "geminiai", "dola-api", "web", "generation-worker"];
    const children = Object.fromEntries(names.map((name) => [name, new MockChild(name)]));
    let nextChild = 0;
    const spawnProcess = vi.fn(() => children[names[nextChild++]]);
    const completion = superviseGenerationRuntime({
        app: { command: "web", args: [], cwd: "/fixture" },
        workerScript: "/fixture/generation-worker.mjs",
        environment: { DREAMYO_DESKTOP_EDITION: "1" },
        services: [
            { name: "traffic-meter", command: "traffic-meter", args: [], cwd: "/fixture" },
            { name: "geminiai", command: "geminiai", args: [], cwd: "/fixture" },
            { name: "dola-api", command: "dola-api", args: [], cwd: "/fixture" },
        ],
        signalSource,
        spawnProcess,
    });
    return { children, completion, signalSource, spawnProcess };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("generation runtime process supervision", () => {
    it("stops non-meter children first and waits for their close events before stopping the meter", async () => {
        vi.useFakeTimers();
        const { children, completion, signalSource, spawnProcess } = runtimeFixture();

        signalSource.emit("SIGTERM");
        expect(spawnProcess).toHaveBeenCalledTimes(5);
        expect(children["traffic-meter"].kills).toEqual([]);
        expect(children.geminiai.kills).toEqual(["SIGTERM"]);
        expect(children["dola-api"].kills).toEqual(["SIGTERM"]);
        expect(children.web.kills).toEqual(["SIGTERM"]);
        expect(children["generation-worker"].kills).toEqual(["SIGTERM"]);

        children.geminiai.close();
        children["dola-api"].close();
        children.web.close();
        expect(children["traffic-meter"].kills).toEqual([]);
        children["generation-worker"].close();
        expect(children["traffic-meter"].kills).toEqual(["SIGTERM"]);
        children["traffic-meter"].close();

        await expect(completion).resolves.toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(signalSource.listenerCount("SIGINT")).toBe(0);
        expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    });

    it("stops the remaining children when the meter exits unexpectedly", async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { children, completion, signalSource } = runtimeFixture();

        children["traffic-meter"].close(2);
        expect(errorSpy).toHaveBeenCalledWith("traffic-meter process stopped unexpectedly with code 2");
        expect(children["traffic-meter"].kills).toEqual([]);
        expect(children.geminiai.kills).toEqual(["SIGTERM"]);
        expect(children["dola-api"].kills).toEqual(["SIGTERM"]);
        expect(children.web.kills).toEqual(["SIGTERM"]);
        expect(children["generation-worker"].kills).toEqual(["SIGTERM"]);

        children.geminiai.close();
        children["dola-api"].close();
        children.web.close();
        children["generation-worker"].close();

        await expect(completion).resolves.toBe(2);
        expect(vi.getTimerCount()).toBe(0);
        expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    });

    it("keeps the meter alive during unexpected provider exit and returns that exit code", async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { children, completion, signalSource } = runtimeFixture();

        children.geminiai.close(2);
        expect(errorSpy).toHaveBeenCalledWith("geminiai process stopped unexpectedly with code 2");
        expect(children["dola-api"].kills).toEqual(["SIGTERM"]);
        expect(children.web.kills).toEqual(["SIGTERM"]);
        expect(children["generation-worker"].kills).toEqual(["SIGTERM"]);
        expect(children["traffic-meter"].kills).toEqual([]);

        children["dola-api"].close();
        children.web.close();
        expect(children["traffic-meter"].kills).toEqual([]);
        children["generation-worker"].close();
        expect(children["traffic-meter"].kills).toEqual(["SIGTERM"]);
        children["traffic-meter"].close();

        await expect(completion).resolves.toBe(2);
        expect(vi.getTimerCount()).toBe(0);
        expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    });

    it("handles a child boot error without losing ordered cleanup", async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { children, completion, signalSource } = runtimeFixture();
        const bootError = new Error("fixture boot failure");

        children["dola-api"].emit("error", bootError);
        expect(errorSpy).toHaveBeenCalledWith("dola-api process failed to start", bootError);
        expect(children["traffic-meter"].kills).toEqual([]);

        children["dola-api"].close(1);
        children.geminiai.close();
        children.web.close();
        children["generation-worker"].close();
        expect(children["traffic-meter"].kills).toEqual(["SIGTERM"]);
        children["traffic-meter"].close();

        await expect(completion).resolves.toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(signalSource.listenerCount("SIGINT")).toBe(0);
        expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    });

    it("retains the five-second force shutdown for children that never close", () => {
        vi.useFakeTimers();
        const { children, signalSource } = runtimeFixture();

        signalSource.emit("SIGTERM");
        expect(children["traffic-meter"].kills).toEqual([]);
        vi.advanceTimersByTime(5_000);

        for (const child of Object.values(children)) expect(child.kills).toContain("SIGKILL");
    });
});

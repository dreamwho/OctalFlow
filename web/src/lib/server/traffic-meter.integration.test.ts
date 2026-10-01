import { createServer, type Server } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dnsMocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsMocks.lookup }));

import type { TrafficContext } from "./traffic-context";
import { fetchSafeOutbound } from "./safe-outbound-fetch";
import { createTrafficLease, queryGlobalTraffic, queryRequestTraffic, queryTaskTraffic } from "./traffic-meter-client";

const repoRoot = path.resolve(process.cwd(), "..");
const trafficMeterRoot = path.join(repoRoot, "services", "traffic-meter");
const trafficMeterSource = path.join(trafficMeterRoot, "src");
const dolaPython = path.join(repoRoot, "services", "dola-api", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

type PythonRuntime = { executable: string; reason?: never } | { executable?: never; reason: string };

function findPythonRuntime(): PythonRuntime {
    if (!existsSync(dolaPython)) return { reason: `Dola Python 不存在：${dolaPython}` };
    const check = spawnSync(dolaPython, ["-c", "import fastapi, pproxy, uvicorn"], {
        cwd: trafficMeterRoot,
        env: { ...process.env, PYTHONPATH: trafficMeterSource },
        encoding: "utf8",
        stdio: "pipe",
    });
    if (check.status !== 0) {
        const detail =
            String(check.stderr || check.stdout || "依赖导入失败")
                .trim()
                .split("\n")
                .at(-1) || "依赖导入失败";
        return { reason: `Dola Python 无 traffic-meter 依赖：${detail}` };
    }
    return { executable: dolaPython };
}

const pythonRuntime = findPythonRuntime();
const trafficMeterDescribe = "executable" in pythonRuntime ? describe : describe.skip;
const pythonExecutable = "executable" in pythonRuntime ? pythonRuntime.executable : undefined;
const suiteName = "executable" in pythonRuntime ? "Node Undici 到真实 central traffic-meter relay 的 TCP 计量" : `Node Undici 到真实 central traffic-meter relay 的 TCP 计量（跳过：${pythonRuntime.reason}）`;

trafficMeterDescribe(suiteName, () => {
    let tempRoot = "";
    let meterProcess: ChildProcess | undefined;
    let origin: Server | undefined;
    let originPort = 0;
    let observedHost = "";
    let observedBody = Buffer.alloc(0);
    let observedSocket: { bytesRead: number; bytesWritten: number } | undefined;
    let originSocketClosed: Promise<void>;
    let resolveOriginSocketClosed!: () => void;

    beforeAll(async () => {
        if (!pythonExecutable) throw new Error("reason" in pythonRuntime ? pythonRuntime.reason : "Dola Python runtime unavailable");
        dnsMocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
        vi.stubEnv("DREAMYO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("DREAMYO_PRIVATE_UPSTREAM_HOSTS", "traffic-meter-provider.invalid");
        tempRoot = await mkdtemp(path.join(tmpdir(), "dreamyo-traffic-meter-integration-"));

        originSocketClosed = new Promise<void>((resolve) => {
            resolveOriginSocketClosed = resolve;
        });
        origin = createServer((request, response) => {
            observedHost = request.headers.host || "";
            const socket = request.socket;
            socket.once("close", () => {
                observedSocket = { bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten };
                resolveOriginSocketClosed();
            });
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
            request.once("end", () => {
                observedBody = Buffer.concat(chunks);
                response.statusCode = 200;
                response.setHeader("content-type", "text/plain; charset=utf-8");
                response.setHeader("connection", "close");
                response.end("central relay response");
            });
        });
        await listen(origin, 0);
        originPort = (origin.address() as { port: number }).port;

        const meterPort = await reservePort();
        const key = randomBytes(32).toString("hex");
        vi.stubEnv("DREAMYO_TRAFFIC_METER_URL", `http://127.0.0.1:${meterPort}`);
        vi.stubEnv("DREAMYO_TRAFFIC_METER_KEY", key);

        const statePath = path.join(tempRoot, "traffic.sqlite3");
        const childEnvironment = {
            ...process.env,
            TRAFFIC_METER_KEY: key,
            TRAFFIC_METER_PORT: String(meterPort),
            TRAFFIC_METER_BIND_HOST: "127.0.0.1",
            TRAFFIC_METER_PUBLIC_HOST: "127.0.0.1",
            TRAFFIC_METER_STATE_PATH: statePath,
            PYTHONPATH: trafficMeterSource,
        };
        const script = [
            "import uvicorn",
            "from traffic_meter.main import app",
            "class ReadyServer(uvicorn.Server):",
            "    async def startup(self, sockets=None):",
            "        await super().startup(sockets=sockets)",
            "        print('TRAFFIC_METER_READY', flush=True)",
            `config = uvicorn.Config(app, host='127.0.0.1', port=${meterPort}, log_level='warning')`,
            "ReadyServer(config).run()",
        ].join("\n");
        meterProcess = spawn(pythonExecutable, ["-c", script], {
            cwd: trafficMeterRoot,
            env: childEnvironment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        await waitForReady(meterProcess);
    });

    afterAll(async () => {
        vi.unstubAllEnvs();
        if (origin) await closeServer(origin);
        if (meterProcess) await stopProcess(meterProcess);
        if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    });

    it("保留原始 Host、通过小写 traffic relay 鉴权且统计与 origin socket 字节一致", { timeout: 60_000 }, async () => {
        const providerHost = "traffic-meter-provider.invalid";
        const context: TrafficContext = {
            channelId: "traffic-meter-integration-channel",
            channelName: "Traffic Meter Integration",
            model: "traffic-meter-integration-model",
            protocol: "http",
            connectionMode: "direct",
            role: "submit",
            requestId: "integration-log",
            taskId: "integration-task",
            attemptId: "integration-attempt",
        };
        const pinnedTargets = [{ hostname: providerHost, address: "127.0.0.1" }];
        const controlLease = await createTrafficLease(undefined, context, pinnedTargets);
        expect(controlLease).not.toBeNull();
        if (!controlLease) throw new Error("central traffic-meter 未返回 relay lease");
        expect(new URL(controlLease.proxyUrl).username).toBe("traffic");
        const relayPort = Number(new URL(controlLease.proxyUrl).port);
        expect(relayPort).toBeGreaterThan(0);

        const payload = "request payload counted by the origin socket";
        const start = new Date(Date.now() - 1_000).toISOString();
        const response = await fetchSafeOutbound(
            `http://${providerHost}:${originPort}/v1/integration`,
            {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: payload,
            },
            { trafficContext: context },
        );
        expect(response.status).toBe(200);
        expect(response.status).not.toBe(407);
        await expect(response.text()).resolves.toBe("central relay response");
        await originSocketClosed;

        expect(observedHost).toBe(`${providerHost}:${originPort}`);
        expect(observedBody).toEqual(Buffer.from(payload));
        expect(observedSocket).toBeDefined();

        const summary = await queryGlobalTraffic({
            start,
            end: new Date(Date.now() + 1_000).toISOString(),
            channelId: context.channelId,
            model: context.model,
            protocol: context.protocol,
            connectionMode: context.connectionMode,
            port: 0,
        });
        expect(summary.items).toHaveLength(1);
        expect(summary.items[0]).toMatchObject({
            channelId: context.channelId,
            channelName: context.channelName,
            model: context.model,
            protocol: context.protocol,
            connectionMode: context.connectionMode,
            role: context.role,
            address: "直连",
            port: 0,
        });
        expect(summary.uploadBytes).toBe(observedSocket!.bytesRead);
        expect(summary.downloadBytes).toBe(observedSocket!.bytesWritten);
        expect(summary.totalBytes).toBe(observedSocket!.bytesRead + observedSocket!.bytesWritten);
        expect(summary.items[0]?.uploadBytes).toBe(observedSocket!.bytesRead);
        expect(summary.items[0]?.downloadBytes).toBe(observedSocket!.bytesWritten);
        const requests = await queryRequestTraffic(["integration-log", "unrelated-log"], ["integration-task", "unrelated-task"]);
        expect(requests.items).toHaveLength(1);
        expect(requests.items[0]).toMatchObject({ requestId: "integration-log", totalBytes: summary.totalBytes, items: [{ role: "submit", connectionMode: "direct", attemptId: "integration-attempt" }] });
        expect(requests.tasks).toHaveLength(1);
        expect(requests.tasks?.[0]).toMatchObject({ taskId: "integration-task", totalBytes: summary.totalBytes });
        const tasks = await queryTaskTraffic({ start, end: new Date(Date.now() + 1_000).toISOString(), page: 1, pageSize: 20 });
        expect(tasks.items).toHaveLength(1);
        expect(tasks.items[0]).toMatchObject({ taskId: "integration-task", totalBytes: summary.totalBytes });

        await controlLease.release();
        await expectRelayClosed(relayPort);
    });
});

function listen(server: Server, port: number) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
    });
}

function closeServer(server: Server) {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function reservePort() {
    const server = createServer();
    await listen(server, 0);
    const port = (server.address() as { port: number }).port;
    await closeServer(server);
    return port;
}

function waitForReady(child: ChildProcess) {
    return new Promise<void>((resolve, reject) => {
        let output = "";
        const onChunk = (chunk: Buffer | string) => {
            output += chunk.toString();
            if (output.includes("TRAFFIC_METER_READY")) {
                cleanup();
                resolve();
            }
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            reject(new Error(`traffic-meter 未就绪（code=${code ?? "null"}, signal=${signal ?? "null"}）：${output}`));
        };
        const cleanup = () => {
            child.stdout?.off("data", onChunk);
            child.stderr?.off("data", onChunk);
            child.off("error", onError);
            child.off("exit", onExit);
        };
        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);
        child.once("error", onError);
        child.once("exit", onExit);
    });
}

function stopProcess(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const done = () => {
            child.off("exit", done);
            child.off("error", done);
            resolve();
        };
        child.once("exit", done);
        child.once("error", done);
        if (!child.kill("SIGTERM") && (child.exitCode !== null || child.signalCode !== null)) done();
    });
}

function expectRelayClosed(port: number) {
    return new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            reject(new Error(`traffic-meter lease 仍保持 relay 端口 ${port} 开放`));
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET" || error.code === "EPIPE") resolve();
            else reject(error);
        });
    });
}

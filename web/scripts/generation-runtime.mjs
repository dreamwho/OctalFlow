import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const MIN_TOKEN_LENGTH = 32;

export function generationRuntimeEnvironment({ environment = process.env, allowEphemeralToken = false } = {}) {
    const source = { ...environment };
    const maintenanceToken = source.DREAMYO_MAINTENANCE_TOKEN?.trim() || "";
    const workerToken = source.DREAMYO_WORKER_TOKEN?.trim() || "";
    if (!allowEphemeralToken && (maintenanceToken.length < MIN_TOKEN_LENGTH || workerToken.length < MIN_TOKEN_LENGTH || maintenanceToken === workerToken)) {
        throw new Error("DREAMYO_MAINTENANCE_TOKEN and DREAMYO_WORKER_TOKEN must be distinct and contain at least 32 characters");
    }

    const port = validPort(source.PORT) || 3000;
    const resolvedMaintenanceToken = maintenanceToken.length >= MIN_TOKEN_LENGTH ? maintenanceToken : randomBytes(32).toString("hex");
    let resolvedWorkerToken = workerToken.length >= MIN_TOKEN_LENGTH ? workerToken : randomBytes(32).toString("hex");
    if (resolvedWorkerToken === resolvedMaintenanceToken) resolvedWorkerToken = randomBytes(32).toString("hex");
    return {
        environment: {
            ...source,
            DREAMYO_MAINTENANCE_TOKEN: resolvedMaintenanceToken,
            DREAMYO_WORKER_TOKEN: resolvedWorkerToken,
            DREAMYO_WORKER_API_ORIGIN: resolveGenerationWorkerOrigin({ environment: source, fallbackOrigin: `http://127.0.0.1:${port}` }),
        },
        ephemeralToken: maintenanceToken.length < MIN_TOKEN_LENGTH || workerToken.length < MIN_TOKEN_LENGTH || maintenanceToken === workerToken,
    };
}

export function resolveGenerationWorkerOrigin({ environment = process.env, fallbackOrigin = "http://127.0.0.1:3000" } = {}) {
    const raw = environment.DREAMYO_WORKER_API_ORIGIN?.trim() || environment.DREAMYO_INTERNAL_ORIGIN?.trim() || environment.NEXT_PUBLIC_SITE_URL?.trim() || fallbackOrigin;
    const value = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Generation worker origin must use HTTP or HTTPS");
    return url.origin;
}

export function superviseGenerationRuntime({ app, workerScript, environment, services = [] }) {
    if (!environment.DREAMYO_DESKTOP_EDITION) services.forEach((service) => freeServicePort(service?.port, service?.name));
    const definitions = [...services, { name: "web", command: app.command, args: app.args, cwd: app.cwd }, { name: "generation-worker", command: process.execPath, args: [workerScript], cwd: app.cwd }];
    const children = definitions.map((definition) => ({
        ...definition,
        process: spawn(definition.command, definition.args, { cwd: definition.cwd, env: definition.environment || environment, stdio: "inherit" }),
    }));

    return new Promise((resolve) => {
        let closed = 0;
        let stopping = false;
        let requestedExitCode = 0;
        let forceTimer;

        const cleanup = () => {
            process.off("SIGINT", stopForSignal);
            process.off("SIGTERM", stopForSignal);
            if (forceTimer) clearTimeout(forceTimer);
        };
        const stop = (exitCode) => {
            if (stopping) return;
            stopping = true;
            requestedExitCode = exitCode;
            for (const child of children) {
                if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGTERM");
            }
            forceTimer = setTimeout(() => {
                for (const child of children) {
                    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
                }
            }, 5_000);
            forceTimer.unref();
        };
        const stopForSignal = () => stop(0);

        process.once("SIGINT", stopForSignal);
        process.once("SIGTERM", stopForSignal);
        for (const child of children) {
            child.process.once("error", (error) => {
                console.error(`${child.name} process failed to start`, error);
                stop(1);
            });
            child.process.once("close", (code) => {
                closed += 1;
                if (!stopping) {
                    console.error(`${child.name} process stopped unexpectedly with code ${code ?? "unknown"}`);
                    stop(code && code > 0 ? code : 1);
                }
                if (closed === children.length) {
                    cleanup();
                    resolve(requestedExitCode);
                }
            });
        }
    });
}

/** 本地固定端口上若有上次运行残留的 sidecar 进程（未随上次关闭），先清理再启动，
 *  避免新 sidecar 绑定失败或新旧进程密钥不一致导致整栈不可用。
 *  【安全关键】：lsof 必须携带 -a 强制 AND 逻辑；且必须防御性白名单检查，
 *  绝不杀死系统服务、桌面应用（.app）或非本项目侧车进程。 */
export function freeServicePort(port, serviceName = "") {
    const parsedPort = validPort(port);
    if (!parsedPort || parsedPort < 1024) return;
    try {
        const out = execFileSync("lsof", ["-ti", "-a", `-iTCP:${parsedPort}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 5_000 });
        const pids = out.split("\n").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
        const killedPids = [];
        for (const pid of pids) {
            if (pid === process.pid || pid === process.ppid) continue;
            try {
                const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
                if (cmd.includes(".app/") || cmd.startsWith("/System/") || cmd.startsWith("/usr/") || cmd.startsWith("/sbin/")) {
                    console.warn(`[runtime] 端口 ${parsedPort} 被外部/桌面应用占用 (PID ${pid}: ${cmd.slice(0, 60)})，跳过清理`);
                    continue;
                }
                process.kill(pid, "SIGKILL");
                killedPids.push(pid);
            } catch {}
        }
        if (killedPids.length) {
            console.log(`[runtime] 端口 ${parsedPort}${serviceName ? ` (${serviceName})` : ""} 存在残留进程 ${killedPids.join(", ")}，已清理后重启服务`);
        }
    } catch {}
}

function validPort(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}

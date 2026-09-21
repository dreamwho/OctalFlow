import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export async function startDesktopRuntime({ app, edition }) {
    const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.resolve(import.meta.dirname, "../../../..");
    const webRoot = path.join(runtimeRoot, "web");
    const entry = path.join(webRoot, "scripts", "start-standalone.mjs");
    const dataRoot = path.join(app.getPath("userData"), "data");
    const secrets = await readOrCreateRuntimeSecrets(path.join(app.getPath("userData"), "runtime-secrets.json"));
    const port = await availableLoopbackPort();
    const [geminiPort, dolaPort, chatGptPort] = await Promise.all([availableLoopbackPort(), availableLoopbackPort(), availableLoopbackPort()]);
    const origin = `http://127.0.0.1:${port}`;
    const environment = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        DREAMYO_INTERNAL_ORIGIN: origin,
        DREAMYO_WORKER_API_ORIGIN: origin,
        DREAMYO_DATABASE_PROVIDER: "file",
        DREAMYO_DATA_DIR: dataRoot,
        DREAMYO_GEMINIAI_PORT: String(geminiPort),
        DREAMYO_DOLA_PROVIDER_PORT: String(dolaPort),
        DREAMYO_CHATGPT_API_PORT: String(chatGptPort),
        DREAMYO_GEMINIAI_URL: "",
        DREAMYO_GEMINIAI_API_KEY: "",
        DREAMYO_DOLA_PROVIDER_URL: "",
        DREAMYO_DOLA_PROVIDER_KEY: "",
        DREAMYO_CHATGPT_API_URL: "",
        DREAMYO_CHATGPT_API_KEY: "",
        DREAMYO_ENCRYPTION_KEY: secrets.encryptionKey,
        DREAMYO_INSTALL_TOKEN: secrets.installToken,
        DREAMYO_DESKTOP_ADMIN_PASSWORD: secrets.adminPassword,
        DREAMYO_DESKTOP_SESSION_TOKEN: secrets.sessionToken,
        DREAMYO_DESKTOP_EDITION: edition.id,
        DREAMYO_DESKTOP_CLOUD_ORIGIN: process.env.DREAMYO_DESKTOP_CLOUD_ORIGIN?.trim() || "",
        DREAMYO_COOKIE_SECURE: "0",
        ...(app.isPackaged ? {
            DREAMYO_DESKTOP_PACKAGED: "1",
            DREAMYO_GEMINIAI_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("geminiai")),
            DREAMYO_DOLA_PROVIDER_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("dola-api")),
            DREAMYO_CHATGPT_API_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("chatgpt-api")),
            DOLA_CAMOUFOX_BROWSER: path.join(runtimeRoot, "sidecars", "camoufox", process.platform === "win32" ? "camoufox.exe" : "camoufox"),
            AISTUDIO_BROWSER_EXECUTABLE: path.join(runtimeRoot, "sidecars", "camoufox", process.platform === "win32" ? "camoufox.exe" : "camoufox"),
            AISTUDIO_BROWSER_LAUNCHER_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("geminiai-browser")),
        } : {}),
    };
    const child = spawn(process.execPath, [entry], { cwd: webRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => process.stdout.write(`[web] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[web] ${chunk}`));

    const ready = waitForRuntime(origin, child);
    return {
        origin,
        sessionToken: secrets.sessionToken,
        ready,
        stop: () => stopChild(child),
    };
}

async function readOrCreateRuntimeSecrets(file) {
    try {
        const value = JSON.parse(await readFile(file, "utf8"));
        if ([value.encryptionKey, value.installToken, value.adminPassword].every((item) => typeof item === "string" && item.length >= 32)) {
            if (value.sessionToken) {
                delete value.sessionToken;
                await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
            }
            return { ...value, sessionToken: randomBytes(32).toString("base64url") };
        }
        throw new Error("Desktop runtime secrets file is invalid; refusing to replace the encryption key");
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    const value = {
        encryptionKey: randomBytes(32).toString("hex"),
        installToken: randomBytes(32).toString("base64url"),
        adminPassword: randomBytes(32).toString("base64url"),
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(file, 0o600);
    return { ...value, sessionToken: randomBytes(32).toString("base64url") };
}

async function availableLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function waitForRuntime(origin, child) {
    let delay = 100;
    while (child.exitCode === null) {
        try {
            const response = await fetch(`${origin}/api/desktop/runtime`, { signal: AbortSignal.timeout(2_000) });
            if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(1_000, Math.ceil(delay * 1.5));
    }
    throw new Error(`Desktop web runtime exited before it became ready (code ${child.exitCode})`);
}

function stopChild(child) {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => undefined);
        return;
    }
    child.kill("SIGTERM");
}

function executableName(name) {
    return process.platform === "win32" ? `${name}.exe` : name;
}

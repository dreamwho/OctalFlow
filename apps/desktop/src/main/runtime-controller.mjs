import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { prepareDesktopMagicProxy } from "./magic-proxy-runtime.mjs";

export async function startDesktopRuntime({ app, edition, safeStorage, onProgress }) {
    const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.resolve(import.meta.dirname, "../../../..");
    const distDir = app.isPackaged ? JSON.parse(await readFile(path.join(runtimeRoot, "manifest.json"), "utf8")).distDir : process.env.NEXT_DIST_DIR?.trim() || ".next";
    const webRoot = path.join(runtimeRoot, "web");
    const entry = path.join(webRoot, "scripts", "start-standalone.mjs");
    const dataRoot = path.join(app.getPath("userData"), "data");
    const secrets = await readOrCreateRuntimeSecrets(path.join(app.getPath("userData"), "runtime-secrets.bin"), safeStorage);
    const mainToken = randomBytes(32).toString("base64url");
    const port = await availableLoopbackPort();
    const [geminiPort, dolaPort, chatGptPort, controllerPort, proxyGeminiPort, proxyToolsPort, proxyChatPort, proxyDolaPort] = await Promise.all(Array.from({ length: 8 }, () => availableLoopbackPort()));
    const origin = `http://127.0.0.1:${port}`;
    const browserMajor = app.isPackaged ? Number(JSON.parse(await readFile(path.join(runtimeRoot, "sidecars", "camoufox", "version.json"), "utf8")).version?.split(".")[0]) : null;
    if (app.isPackaged && (!Number.isInteger(browserMajor) || browserMajor < 1)) throw new Error("桌面安装包的 Camoufox 版本文件无效");
    const magicProxy = app.isPackaged ? await prepareDesktopMagicProxy({
        runtimeRoot, dataRoot, executable: path.join(runtimeRoot, "sidecars", executableName("mihomo")), secret: secrets.installToken,
        ports: { controller: controllerPort, geminiai: proxyGeminiPort, geminiTools: proxyToolsPort, chatgptApi: proxyChatPort, dola: proxyDolaPort },
    }) : null;
    const environment = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        NEXT_DIST_DIR: distDir,
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
        DREAMYO_DESKTOP_MAIN_TOKEN: mainToken,
        DREAMYO_DESKTOP_EDITION: edition.id,
        DREAMYO_DESKTOP_CLOUD_ORIGIN: edition.id === "commercial" ? (edition.cloudOrigin || process.env.DREAMYO_DESKTOP_CLOUD_ORIGIN?.trim() || "") : "",
        DREAMYO_COOKIE_SECURE: "0",
        ...(magicProxy ? { ...magicProxy.environment, DREAMYO_DESKTOP_MIHOMO_EXECUTABLE: magicProxy.service.command, DREAMYO_DESKTOP_MIHOMO_HOME: magicProxy.service.cwd,
            FFMPEG_PATH: path.join(runtimeRoot, "sidecars", executableName("ffmpeg")),
            DREAMYO_DREAMINA_CLI_PATH: path.join(runtimeRoot, "sidecars", executableName("dreamina")),
            DREAMYO_VIDEO_DEPTH_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("video-depth")),
            DREAMYO_VIDEO_DEPTH_MODEL: path.join(runtimeRoot, "sidecars", "video-depth-model"),
        } : {}),
        ...(app.isPackaged ? {
            DREAMYO_DESKTOP_PACKAGED: "1",
            DREAMYO_DOLA_API_ENABLED: "1",
            DREAMYO_CHATGPT_API_ENABLED: "1",
            DOLA_ENABLE_BROWSER: "1",
            DOLA_BROWSER_ENGINE: "camoufox",
            DREAMYO_GEMINIAI_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("geminiai")),
            DREAMYO_DOLA_PROVIDER_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("dola-api")),
            DREAMYO_CHATGPT_API_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("chatgpt-api")),
            DOLA_CAMOUFOX_EXECUTABLE: bundledCamoufox(runtimeRoot),
            DOLA_CAMOUFOX_FF_VERSION: String(browserMajor),
            AISTUDIO_CAMOUFOX_EXECUTABLE: bundledCamoufox(runtimeRoot),
            AISTUDIO_CAMOUFOX_FF_VERSION: String(browserMajor),
            AISTUDIO_BROWSER_LAUNCHER_EXECUTABLE: path.join(runtimeRoot, "sidecars", executableName("geminiai-browser")),
            AISTUDIO_PLAYWRIGHT_DRIVER_PACKAGE: path.join(runtimeRoot, "sidecars", "playwright-driver"),
            PLAYWRIGHT_NODEJS_PATH: process.execPath,
        } : {}),
    };
    const child = spawn(process.execPath, [entry], { cwd: webRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => process.stdout.write(`[web] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[web] ${chunk}`));

    const ready = waitForRuntime(origin, child, app.isPackaged ? [
        { name: "GeminiAIStudio", url: `http://127.0.0.1:${geminiPort}/health`, status: 200 },
        { name: "Dola API", url: `http://127.0.0.1:${dolaPort}/health`, status: 200 },
        { name: "GPTAPI", url: `http://127.0.0.1:${chatGptPort}/integration/health`, status: 401 },
    ] : [], onProgress);
    return {
        origin,
        sessionToken: secrets.sessionToken,
        mainToken,
        ready,
        stop: () => stopChild(child),
    };
}

export async function readOrCreateRuntimeSecrets(file, safeStorage) {
    if (!safeStorage?.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法保护桌面 Runtime 凭据");
    const legacyFile = file.replace(/\.bin$/, ".json");
    try {
        const value = validRuntimeSecrets(JSON.parse(safeStorage.decryptString(await readFile(file))));
        await rm(legacyFile, { force: true });
        return { ...value, sessionToken: randomBytes(32).toString("base64url") };
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    let value;
    try { value = validRuntimeSecrets(JSON.parse(await readFile(legacyFile, "utf8"))); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    value ||= {
        encryptionKey: randomBytes(32).toString("hex"),
        installToken: randomBytes(32).toString("base64url"),
        adminPassword: randomBytes(32).toString("base64url"),
    };
    await mkdir(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        await writeFile(temporaryFile, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600, flag: "wx" });
        if (process.platform !== "win32") await chmod(temporaryFile, 0o600);
        await rename(temporaryFile, file);
    } finally { await rm(temporaryFile, { force: true }); }
    await rm(legacyFile, { force: true });
    return { ...value, sessionToken: randomBytes(32).toString("base64url") };
}

function validRuntimeSecrets(value) {
    if (!value || [value.encryptionKey, value.installToken, value.adminPassword].some((item) => typeof item !== "string" || item.length < 32)) {
        throw new Error("Desktop runtime secrets file is invalid; refusing to replace the encryption key");
    }
    return { encryptionKey: value.encryptionKey, installToken: value.installToken, adminPassword: value.adminPassword };
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

export async function waitForRuntime(origin, child, providers = [], onProgress) {
    const pending = new Set([{ name: "Web", url: `${origin}/api/desktop/runtime`, status: 200 }, ...providers]);
    const began = Date.now();
    let delay = 100;
    while (child.exitCode === null && child.signalCode === null) {
        await Promise.all([...pending].map(async (target) => {
            try {
                const response = await fetch(target.url, { signal: AbortSignal.timeout(2_000) });
                if (response.status === target.status && pending.delete(target)) {
                    console.info(`[desktop-runtime] ${target.name} ready in ${Date.now() - began}ms`);
                    onProgress?.(target.name, [...pending].map((item) => item.name));
                }
            } catch {}
        }));
        if (!pending.size) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(1_000, Math.ceil(delay * 1.5));
    }
    throw new Error(`Desktop runtime exited before ${[...pending].map((item) => item.name).join("、")} became ready (code ${child.exitCode ?? child.signalCode})`);
}

function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        child.once("close", resolve);
        if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => undefined);
        else child.kill("SIGTERM");
    });
}

function executableName(name) {
    return process.platform === "win32" ? `${name}.exe` : name;
}

function bundledCamoufox(runtimeRoot) {
    return path.join(runtimeRoot, "sidecars", "camoufox", process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : "camoufox.exe");
}

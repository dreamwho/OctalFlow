import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export class CloudDeviceHttpError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

export class CloudDeviceNetworkError extends Error {
    constructor(cause) { super("无法连接云端设备授权服务", { cause }); }
}

export function isTemporaryCloudFailure(error) {
    return (error instanceof CloudDeviceHttpError && error.status >= 500) || error instanceof CloudDeviceNetworkError;
}

export function createCloudDeviceAuth({ cloudOrigin, userData, safeStorage, fetchImpl = fetch, packaged = false }) {
    const origin = validateCloudOrigin(cloudOrigin, packaged);
    const credentialsFile = path.join(userData, "cloud-device-credentials.bin");
    const revocationsFile = path.join(userData, "cloud-device-revocations.bin");
    let pendingDeviceCode = "";
    let accessToken = "";
    let accessExpiresAt = "";
    let refreshToken = "";
    let cachedUser = null;
    let currentPromise = null;
    let authEpoch = 0;
    let signingOut = false;
    let credentialMutation = Promise.resolve();

    function mutateCredentials(action) {
        const operation = credentialMutation.then(action, action);
        credentialMutation = operation.then(() => undefined, () => undefined);
        return operation;
    }

    async function request(endpoint, body, authorization = "") {
        if (!origin) throw new Error("请先配置 DREAMYO_DESKTOP_CLOUD_ORIGIN 为云端站点地址");
        let response;
        try {
            response = await fetchImpl(new URL(`/api/desktop/devices/${endpoint}`, origin), {
                method: body === undefined ? "GET" : "POST",
                redirect: "error",
                headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch (error) { throw new CloudDeviceNetworkError(error); }
        const payload = await response.json().catch(() => null);
        if (!response.ok && response.status !== 202) throw new CloudDeviceHttpError(payload?.msg || `云端设备授权失败（HTTP ${response.status}）`, response.status);
        if (!payload?.data) throw new Error("云端设备授权响应无效");
        return payload.data;
    }

    async function loadRefreshToken() {
        if (refreshToken) return refreshToken;
        try {
            const encrypted = await readFile(credentialsFile);
            if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法读取设备凭据");
            const decrypted = safeStorage.decryptString(encrypted);
            const stored = decrypted.startsWith("{") ? JSON.parse(decrypted) : { refreshToken: decrypted };
            if (stored.origin && stored.origin !== origin) throw new Error("设备凭据属于另一个云端站点");
            if (!/^[A-Za-z0-9_-]{43}$/.test(stored.refreshToken || "")) throw new Error("设备凭据文件无效");
            refreshToken = stored.refreshToken;
            cachedUser = stored.user?.status === "active" && /^[a-zA-Z0-9_-]{16,128}$/.test(stored.user.id || "") ? stored.user : null;
            return refreshToken;
        } catch (error) {
            if (error?.code === "ENOENT") return "";
            throw error;
        }
    }

    async function writeEncrypted(file, value) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，设备凭据未保存");
        const encrypted = safeStorage.encryptString(JSON.stringify(value));
        await mkdir(userData, { recursive: true });
        const temporaryFile = `${file}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            await writeFile(temporaryFile, encrypted, { mode: 0o600, flag: "wx" });
            if (process.platform !== "win32") await chmod(temporaryFile, 0o600);
            await rename(temporaryFile, file);
        } finally { await rm(temporaryFile, { force: true }); }
        if (process.platform !== "win32") await chmod(file, 0o600);
    }

    async function readRevocations() {
        try {
            const stored = JSON.parse(safeStorage.decryptString(await readFile(revocationsFile)));
            if (stored.origin !== origin || !Array.isArray(stored.tokens) || stored.tokens.some((token) => !/^[A-Za-z0-9_-]{43}$/.test(token))) throw new Error("待撤销设备凭据文件无效");
            return stored.tokens;
        } catch (error) {
            if (error?.code === "ENOENT") return [];
            throw error;
        }
    }

    async function saveRevocations(tokens) {
        if (tokens.length) await writeEncrypted(revocationsFile, { origin, tokens });
        else await rm(revocationsFile, { force: true });
    }

    async function flushRevocations() {
        const tokens = await readRevocations();
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            try { await request("revoke", { refreshToken: token }); }
            catch { return; }
            await saveRevocations(tokens.slice(index + 1));
        }
    }

    async function saveCredentials(result, user = cachedUser, expectedEpoch = authEpoch) {
        return mutateCredentials(async () => {
            if (signingOut || expectedEpoch !== authEpoch) throw new CloudDeviceHttpError("设备已退出登录", 401);
            await writeEncrypted(credentialsFile, { origin, refreshToken: result.refreshToken, user });
            if (signingOut || expectedEpoch !== authEpoch) throw new CloudDeviceHttpError("设备已退出登录", 401);
            refreshToken = result.refreshToken;
            accessToken = result.accessToken;
            accessExpiresAt = result.accessExpiresAt;
            cachedUser = user;
        });
    }

    async function currentUser() {
        if (signingOut) throw new CloudDeviceHttpError("设备正在退出登录", 401);
        if (!currentPromise) currentPromise = (async () => {
            const epoch = authEpoch;
            await flushRevocations();
            if (!await loadRefreshToken()) return null;
            if (!accessToken || Date.parse(accessExpiresAt) <= Date.now()) {
                const result = await request("refresh", { refreshToken });
                if (epoch !== authEpoch) throw new CloudDeviceHttpError("设备已退出登录", 401);
                await saveCredentials(result, cachedUser, epoch);
            }
            const user = (await request("me", undefined, accessToken)).user;
            if (epoch !== authEpoch) throw new CloudDeviceHttpError("设备已退出登录", 401);
            await saveCredentials({ accessToken, refreshToken, accessExpiresAt }, user, epoch);
            return user;
        })().finally(() => { currentPromise = null; });
        return currentPromise;
    }

    return {
        configured: Boolean(origin),
        origin,
        async start(deviceLabel) {
            await flushRevocations();
            const result = await request("start", { deviceLabel });
            pendingDeviceCode = result.deviceCode;
            return { userCode: result.userCode, verificationUrl: result.verificationUrl, expiresAt: result.expiresAt };
        },
        async finish() {
            if (signingOut) throw new CloudDeviceHttpError("设备正在退出登录", 401);
            const epoch = authEpoch;
            await flushRevocations();
            if (!pendingDeviceCode) throw new Error("请先发起设备授权");
            const result = await request("exchange", { deviceCode: pendingDeviceCode });
            if (result.status === "pending") return { status: "pending" };
            await saveCredentials(result, null, epoch);
            const user = (await request("me", undefined, accessToken)).user;
            await saveCredentials(result, user, epoch);
            pendingDeviceCode = "";
            return { status: "authorized", user };
        },
        current: currentUser,
        async cloudStorage(action, input = {}) {
            const { path: requestPath, method, headers, body, binary } = cloudStorageRequest(action, input);
            if (!await currentUser()) throw new CloudDeviceHttpError("请先登录云端账号", 401);
            let response;
            try {
                response = await fetchImpl(new URL(requestPath, origin), {
                    method, headers: { Authorization: `Bearer ${accessToken}`, ...headers }, ...(body ? { body } : {}),
                    redirect: "error", cache: "no-store",
                });
            } catch (error) { throw new CloudDeviceNetworkError(error); }
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new CloudDeviceHttpError(payload?.msg || `云端存储请求失败（HTTP ${response.status}）`, response.status);
            }
            if (binary) return { bytes: new Uint8Array(await response.arrayBuffer()), checksumSha256: response.headers.get("x-dreamyo-sha256") || "" };
            const payload = await response.json().catch(() => null);
            if (!payload?.data) throw new Error("云端存储响应无效");
            return payload.data;
        },
        async cachedIdentity() {
            if (!await loadRefreshToken()) return null;
            return cachedUser;
        },
        getAccessToken() { return accessToken; },
        async logout() {
            if (signingOut) throw new CloudDeviceHttpError("设备正在退出登录", 401);
            signingOut = true;
            authEpoch++;
            try {
                let revokeError;
                try {
                    const token = await loadRefreshToken();
                    if (token) {
                        try { await request("revoke", { refreshToken: token }); }
                        catch (error) {
                            if (!isTemporaryCloudFailure(error)) throw error;
                            await saveRevocations([...await readRevocations(), token]);
                        }
                    }
                } catch (error) { revokeError = error; }
                await mutateCredentials(async () => {
                    refreshToken = "";
                    accessToken = "";
                    accessExpiresAt = "";
                    pendingDeviceCode = "";
                    cachedUser = null;
                    await rm(credentialsFile, { force: true });
                });
                if (revokeError) throw revokeError;
            } finally {
                signingOut = false;
            }
        },
    };
}

function cloudStorageRequest(action, input) {
    if (action === "usage") return { path: "/api/cloud-storage/usage", method: "GET" };
    if (action === "list") {
        const page = Number(input.page || 1);
        const pageSize = Number(input.pageSize || 20);
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("云端备份分页参数无效");
        return { path: `/api/cloud-storage/backups?page=${page}&pageSize=${pageSize}`, method: "GET" };
    }
    if (action === "upload") {
        const { projectId, title, checksumSha256, bytes } = input;
        if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 160 || typeof title !== "string" || !title.trim() || title.length > 200 ||
            typeof checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(checksumSha256) || !(bytes instanceof Uint8Array) || !bytes.length) throw new Error("云端项目备份参数无效");
        return { path: "/api/cloud-storage/objects", method: "POST", body: bytes, headers: {
            "Content-Type": "application/zip", "x-dreamyo-source": "backup", "x-dreamyo-content-bytes": String(bytes.length),
            "x-dreamyo-sha256": checksumSha256, "x-dreamyo-project-id": projectId, "x-dreamyo-project-title": encodeURIComponent(title),
        } };
    }
    if (action === "download" || action === "delete") {
        const referenceId = input.referenceId;
        if (typeof referenceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(referenceId)) throw new Error("云端备份编号无效");
        return { path: `/api/cloud-storage/backups/${referenceId}`, method: action === "delete" ? "DELETE" : "GET", binary: action === "download" };
    }
    throw new Error("不支持的云端存储操作");
}

export function validateCloudOrigin(value, packaged) {
    if (!value?.trim()) return "";
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error("云端站点地址无效"); }
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && !packaged))) {
        throw new Error("云端站点必须使用 HTTPS；本机开发允许 loopback HTTP");
    }
    return url.origin;
}

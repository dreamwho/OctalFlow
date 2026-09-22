import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareDesktopMagicProxy } from "./magic-proxy-runtime.mjs";

test("desktop Mihomo uses private user data, loopback listeners and independent provider ports", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dreamyo-mihomo-"));
    const runtimeRoot = path.join(directory, "runtime");
    const dataRoot = path.join(directory, "data");
    try {
        await mkdir(path.join(runtimeRoot, "desktop"), { recursive: true });
        const template = await readFile(path.resolve(import.meta.dirname, "../../../../docker/mihomo/bootstrap.yaml"), "utf8");
        await writeFile(path.join(runtimeRoot, "desktop/mihomo-bootstrap.yaml"), template);
        const ports = { controller: 29090, geminiai: 27890, geminiTools: 27891, chatgptApi: 27892, dola: 27893 };
        const secret = "private-secret-with-at-least-thirty-two-chars";
        const first = await prepareDesktopMagicProxy({ runtimeRoot, dataRoot, executable: "/bundle/mihomo", secret, ports });
        const config = await readFile(path.join(dataRoot, "mihomo/config.yaml"), "utf8");
        assert.match(config, /external-controller: 127\.0\.0\.1:29090/);
        assert.match(config, /port: 27893/);
        assert.doesNotMatch(config, /0\.0\.0\.0|1789[0-3]|\/root\/\.config/);
        assert.match(config, new RegExp(`secret: ${JSON.stringify(secret)}`));
        assert.equal(first.environment.DREAMYO_MAGIC_PROXY_DOLA_URL, "http://127.0.0.1:27893");
        assert.equal(first.environment.DREAMYO_MAGIC_PROXY_GEMINI_TOOLS_PORT, "27891");
        assert.deepEqual(first.service.args, ["-d", path.join(dataRoot, "mihomo")]);
        const providerFile = first.environment.DREAMYO_MAGIC_PROXY_PROVIDER_FILE;
        assert.equal(await readFile(providerFile, "utf8"), "proxies: []\n");
        await writeFile(providerFile, "proxies:\n  - name: preserved\n");
        await prepareDesktopMagicProxy({ runtimeRoot, dataRoot, executable: "/bundle/mihomo", secret, ports });
        assert.match(await readFile(providerFile, "utf8"), /preserved/);
        if (process.platform !== "win32") {
            assert.equal((await stat(path.join(dataRoot, "mihomo/config.yaml"))).mode & 0o777, 0o600);
            assert.equal((await stat(providerFile)).mode & 0o777, 0o600);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

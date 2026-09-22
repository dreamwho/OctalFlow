import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareRuntime } from "./prepare-runtime.mjs";

test("packaging copies only compiled runtime and never imports account data or env files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dreamyo-desktop-stage-"));
    const source = path.join(directory, "source");
    const standalone = path.join(source, "web/.next/standalone");
    const sidecars = path.join(directory, "sidecars", `${process.platform}-${process.arch}`);
    const output = path.join(directory, "output");
    try {
        for (const entry of ["node_modules", ".next", "src", "public", "scripts", ".data"]) await mkdir(path.join(standalone, entry), { recursive: true });
        await mkdir(path.join(source, "web/.next/static"), { recursive: true });
        await mkdir(path.join(source, "web/public"), { recursive: true });
        await mkdir(path.join(source, "web/scripts"), { recursive: true });
        for (const service of ["geminiai", "dola-api"]) await mkdir(path.join(source, "services", service, "src"), { recursive: true });
        await mkdir(path.join(source, "docker", "mihomo"), { recursive: true });
        await mkdir(sidecars, { recursive: true });
        await mkdir(path.join(sidecars, "camoufox"), { recursive: true });
        const extension = process.platform === "win32" ? ".exe" : "";
        for (const binary of ["dola-api", "geminiai", "chatgpt-api", "geminiai-browser", "mihomo", "ffmpeg", "ffprobe", "dreamina", "video-depth"]) await writeFile(path.join(sidecars, `${binary}${extension}`), "binary");
        await mkdir(path.join(sidecars, "video-depth-model"), { recursive: true });
        for (const file of ["config.json", "model.safetensors", "preprocessor_config.json"]) await writeFile(path.join(sidecars, "video-depth-model", file), "model");
        const camoufox = path.join(sidecars, "camoufox", process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : "camoufox.exe");
        await mkdir(path.dirname(camoufox), { recursive: true });
        await writeFile(camoufox, "binary");
        await writeFile(path.join(path.dirname(camoufox), "properties.json"), "[]");
        await writeFile(path.join(sidecars, "camoufox", "version.json"), '{"version":"135.0.1"}');
        await writeFile(path.join(standalone, "server.js"), "server");
        await writeFile(path.join(standalone, "package.json"), "{}");
        await writeFile(path.join(standalone, ".data", "cookie.txt"), "never ship me");
        await writeFile(path.join(source, "web/.env.local"), "never ship me");
        await writeFile(path.join(source, "web/.next/BUILD_ID"), "test-build");
        await writeFile(path.join(source, "services/geminiai/config.yaml"), "browser: camoufox");
        await mkdir(path.join(source, "services/chatgpt-api"), { recursive: true });
        await writeFile(path.join(source, "services/chatgpt-api/LICENSE.upstream"), "upstream license");
        await writeFile(path.join(source, "services/chatgpt-api/NOTICE.upstream"), "upstream notice");
        await writeFile(path.join(source, "docker/mihomo/bootstrap.yaml"), "mode: rule\n");
        await writeFile(path.join(source, "web/scripts/start-standalone.mjs"), "runtime");

        const result = await prepareRuntime({ edition: "admin", sourceRoot: source, outputRoot: output, bundledSidecars: path.join(directory, "sidecars") });

        assert.equal(result.manifest.webBuildId, "test-build");
        assert.equal(await readFile(path.join(output, "web/.next/standalone/server.js"), "utf8"), "server");
        assert.equal(await stat(path.join(output, "web/.next/standalone/.data")).catch(() => null), null);
        assert.equal(await stat(path.join(output, "web/.env.local")).catch(() => null), null);
        assert.equal(await readFile(path.join(output, "desktop/mihomo-bootstrap.yaml"), "utf8"), "mode: rule\n");
        assert.equal(await readFile(path.join(output, "services/chatgpt-api/LICENSE.upstream"), "utf8"), "upstream license");
        await rm(path.join(sidecars, `mihomo${extension}`));
        await assert.rejects(() => prepareRuntime({ edition: "admin", sourceRoot: source, outputRoot: output, bundledSidecars: path.join(directory, "sidecars") }), /mihomo/);
        await writeFile(path.join(sidecars, `mihomo${extension}`), "binary");
        await rm(path.join(path.dirname(camoufox), "properties.json"));
        await assert.rejects(() => prepareRuntime({ edition: "admin", sourceRoot: source, outputRoot: output, bundledSidecars: path.join(directory, "sidecars") }), /properties\.json/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

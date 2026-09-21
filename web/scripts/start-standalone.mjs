import path from "node:path";
import { fileURLToPath } from "node:url";

import { localGeminiAiRuntime } from "./geminiai-local-runtime.mjs";
import { localChatGptApiRuntime } from "./chatgpt-api-local-runtime.mjs";
import { localDolaApiRuntime } from "./dola-api-local-runtime.mjs";
import { generationRuntimeEnvironment, superviseGenerationRuntime } from "./generation-runtime.mjs";
import { prepareStandaloneAssets } from "./standalone-assets.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next";
const { standaloneRoot } = process.env.DREAMYO_DESKTOP_PACKAGED === "1"
    ? { standaloneRoot: path.join(webRoot, distDir, "standalone") }
    : await prepareStandaloneAssets({ webRoot, distDir });
const geminiAi = localGeminiAiRuntime({ repoRoot, webRoot });
const chatGptApi = localChatGptApiRuntime({ repoRoot, webRoot, environment: geminiAi.environment });
const dolaApi = localDolaApiRuntime({ repoRoot, webRoot, environment: chatGptApi.environment });

const runtime = generationRuntimeEnvironment({
    allowEphemeralToken: true,
    environment: {
        ...process.env,
        ...chatGptApi.environment,
        ...dolaApi.environment,
        PORT: process.env.PORT || "3333",
        HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
        DREAMYO_DATA_DIR: process.env.DREAMYO_DATA_DIR || path.join(webRoot, ".data"),
        DREAMYO_INTERNAL_ORIGIN: process.env.DREAMYO_INTERNAL_ORIGIN || `http://127.0.0.1:${process.env.PORT || "3333"}`,
        DREAMYO_VIDEO_DEPTH_PYTHON: process.env.DREAMYO_VIDEO_DEPTH_PYTHON || path.join(repoRoot, "services", "video-depth", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
        DREAMYO_VIDEO_DEPTH_SCRIPT: process.env.DREAMYO_VIDEO_DEPTH_SCRIPT || path.join(repoRoot, "services", "video-depth", "infer_depth_frames.py"),
        DREAMYO_VIDEO_DEPTH_MODEL: process.env.DREAMYO_VIDEO_DEPTH_MODEL || path.join(repoRoot, "services", "video-depth", "models", "depth-anything-v2-small-hf"),
    },
});
process.exitCode = await superviseGenerationRuntime({
    app: { command: process.execPath, args: ["server.js"], cwd: standaloneRoot },
    workerScript: path.join(webRoot, "scripts", "generation-worker.mjs"),
    environment: runtime.environment,
    services: [geminiAi.service, chatGptApi.service, dolaApi.service].filter(Boolean),
});

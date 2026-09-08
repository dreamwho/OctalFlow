import path from "node:path";
import { fileURLToPath } from "node:url";

import { localGeminiAiRuntime } from "./geminiai-local-runtime.mjs";
import { generationRuntimeEnvironment, superviseGenerationRuntime } from "./generation-runtime.mjs";
import { prepareStandaloneAssets } from "./standalone-assets.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next";
const { standaloneRoot } = await prepareStandaloneAssets({ webRoot, distDir });
const geminiAi = localGeminiAiRuntime({ repoRoot, webRoot });

const runtime = generationRuntimeEnvironment({
    allowEphemeralToken: true,
    environment: {
        ...geminiAi.environment,
        PORT: process.env.PORT || "3333",
        HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
        OCTALAICANVAS_DATA_DIR: process.env.OCTALAICANVAS_DATA_DIR || path.join(webRoot, ".data"),
        OCTALAICANVAS_INTERNAL_ORIGIN: process.env.OCTALAICANVAS_INTERNAL_ORIGIN || `http://127.0.0.1:${process.env.PORT || "3333"}`,
        OCTALAICANVAS_VIDEO_DEPTH_PYTHON: process.env.OCTALAICANVAS_VIDEO_DEPTH_PYTHON || path.join(repoRoot, "services", "video-depth", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
        OCTALAICANVAS_VIDEO_DEPTH_SCRIPT: process.env.OCTALAICANVAS_VIDEO_DEPTH_SCRIPT || path.join(repoRoot, "services", "video-depth", "infer_depth_frames.py"),
        OCTALAICANVAS_VIDEO_DEPTH_MODEL: process.env.OCTALAICANVAS_VIDEO_DEPTH_MODEL || path.join(repoRoot, "services", "video-depth", "models", "depth-anything-v2-small-hf"),
    },
});
process.exitCode = await superviseGenerationRuntime({
    app: { command: process.execPath, args: ["server.js"], cwd: standaloneRoot },
    workerScript: path.join(webRoot, "scripts", "generation-worker.mjs"),
    environment: runtime.environment,
    services: geminiAi.service ? [geminiAi.service] : [],
});

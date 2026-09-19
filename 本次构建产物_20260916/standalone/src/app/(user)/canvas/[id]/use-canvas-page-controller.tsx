"use client";

import { useCanvasGenerationActions } from "./use-canvas-generation-actions";
import { useCanvasInteractions } from "./use-canvas-interactions";
import { useCanvasMediaActions } from "./use-canvas-media-actions";
import { useCanvasPageState } from "./use-canvas-page-state";
import { useCanvasPersistenceEffects } from "./use-canvas-persistence-effects";
import { useCanvasTaskRuntime } from "./use-canvas-task-runtime";
import { useCanvasVideoFrameExtraction } from "./use-canvas-video-frame-extraction";

export function useCanvasPageController() {
    const state = useCanvasPageState();
    const tasks = useCanvasTaskRuntime({ state });
    useCanvasVideoFrameExtraction({ state });
    useCanvasPersistenceEffects({ state, tasks });
    const interactions = useCanvasInteractions({ state });
    const media = useCanvasMediaActions({ state, tasks, interactions });
    const generation = useCanvasGenerationActions({ state, tasks, interactions });
    return { ...state, ...tasks, ...interactions, ...media, ...generation };
}

export type CanvasPageController = ReturnType<typeof useCanvasPageController>;

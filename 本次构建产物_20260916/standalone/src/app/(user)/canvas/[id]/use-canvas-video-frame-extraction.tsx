"use client";

import { useEffect, useRef } from "react";

import { parseServerMediaUrl } from "@/services/server-media-storage";
import { CanvasNodeType, type CanvasNodeData, type CanvasVideoFrameSelection } from "../types";

import { extractCanvasVideoFrames, type CanvasVideoFrameAsset } from "./canvas-video-frame-api";

import type { CanvasPageState } from "./use-canvas-page-state";

export function useCanvasVideoFrameExtraction({ state }: { state: Pick<CanvasPageState, "nodes" | "setNodes"> }) {
    const requested = useRef(new Set<string>());
    const { nodes, setNodes } = state;

    useEffect(() => {
        const candidates = nodes.flatMap((node) => {
            const storageKey = videoStorageKey(node);
            if (!storageKey || node.type !== CanvasNodeType.Video || node.metadata?.status !== "success" || node.metadata?.videoFrameExtraction?.sourceStorageKey === storageKey || requested.current.has(`${node.id}:${storageKey}`)) return [];
            return [{ node, storageKey }];
        });
        for (const { node, storageKey } of candidates) {
            const requestKey = `${node.id}:${storageKey}`;
            requested.current.add(requestKey);
            void extractCanvasVideoFrames({ storageKey, mode: "both" })
                .then(({ firstFrame, lastFrame }) => {
                    if (!firstFrame || !lastFrame) throw new Error("视频首尾帧提取不完整");
                    setNodes((current) =>
                        current.map((item) =>
                            item.id === node.id && videoStorageKey(item) === storageKey
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          videoFrameExtraction: {
                                              sourceStorageKey: storageKey,
                                              firstFrame: frameSelection(item, firstFrame, "首帧"),
                                              lastFrame: frameSelection(item, lastFrame, "尾帧"),
                                          },
                                          videoFrameExtractionError: undefined,
                                      },
                                  }
                                : item,
                        ),
                    );
                })
                .catch((error) => {
                    const detail = error instanceof Error ? error.message : "视频首尾帧提取失败";
                    setNodes((current) => current.map((item) => (item.id === node.id && videoStorageKey(item) === storageKey ? { ...item, metadata: { ...item.metadata, videoFrameExtractionError: detail } } : item)));
                });
        }
    }, [nodes, setNodes]);
}

export function videoStorageKey(node: CanvasNodeData) {
    const explicit = node.metadata?.storageKey?.trim();
    if (explicit) return explicit;
    const source = node.metadata?.serverUrl || node.metadata?.content || "";
    const parsed = parseServerMediaUrl(source);
    return parsed?.scope === "reference" || parsed?.scope === "generation" ? parsed.storageKey : "";
}

export function frameSelection(node: CanvasNodeData, frame: CanvasVideoFrameAsset, label: "首帧" | "尾帧"): CanvasVideoFrameSelection {
    return {
        nodeId: node.id,
        title: `${node.title || "视频"}${label}`,
        source: frame.storageKey,
        storageKey: frame.storageKey,
        previewUrl: frame.serverUrl,
        serverUrl: frame.serverUrl,
        mimeType: frame.mimeType,
        width: frame.width,
        height: frame.height,
    };
}

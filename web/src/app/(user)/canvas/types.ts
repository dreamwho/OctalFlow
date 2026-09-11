import type { CreativeVideoReferenceMode, VideoReferenceRole } from "@/lib/video-reference-contract";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Panorama = "panorama",
    Text = "text",
    Config = "config",
    Video = "video",
    VideoRemake = "video-remake",
    Audio = "audio",
    Brief = "brief",
    Task = "task",
    BrandKit = "brand-kit",
}

export function isCanvasImageNodeType(type: CanvasNodeType | null | undefined) {
    return type === CanvasNodeType.Image || type === CanvasNodeType.Panorama;
}

type CanvasNodeStatus = "idle" | "success" | "loading" | "error" | "needs_review" | "cancelled";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";
export type CanvasImageTaskKind = CanvasImageGenerationType | "upscale";

export type CanvasInteriorDesignScene = "interior" | "interior-light" | "exterior" | "enclosed";

export type CanvasInteriorDesignSettings = {
    scene: CanvasInteriorDesignScene;
    task: string;
    conversion: string;
    spaceType: string;
    style: string;
    exteriorView: string;
    location: string;
    season: string;
    weather: string;
    time: string;
    curtain: string;
    mainLight: boolean;
    artificialLight: boolean;
    sunlight: string;
    indoorLight: string;
    colorTemperature: string;
    postTone: string;
    lightingQuality: string;
    camera: string;
    aperture: string;
    shutter: string;
    iso: string;
    focalLength: string;
    techniques: string[];
    geometry: string;
    objectIntegrity: string;
    materialIntegrity: string;
    aspectRatio: string;
    resolution: string;
};

export type CameraControlOptions = {
    enabled: boolean;
    camera: string;
    lens: string;
    focalLength: number;
    aperture: number;
};

export type CanvasVideoFrameSelection = {
    nodeId?: string;
    title: string;
    source: string;
    previewUrl?: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
};

/**
 * Persisted frame assets derived from the media owned by a video node. These
 * are deliberately separate from videoFirstFrame/videoLastFrame, which belong
 * to a target generation request and describe its requested roles.
 */
export type CanvasVideoFrameExtraction = {
    sourceStorageKey: string;
    firstFrame: CanvasVideoFrameSelection;
    lastFrame: CanvasVideoFrameSelection;
};

export type CanvasVideoReferenceSnapshot = {
    type: "image" | "video" | "audio";
    role: VideoReferenceRole;
    id: string;
    name: string;
    mimeType: string;
    source: string;
    previewUrl?: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type CanvasNodeMetadata = {
    configKind?: "interior-design";
    interiorDesign?: CanvasInteriorDesignSettings;
    runningHubAppId?: string;
    runningHubAppName?: string;
    agentRunId?: string;
    agentTaskId?: string;
    agentGenerationTaskIds?: string[];
    agentTaskStatus?: "ready" | "pending" | "running" | "paused" | "waiting_user" | "completed" | "failed" | "cancelled";
    agentTaskType?: CanvasGenerationMode;
    agentTaskDependencies?: string[];
    agentTaskOutputNodeIds?: string[];
    agentTaskAttempts?: number;
    agentTaskError?: string;
    agentBrief?: {
        objective: string;
        audience?: string;
        usage?: string;
        coreMessage?: string;
        referenceStrategy?: string;
        tone?: string[];
        deliverables?: Array<{ type: string; title: string; count?: number; ratio?: string; requirements?: string[] }>;
        constraints?: string[];
    };
    brandKit?: {
        summary?: string;
        style?: string;
        composition?: string;
        colors?: string[];
        lighting?: string;
        keywords?: string[];
        visualKeywords?: string[];
        avoid?: string[];
        typography?: string[];
        approvedNodeIds?: string[];
        rejectedNodeIds?: string[];
    };
    content?: string;
    composerContent?: string;
    prompt?: string;
    sourcePrompt?: string;
    executionPrompt?: string;
    selectedSkillIds?: string[];
    remakeMode?: "universal" | "vlog" | "drama" | "talking-head" | "product" | "tutorial";
    status?: CanvasNodeStatus;
    generationProgress?: number;
    generationStartedAt?: number;
    generationFinishedAt?: number;
    generationExpectedMs?: number;
    generationStage?: string;
    errorDetails?: string;
    fontSize?: number;
    configDetailsOpen?: boolean;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    size?: string;
    sizeUserSelected?: boolean;
    quality?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoReferenceMode?: CreativeVideoReferenceMode;
    videoFirstFrame?: CanvasVideoFrameSelection;
    videoLastFrame?: CanvasVideoFrameSelection;
    videoReferences?: CanvasVideoReferenceSnapshot[];
    videoFrameExtraction?: CanvasVideoFrameExtraction;
    videoFrameExtractionError?: string;
    audioVoice?: string;
    audioMode?: "tts" | "voice-design" | "voice-clone" | "music";
    audioFormat?: string;
    audioSpeed?: string;
    audioVolume?: string;
    audioPitch?: string;
    audioEmotion?: string;
    audioLanguageBoost?: string;
    audioSampleRate?: string;
    audioBitrate?: string;
    audioChannel?: string;
    audioLyrics?: string;
    audioIsInstrumental?: boolean;
    audioLyricsOptimizer?: boolean;
    audioInstructions?: string;
    cameraControl?: CameraControlOptions;
    cameraMotions?: Record<
        string,
        {
            label: string;
            prompt: string;
            previewClass?: string;
        }
    >;
    panoramaProjection?: "equirectangular";
    panoramaSourcePrompt?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    derivedVideoOperation?: "depth";
    derivedFromNodeId?: string;
    videoTask?: {
        id: string;
        provider: "openai" | "seedance" | "dreamina-cli" | "generation";
        model: string;
        pollPath?: string;
        serverTaskId?: string;
    };
    imageTask?: {
        id: string;
        kind: CanvasImageTaskKind;
        model: string;
    };
    upscaleTask?: {
        id: string;
        provider: "dreamina-cli";
        model: string;
        resolutionType: "2k" | "4k" | "8k";
        sourceNodeId: string;
    };
    textTask?: {
        id: string;
        model: string;
    };
    audioTask?: {
        id: string;
        model: string;
        attemptNo?: number;
    };
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeType;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    runId?: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
    skills?: Array<{ id: string; name: string }>;
    createdAt?: string;
};

export type CanvasAssistantSession = {
    id: string;
    conversationId?: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };

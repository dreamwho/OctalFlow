export type CanvasCameraMotionPreset = {
    id: string;
    label: string;
    description: string;
    prompt: string;
    previewClass: string;
    previewImage: string;
};

export type CanvasCameraMotionSelection = Pick<CanvasCameraMotionPreset, "id" | "label" | "prompt" | "previewClass"> & { description?: string; previewImage?: string };
export type CanvasCameraMotionDefinitions = Record<string, Pick<CanvasCameraMotionSelection, "label" | "prompt"> & Partial<Pick<CanvasCameraMotionSelection, "previewClass">>>;

export const DEFAULT_CAMERA_MOTION_PREVIEW = "/canvas/camera-motion-wide.webp";

export const CANVAS_CAMERA_MOTIONS: CanvasCameraMotionPreset[] = [
    { id: "locked", label: "固定镜头", description: "机位锁定，画面由主体动作推进", prompt: "固定机位，镜头无位移，仅保留自然呼吸感，主体动作连续。", previewClass: "canvas-motion-locked", previewImage: DEFAULT_CAMERA_MOTION_PREVIEW },
    { id: "dolly-in", label: "缓慢推近", description: "由环境推进人物情绪", prompt: "摄影机沿光轴缓慢推近主体，速度均匀，景别自然收紧，不改变轴线。", previewClass: "canvas-motion-dolly-in", previewImage: "/canvas/camera-motion-orbit-close.webp" },
    { id: "dolly-out", label: "缓慢拉远", description: "逐步揭示空间和人物处境", prompt: "摄影机沿光轴缓慢拉远，逐步揭示环境关系，主体比例变化平滑。", previewClass: "canvas-motion-dolly-out", previewImage: DEFAULT_CAMERA_MOTION_PREVIEW },
    { id: "pan-left", label: "镜头左摇", description: "水平向左发现新的画面信息", prompt: "摄影机从右向左平稳摇摄，保持地平线稳定，以主体动作作为起止点。", previewClass: "canvas-motion-pan-left", previewImage: "/canvas/camera-motion-tracking-side.webp" },
    { id: "pan-right", label: "镜头右摇", description: "水平向右跟随或揭示", prompt: "摄影机从左向右平稳摇摄，保持地平线稳定，以主体动作作为起止点。", previewClass: "canvas-motion-pan-right", previewImage: "/canvas/camera-motion-low-angle.webp" },
    { id: "tilt-up", label: "镜头上摇", description: "由低处向上揭示人物或建筑", prompt: "摄影机由下向上平稳摇摄，垂直透视自然，从细节过渡到主体全貌。", previewClass: "canvas-motion-tilt-up", previewImage: "/canvas/camera-motion-low-angle.webp" },
    { id: "tilt-down", label: "镜头下摇", description: "由全貌向下落到动作细节", prompt: "摄影机由上向下平稳摇摄，从空间全貌落到主体动作细节，速度均匀。", previewClass: "canvas-motion-tilt-down", previewImage: "/canvas/camera-motion-high-angle.webp" },
    { id: "tracking", label: "跟随拍摄", description: "与人物保持稳定距离移动", prompt: "摄影机与主体同速跟随，保持构图和距离稳定，背景产生自然视差。", previewClass: "canvas-motion-tracking", previewImage: "/canvas/camera-motion-tracking-side.webp" },
    { id: "orbit-left", label: "左向环绕", description: "围绕主体建立空间层次", prompt: "摄影机围绕主体向左小幅环绕，保持主体居中，前后景产生连续视差。", previewClass: "canvas-motion-orbit-left", previewImage: "/canvas/camera-motion-orbit-close.webp" },
    {
        id: "handheld",
        label: "手持跟拍",
        description: "真实微抖与现场呼吸感",
        prompt: "贴近主体手持跟拍，保留克制微抖、自然步伐起伏和即时构图修正，避免剧烈晃动。",
        previewClass: "canvas-motion-handheld",
        previewImage: "/canvas/camera-motion-orbit-close.webp",
    },
];

export function getCanvasCameraMotion(id?: string, custom?: Partial<CanvasCameraMotionSelection>) {
    return (
        CANVAS_CAMERA_MOTIONS.find((item) => item.id === id) ||
        (id && custom?.prompt
            ? {
                  id,
                  label: custom.label || "自定义运镜",
                  prompt: custom.prompt,
                  description: custom.description || "我的运镜",
                  previewClass: custom.previewClass || inferCameraMotionPreviewClass(custom.prompt),
                  previewImage: custom.previewImage || DEFAULT_CAMERA_MOTION_PREVIEW,
              }
            : undefined)
    );
}

export function cameraMotionPromptToken(motion: Pick<CanvasCameraMotionSelection, "label">) {
    return `【${motion.label}\u3000】`;
}

export function applyCameraMotionPrompt(prompt: string, definitions?: CanvasCameraMotionDefinitions) {
    const motions = new Map(CANVAS_CAMERA_MOTIONS.map((motion) => [motion.label, motion.prompt]));
    Object.values(definitions || {}).forEach((motion) => motions.set(motion.label, motion.prompt));

    return prompt.replace(/【([^\n】]+)】/g, (token, label: string) => motions.get(label.trim()) || token).trim();
}

export function inferCameraMotionPreviewClass(prompt: string) {
    if (/拉远|后退|dolly\s*out/i.test(prompt)) return "canvas-motion-dolly-out";
    if (/推近|推进|靠近|dolly\s*in/i.test(prompt)) return "canvas-motion-dolly-in";
    if (/左摇|向左|pan\s*left/i.test(prompt)) return "canvas-motion-pan-left";
    if (/右摇|向右|pan\s*right/i.test(prompt)) return "canvas-motion-pan-right";
    if (/上摇|向上|tilt\s*up/i.test(prompt)) return "canvas-motion-tilt-up";
    if (/下摇|向下|tilt\s*down/i.test(prompt)) return "canvas-motion-tilt-down";
    if (/环绕|orbit/i.test(prompt)) return "canvas-motion-orbit-left";
    if (/手持|微抖|handheld/i.test(prompt)) return "canvas-motion-handheld";
    if (/固定|锁定|locked/i.test(prompt)) return "canvas-motion-locked";
    return "canvas-motion-tracking";
}

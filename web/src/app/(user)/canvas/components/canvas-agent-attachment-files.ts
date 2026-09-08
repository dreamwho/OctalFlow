export function isCanvasAgentTextFile(file: File) {
    return file.type === "text/plain" || file.type === "text/markdown" || /\.(?:md|markdown|txt)$/i.test(file.name);
}

export function isCanvasAgentAttachmentFile(file: File) {
    return file.type.startsWith("image/") || file.type.startsWith("video/") || isCanvasAgentTextFile(file);
}

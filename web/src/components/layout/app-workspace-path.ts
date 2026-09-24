export function isFullscreenWorkspacePath(pathname: string) {
    return pathname === "/create" || pathname === "/image" || pathname === "/assets" || /^\/(?:canvas|drama)\/[^/]+(?:\/|$)/.test(pathname);
}

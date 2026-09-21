"use client";

import { useEffect } from "react";

const CHUNK_ERROR_PATTERN = /Loading chunk \d|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;
const AUTO_RELOAD_KEY = "dreamyo-global-error-auto-reload-at";

function shouldAutoReload(error: unknown) {
    const message = error instanceof Error ? `${error.message}` : "";
    if (!CHUNK_ERROR_PATTERN.test(message)) return false;
    const now = Date.now();
    try {
        const previous = Number(sessionStorage.getItem(AUTO_RELOAD_KEY) || 0);
        if (now - previous < 30_000) return false;
        sessionStorage.setItem(AUTO_RELOAD_KEY, String(now));
        return true;
    } catch {
        return true;
    }
}

/** global-error 独立于应用渲染（自带 html/body，应用 CSS 与主题 Provider 不可用）：
 *  必须用自包含样式实现品牌视觉，不使用 antd/Tailwind，避免被残留文档样式或缺失上下文影响。 */
export default function GlobalError({ error, reset }: { error: unknown; reset: () => void }) {
    useEffect(() => {
        if (shouldAutoReload(error)) window.location.reload();
    }, [error]);

    return (
        <html lang="zh-CN">
            <head>
                <title>页面加载失败 | dreamyo</title>
                <style>{`
                    .dge-page { align-items: center; background: linear-gradient(135deg, #eef4ff 0%, #e8fbfa 52%, #f2edff 100%); box-sizing: border-box; color: #12245f; display: flex; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; height: 100vh; justify-content: center; margin: 0; padding: 24px; }
                    .dge-card { background: rgba(255,255,255,.88); border: 1px solid rgba(126,150,235,.35); border-radius: 24px; box-shadow: 0 24px 70px rgba(70,102,220,.16); box-sizing: border-box; max-width: 440px; padding: 34px 30px; text-align: center; width: 100%; }
                    .dge-mark { display: block; margin: 0 auto 18px; }
                    .dge-title { color: #12245f; font-size: 20px; font-weight: 650; margin: 0 0 10px; }
                    .dge-desc { color: #3d568c; font-size: 14px; line-height: 1.7; margin: 0 0 6px; }
                    .dge-hint { color: #60739d; font-size: 12px; line-height: 1.7; margin: 0 0 22px; }
                    .dge-actions { align-items: center; display: flex; gap: 12px; justify-content: center; }
                    .dge-btn { border-radius: 999px; cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 500; padding: 9px 22px; transition: transform .15s ease, box-shadow .15s ease, filter .15s ease; }
                    .dge-btn-primary { background: linear-gradient(90deg, #3978ff, #28cfe0 52%, #9b79f7); border: 0; color: #fff; box-shadow: 0 8px 20px rgba(57,120,255,.28); }
                    .dge-btn-primary:hover { filter: brightness(1.06); transform: translateY(-1px); }
                    .dge-btn-secondary { background: rgba(255,255,255,.75); border: 1px solid #b9caff; color: #244394; }
                    .dge-btn-secondary:hover { background: #fff; border-color: #8fa6ff; }
                    @media (prefers-color-scheme: dark) {
                        .dge-page { background: linear-gradient(135deg, #081225 0%, #0a1a2a 52%, #131230 100%); color: #edf4ff; }
                        .dge-card { background: rgba(13,24,46,.9); border-color: rgba(96,138,232,.4); box-shadow: 0 24px 70px rgba(2,8,24,.6); }
                        .dge-title { color: #edf4ff; }
                        .dge-desc { color: #a9badb; }
                        .dge-hint { color: #8297c3; }
                        .dge-btn-secondary { background: rgba(19,34,64,.75); border-color: rgba(96,138,232,.45); color: #d9e5ff; }
                        .dge-btn-secondary:hover { background: rgba(28,46,84,.9); border-color: rgba(129,163,255,.7); }
                    }
                `}</style>
            </head>
            <body className="dge-page">
                <main className="dge-card">
                    <img className="dge-mark" src="/brand/dreamyo/mark.png" alt="dreamyo" width={52} height={52} />
                    <h1 className="dge-title">页面加载失败</h1>
                    <p className="dge-desc">站点更新后浏览器缓存可能引用了失效资源，已尝试自动恢复。</p>
                    <p className="dge-hint">若仍未恢复，请使用 Ctrl+F5 / Cmd+Shift+R 强制刷新，或清除浏览器缓存后重试。</p>
                    <div className="dge-actions">
                        <button type="button" className="dge-btn dge-btn-primary" onClick={() => window.location.reload()}>
                            重新加载
                        </button>
                        <button type="button" className="dge-btn dge-btn-secondary" onClick={reset}>
                            重试渲染
                        </button>
                    </div>
                </main>
            </body>
        </html>
    );
}

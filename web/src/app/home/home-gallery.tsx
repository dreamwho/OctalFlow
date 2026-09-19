"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "antd";
import { ImageOff, Play, Sparkles } from "lucide-react";

import { LazyMediaImage } from "@/components/media/lazy-media-image";
import { ResponsiveMasonryGrid } from "@/components/works/responsive-masonry-grid";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { listPublicGallery, type PublicGalleryItem } from "@/services/api/work-governance";
import styles from "./home.module.css";

export function HomeGallery() {
    const [previewItem, setPreviewItem] = useState<PublicGalleryItem>();
    const query = useQuery({
        queryKey: ["home-public-gallery", "random"],
        queryFn: () => listPublicGallery({ limit: 16, sort: "random" }),
        staleTime: 60_000,
    });
    const items = query.data?.items || [];

    const handleApplyPrompt = (item: PublicGalleryItem) => {
        const text = item.publicPrompt?.trim() || item.description?.trim() || item.title?.trim();
        if (!text) return;
        const event = new CustomEvent("dreamyo:apply-prompt", {
            detail: {
                prompt: text,
                mode: item.preview?.mediaType === "video" ? "video" : "image",
            },
        });
        window.dispatchEvent(event);
    };

    return (
        <section id="inspiration" className={styles.section} aria-labelledby="home-gallery-title">
            <div className="flex items-center justify-between mb-6 max-w-7xl mx-auto px-4">
                <h3 id="home-gallery-title" className="text-xl md:text-2xl font-bold tracking-tight text-white">
                    灵感发现🔥
                </h3>
            </div>

            {query.isLoading ? (
                <div className={styles.galleryGrid} aria-label="正在加载公开作品">
                    {Array.from({ length: 8 }, (_, index) => (
                        <GallerySkeleton key={index} />
                    ))}
                </div>
            ) : items.length ? (
                <ResponsiveMasonryGrid
                    className="grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
                    ariaLabel="公开作品灵感列表"
                >
                    {items.map((item) => (
                        <HomeWorkCard
                            key={item.slug}
                            item={item}
                            onPreview={() => setPreviewItem(item)}
                            onApplyPrompt={() => handleApplyPrompt(item)}
                        />
                    ))}
                </ResponsiveMasonryGrid>
            ) : null}

            <HomeMediaPreview item={previewItem} onClose={() => setPreviewItem(undefined)} />
        </section>
    );
}

function HomeWorkCard({
    item,
    onPreview,
    onApplyPrompt,
}: {
    item: PublicGalleryItem;
    onPreview: () => void;
    onApplyPrompt: () => void;
}) {
    const [mediaFailed, setMediaFailed] = useState(false);
    const [duration, setDuration] = useState(0);
    const preview = item.preview;

    return (
        <article className="group" data-testid="home-gallery-card">
            <h4 className="mb-1.5 truncate text-[13px] font-medium text-zinc-200" title={item.title}>
                {item.title}
            </h4>
            <button
                type="button"
                className="block w-full overflow-hidden rounded-xl border border-white/5 bg-zinc-900/50 text-left transition-all duration-300 hover:border-indigo-500/40"
                aria-label={`查看作品：${item.title}`}
                onClick={onPreview}
            >
                <span className={styles.workMediaMasonry}>
                    {mediaFailed || !preview || (preview.mediaType !== "image" && preview.mediaType !== "video") ? (
                        <span className={styles.mediaFallback} role="img" aria-label="作品预览不可用">
                            <ImageOff aria-hidden="true" />
                            <span>预览不可用</span>
                        </span>
                    ) : preview.mediaType === "image" ? (
                        <LazyMediaImage
                            src={imagePreviewUrl(preview.url, 640)}
                            alt={item.title}
                            containerClassName={styles.workImageWrapMasonry}
                            imageClassName="w-full h-auto object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                            errorLabel="作品图片不可用"
                        />
                    ) : (
                        <video
                            src={preview.url}
                            muted
                            playsInline
                            preload="metadata"
                            className="block w-full h-auto transition-transform duration-500 group-hover:scale-[1.03]"
                            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                            onError={() => setMediaFailed(true)}
                        />
                    )}

                    {item.category ? (
                        <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-full text-[11px] font-medium bg-black/55 backdrop-blur-md text-zinc-200 border border-white/10">
                            {item.category}
                        </span>
                    ) : null}

                    {preview?.mediaType === "video" ? (
                        <span className={styles.playIcon}>
                            <Play aria-hidden="true" fill="currentColor" />
                        </span>
                    ) : null}
                    {preview?.mediaType === "video" && duration > 0 ? (
                        <span className={styles.duration}>{formatDuration(duration)}</span>
                    ) : null}
                </span>
            </button>
            <button
                type="button"
                className="mt-1.5 w-full py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] active:bg-white/[0.16] border border-white/10 text-zinc-300 hover:text-white text-xs font-medium flex items-center justify-center gap-1.5 transition-all"
                onClick={() => onApplyPrompt()}
            >
                <Sparkles size={13} className="text-amber-300" />
                <span>做同款</span>
            </button>
        </article>
    );
}

function HomeMediaPreview({ item, onClose }: { item?: PublicGalleryItem; onClose: () => void }) {
    const preview = item?.preview;
    const supported = preview?.mediaType === "image" || preview?.mediaType === "video";
    return (
        <Modal
            open={Boolean(item && supported)}
            onCancel={onClose}
            footer={null}
            centered
            width="auto"
            destroyOnHidden
            title={null}
            styles={{
                container: { padding: 0, overflow: "hidden" },
                body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "88dvh" },
            }}
        >
            {item && preview?.mediaType === "image" ? (
                <img
                    src={imagePreviewUrl(preview.url, 1920)}
                    alt={item.title}
                    className="block max-h-[88dvh] max-w-[min(92vw,1440px)] object-contain"
                />
            ) : null}
            {item && preview?.mediaType === "video" ? (
                <video
                    src={preview.url}
                    aria-label={item.title}
                    className="block max-h-[88dvh] max-w-[min(92vw,1440px)] object-contain"
                    controls
                    autoPlay
                    playsInline
                />
            ) : null}
        </Modal>
    );
}

function GallerySkeleton() {
    return (
        <div className={styles.gallerySkeleton}>
            <span />
            <i />
            <i />
        </div>
    );
}

function formatDuration(seconds: number) {
    const safe = Math.max(0, Math.round(seconds));
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

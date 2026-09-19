"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "antd";
import { ArrowRight, ImageOff, Play } from "lucide-react";

import { LazyMediaImage } from "@/components/media/lazy-media-image";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { listPublicGallery, type PublicGalleryItem } from "@/services/api/work-governance";
import { HOME_GALLERY_TABS, homeGalleryMatches, type HomeGalleryTab } from "./home-data";
import styles from "./home.module.css";

export function HomeGallery() {
    const [tab, setTab] = useState<HomeGalleryTab>("all");
    const [previewItem, setPreviewItem] = useState<PublicGalleryItem>();
    const query = useQuery({
        queryKey: ["home-public-gallery", "random"],
        queryFn: () => listPublicGallery({ limit: 18, sort: "random" }),
        staleTime: 60_000,
    });
    const items = (query.data?.items || []).filter((item) => homeGalleryMatches(item, tab));

    return (
        <section id="inspiration" className={styles.section} aria-labelledby="home-gallery-title">
            <header className={styles.sectionHeading}>
                <h2 id="home-gallery-title">灵感作品</h2>
                <p>从灵感到作品，让 AI 创造更美好的明天</p>
            </header>

            <div className={styles.galleryTabs} role="tablist" aria-label="作品分类">
                {HOME_GALLERY_TABS.map((item) => (
                    <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls="home-gallery-panel" className={tab === item.id ? styles.galleryTabActive : undefined} onClick={() => setTab(item.id)}>
                        {item.label}
                    </button>
                ))}
            </div>

            <div id="home-gallery-panel" role="tabpanel" className={styles.galleryPanel}>
                {query.isLoading ? (
                    <div className={styles.galleryGrid} aria-label="正在加载公开作品">
                        {Array.from({ length: 8 }, (_, index) => (
                            <GallerySkeleton key={index} />
                        ))}
                    </div>
                ) : items.length ? (
                    <div className={styles.galleryGrid} data-testid="home-public-gallery">
                        {items.map((item) => (
                            <HomeWorkCard key={item.slug} item={item} onPreview={() => setPreviewItem(item)} />
                        ))}
                    </div>
                ) : (
                    <ReferenceGallery />
                )}
            </div>

            <div className={styles.galleryMore}>
                <Link href="/gallery">
                    探索更多作品 <ArrowRight aria-hidden="true" />
                </Link>
            </div>
            <HomeMediaPreview item={previewItem} onClose={() => setPreviewItem(undefined)} />
        </section>
    );
}

const REFERENCE_GALLERY = [
    ["/design/home/latest-gallery-1.webp", "山间建筑 · 自然与空间", "©创意设计"],
    ["/design/home/latest-gallery-2.webp", "人像写真 · 气质光影", "©AI 摄影"],
    ["/design/home/latest-gallery-3.webp", "科幻场景 · 未来世界", "@Dreamer"],
    ["/design/home/latest-gallery-4.webp", "产品渲染 · 商业摄影", "©品牌创意"],
    ["/design/home/latest-gallery-5.webp", "角色动画 · 短片预告", "©AI 动画"],
    ["/design/home/latest-gallery-6.webp", "室内设计 · 空间灵感", "©设计玩家"],
] as const;

function ReferenceGallery() {
    return (
        <div className={styles.galleryGrid} data-testid="home-reference-gallery">
            {REFERENCE_GALLERY.map(([src, title, meta]) => (
                <article key={src} className={styles.workCard}>
                    <div className={styles.workMedia}>
                        <img src={src} alt={title} className={styles.workImage} loading="eager" />
                    </div>
                    <div className={styles.referenceWorkMeta}>
                        <strong>{title}</strong>
                        <span>{meta}</span>
                    </div>
                </article>
            ))}
        </div>
    );
}

function HomeWorkCard({ item, onPreview }: { item: PublicGalleryItem; onPreview: () => void }) {
    const [mediaFailed, setMediaFailed] = useState(false);
    const [duration, setDuration] = useState(0);
    const preview = item.preview;

    return (
        <article className={styles.workCard} data-testid="home-gallery-card">
            <button type="button" className={styles.workMedia} aria-label={`查看作品：${item.title}`} onClick={onPreview}>
                {mediaFailed || !preview || (preview.mediaType !== "image" && preview.mediaType !== "video") ? (
                    <span className={styles.mediaFallback} role="img" aria-label="作品预览不可用">
                        <ImageOff aria-hidden="true" />
                        <span>预览不可用</span>
                    </span>
                ) : preview.mediaType === "image" ? (
                    <LazyMediaImage src={imagePreviewUrl(preview.url, 640)} alt={item.title} containerClassName={styles.workImageWrap} imageClassName={styles.workImage} errorLabel="作品图片不可用" />
                ) : (
                    <video src={preview.url} muted playsInline preload="metadata" className={styles.workImage} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onError={() => setMediaFailed(true)} />
                )}
                {preview?.mediaType === "video" ? (
                    <span className={styles.playIcon}>
                        <Play aria-hidden="true" fill="currentColor" />
                    </span>
                ) : null}
                {preview?.mediaType === "video" && duration > 0 ? <span className={styles.duration}>{formatDuration(duration)}</span> : null}
                <span className={styles.workBody} data-gallery-work-body>
                    <span className={styles.workTitle}>{item.title}</span>
                </span>
            </button>
            <div className={styles.referenceWorkMeta}>
                <strong>{item.title}</strong>
                <span>{item.authorName?.trim() || (item.authorUsername ? `@${item.authorUsername}` : "匿名创作者")}</span>
            </div>
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
            styles={{ container: { padding: 0, overflow: "hidden" }, body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "88dvh" } }}
        >
            {item && preview?.mediaType === "image" ? <img src={imagePreviewUrl(preview.url, 1920)} alt={item.title} className="block max-h-[88dvh] max-w-[min(92vw,1440px)] object-contain" /> : null}
            {item && preview?.mediaType === "video" ? <video src={preview.url} aria-label={item.title} className="block max-h-[88dvh] max-w-[min(92vw,1440px)] object-contain" controls autoPlay playsInline /> : null}
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

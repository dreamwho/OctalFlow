import type { MetadataRoute } from "next";

import { getPublicSiteSettings } from "@/lib/server/site-metadata";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
    const site = await getPublicSiteSettings();
    return {
        name: site.title,
        short_name: site.title.slice(0, 16),
        description: site.seoDescription,
        start_url: "/",
        display: "standalone",
        lang: "zh-CN",
        background_color: "#ffffff",
        theme_color: "#2f6fff",
        icons: [{ src: "/brand/dreamyo/mark.png", sizes: "1254x1254", type: "image/png", purpose: "maskable" }],
    };
}

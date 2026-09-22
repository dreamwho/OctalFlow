import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppProviders } from "@/components/layout/app-providers";
import { themeStorageKey } from "@/lib/theme-scope";
import { absoluteSiteUrl, browserIconHref, getPublicSiteSettings, siteMetadataBase } from "@/lib/server/site-metadata";
import { buildWebsiteStructuredData, serializeStructuredData } from "@/lib/structured-data";
import { getDesktopEdition } from "@/lib/server/desktop-runtime";
import "antd/dist/reset.css";
import "./globals.css";
import React from "react";

const themeBootstrapScript = `try{const key=location.pathname.startsWith("/admin")?${JSON.stringify(themeStorageKey("admin"))}:${JSON.stringify(themeStorageKey("frontend"))};const value=JSON.parse(localStorage.getItem(key)||"{}");const theme=value?.state?.theme==="dark"?"dark":"light";document.documentElement.classList.toggle("dark",theme==="dark");document.documentElement.style.colorScheme=theme}catch{}`;
const desktopThemeBootstrapScript = `try{const value=JSON.parse(localStorage.getItem(${JSON.stringify(themeStorageKey("frontend"))})||"{}");const theme=value?.state?.theme==="light"?"light":"dark";document.documentElement.classList.toggle("dark",theme==="dark");document.documentElement.style.colorScheme=theme}catch{}`;

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: [
        { media: "(prefers-color-scheme: light)", color: "#ffffff" },
        { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    ],
};

export async function generateMetadata(): Promise<Metadata> {
    const site = await getPublicSiteSettings();
    const base = siteMetadataBase();
    const logoUrl = absoluteSiteUrl(site.logoUrl || "/brand/dreamyo/mark.png", base);
    const title = site.seoTitle || site.title;
    return {
        metadataBase: base,
        title,
        description: site.seoDescription,
        alternates: { canonical: "/" },
        keywords: site.seoKeywords
            .split(/[,，]/)
            .map((keyword) => keyword.trim())
            .filter(Boolean),
        openGraph: {
            type: "website",
            title,
            description: site.seoDescription,
            siteName: site.title,
            images: logoUrl ? [{ url: logoUrl }] : undefined,
            locale: "zh_CN",
        },
        twitter: {
            card: "summary",
            title,
            description: site.seoDescription,
            images: logoUrl ? [logoUrl] : undefined,
        },
    };
}

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const [site, requestHeaders] = await Promise.all([getPublicSiteSettings(), headers()]);
    const nonce = requestHeaders.get("x-nonce") || undefined;
    const base = siteMetadataBase();
    const iconHref = browserIconHref(site);
    const websiteUrl = absoluteSiteUrl("/", base);
    const desktopEdition = getDesktopEdition();
    const websiteStructuredData = buildWebsiteStructuredData({
        name: site.title,
        description: site.seoDescription,
        url: websiteUrl,
        logoUrl: absoluteSiteUrl(site.logoUrl || "/brand/dreamyo/mark.png", base),
    });

    return (
        <html lang="zh-CN" suppressHydrationWarning className="font-sans">
            <head>
                <script id="theme-bootstrap" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: desktopEdition === "admin" ? desktopThemeBootstrapScript : themeBootstrapScript }} />
                <link rel="icon" href={iconHref} />
                <link rel="shortcut icon" href={iconHref} />
                <link rel="apple-touch-icon" href={iconHref} />
            </head>
            <body
                className="bg-background text-foreground antialiased"
                style={{
                    fontFamily: '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif',
                }}
            >
                <script id="website-json-ld" nonce={nonce} suppressHydrationWarning type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeStructuredData(websiteStructuredData) }} />
                <AntdRegistry>
                    <AppProviders initialDesktopEdition={desktopEdition} desktopPlatform={desktopEdition ? process.platform : undefined}>{children}</AppProviders>
                </AntdRegistry>
            </body>
        </html>
    );
}

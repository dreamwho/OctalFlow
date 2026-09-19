"use client";

import Link from "next/link";
import { SiteLogo } from "@/components/layout/site-logo";
import { SiteHorizontalLogo } from "@/components/layout/site-horizontal-logo";
import { useHomeActions } from "./home-actions";

export function HomeFooter() {
    const { site } = useHomeActions();
    const currentYear = new Date().getFullYear();
    const copyright = site.footerCopyright?.trim() || `© ${currentYear} ${site.title || "dreamyo"}. All Rights Reserved.`;

    return (
        <footer className="w-full max-w-7xl mx-auto px-6 py-8 mt-20 border-t border-white/[0.06] flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
            {/* Left: Brand logo & Copyright */}
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-x-4 gap-y-2 text-center md:text-left">
                <Link href="/" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
                    <SiteHorizontalLogo className="h-6" title={site.title || "dreamyo"} />
                </Link>
                <span className="text-zinc-500">{copyright}</span>
            </div>

            {/* Right: Clean minimal jiaotu-style links */}
            <div className="flex flex-wrap items-center justify-center gap-6 text-zinc-400">
                <Link href="/announcements" className="hover:text-zinc-200 transition-colors">
                    常见问题
                </Link>
                <Link href="/announcements" className="hover:text-zinc-200 transition-colors">
                    关于我们
                </Link>
                <Link href="/announcements" className="hover:text-zinc-200 transition-colors">
                    联系我们
                </Link>
                {site.termsUrl ? (
                    <a href={site.termsUrl} target="_blank" rel="noreferrer" className="hover:text-zinc-200 transition-colors">
                        用户协议
                    </a>
                ) : (
                    <Link href="/announcements" className="hover:text-zinc-200 transition-colors">
                        用户协议
                    </Link>
                )}
                {site.privacyUrl ? (
                    <a href={site.privacyUrl} target="_blank" rel="noreferrer" className="hover:text-zinc-200 transition-colors">
                        隐私政策
                    </a>
                ) : (
                    <Link href="/announcements" className="hover:text-zinc-200 transition-colors">
                        隐私政策
                    </Link>
                )}
            </div>
        </footer>
    );
}

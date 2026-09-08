"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";

import { SiteLogo } from "@/components/layout/site-logo";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useThemeStore } from "@/stores/use-theme-store";
import { HOME_NAVIGATION, type HomeNavigationItem } from "./home-data";
import { useHomeActions } from "./home-actions";
import styles from "./home.module.css";

export function HomeHeader() {
    const [mobileOpen, setMobileOpen] = useState(false);
    const { authenticated, site, openLogin, openBillingPlans, openProtectedPath } = useHomeActions();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);

    const activate = (item: HomeNavigationItem) => {
        setMobileOpen(false);
        if (item.action === "billing") openBillingPlans();
        if (item.action === "protected") openProtectedPath(item.href);
    };

    return (
        <header className={styles.header}>
            <div className={styles.headerInner}>
                <div className={styles.headerLeft}>
                    <button type="button" className={styles.navMenuButton} onClick={() => setMobileOpen((value) => !value)} aria-expanded={mobileOpen} aria-controls="home-navigation-menu" aria-label={mobileOpen ? "关闭导航菜单" : "打开导航菜单"}>
                        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
                    </button>
                    <Link href="/" className={styles.brand} aria-label={`${site.title} 首页`}>
                        <SiteLogo logoUrl={site.logoUrl} className={styles.brandLogo} />
                        <span>{site.title}</span>
                    </Link>
                </div>

                <div className={styles.headerActions}>
                    <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={styles.themeButton} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
                    <button type="button" className={styles.primarySmallButton} onClick={() => (authenticated ? openProtectedPath("/create") : openLogin("/create"))}>
                        {authenticated ? "开始创作" : "立即体验"}
                    </button>
                </div>
            </div>

            {mobileOpen ? (
                <nav id="home-navigation-menu" className={styles.mobileNav} aria-label="首页导航菜单">
                    {HOME_NAVIGATION.map((item) =>
                        item.action !== "link" ? (
                            <button key={item.href} type="button" onClick={() => activate(item)}>
                                {item.label}
                                <ArrowRight aria-hidden="true" />
                            </button>
                        ) : (
                            <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)}>
                                {item.label}
                                <ArrowRight aria-hidden="true" />
                            </Link>
                        ),
                    )}
                </nav>
            ) : null}
        </header>
    );
}

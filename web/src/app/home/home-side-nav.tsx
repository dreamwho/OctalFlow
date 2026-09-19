"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, House, LayoutGrid, Plus } from "lucide-react";

import { useHomeActions } from "./home-actions";
import styles from "./home.module.css";

export function HomeSideNav() {
    const pathname = usePathname();
    const { openProtectedPath } = useHomeActions();

    return (
        <nav className={styles.sideNav} aria-label="快捷导航">
            <button type="button" className={styles.sideNavCreate} aria-label="新建画布" title="新建画布" onClick={() => openProtectedPath("/canvas?mode=new")}>
                <Plus aria-hidden="true" className="size-6" />
            </button>
            <div className={styles.sideNavGroup}>
                <div className="relative">
                    <Link href="/" className={`${styles.sideNavItem} ${pathname === "/" ? styles.sideNavItemActive : ""}`} aria-label="首页" aria-current={pathname === "/" ? "page" : undefined}>
                        <House aria-hidden="true" className="size-[22px]" />
                    </Link>
                </div>
                <div className="relative">
                    <button
                        type="button"
                        className={`${styles.sideNavItem} ${pathname.startsWith("/canvas") ? styles.sideNavItemActive : ""}`}
                        aria-label="项目库（画布列表）"
                        title="项目库"
                        onClick={() => openProtectedPath("/canvas")}
                    >
                        <FolderOpen aria-hidden="true" className="size-[22px]" />
                    </button>
                </div>
                <div className="relative">
                    <button
                        type="button"
                        className={`${styles.sideNavItem} ${pathname.startsWith("/assets") ? styles.sideNavItemActive : ""}`}
                        aria-label="素材库"
                        title="素材库"
                        onClick={() => openProtectedPath("/assets")}
                    >
                        <LayoutGrid aria-hidden="true" className="size-[22px]" />
                    </button>
                    <span className={styles.sideNavBadge} aria-hidden="true">
                        new
                    </span>
                </div>
            </div>
        </nav>
    );
}

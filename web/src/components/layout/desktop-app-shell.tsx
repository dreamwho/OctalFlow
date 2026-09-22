"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { FolderOpen, Layers3, Moon, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Sun, WandSparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { SiteLogo } from "@/components/layout/site-logo";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useAdminThemeStore, useThemeStore } from "@/stores/use-theme-store";
import styles from "./desktop-app-shell.module.css";

export function DesktopAppShell({ children, platform }: { children: ReactNode; platform: string }) {
    const pathname = usePathname();
    const section = useSearchParams().get("section");
    const [expanded, setExpanded] = useState(true);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const setAdminTheme = useAdminThemeStore((state) => state.setTheme);
    const projects = useCanvasStore((state) => state.summaries);
    const activeProject = pathname.startsWith("/canvas/") ? pathname.split("/")[2] : "";
    const settings = pathname === "/admin";
    const switchTheme = (next: "light" | "dark") => { setTheme(next); setAdminTheme(next); };
    const linkClass = (active: boolean) => `${styles.item} ${active ? styles.active : ""}`;

    return <div className={`${styles.shell} ${expanded ? "" : styles.collapsed}`} data-desktop-app-shell="true" data-theme={theme} data-platform={platform}>
        <aside className={styles.sidebar} aria-label="桌面应用导航">
            <div className={styles.dragRegion} aria-hidden="true" />
            <div className={styles.brandRow}>
                <Link href="/canvas" className={styles.brand} title="Dreamyo 项目库" aria-label="Dreamyo 项目库"><SiteLogo logoUrl="/brand/dreamyo/mark.png" className={styles.logo} /><span>dreamyo<small>本地创作工作区</small></span></Link>
                <button type="button" className={styles.iconButton} onClick={() => setExpanded((open) => !open)} aria-label={expanded ? "收起应用侧栏" : "展开应用侧栏"} title={expanded ? "收起侧栏" : "展开侧栏"}>{expanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
            </div>
            <nav className={styles.navigation} aria-label="主要功能">
                <Link href="/canvas?desktopNew=1" className={linkClass(false)} title="开始创作"><Plus size={18} /><span>开始创作</span></Link>
                <Link href="/canvas" className={linkClass(pathname === "/canvas")} aria-current={pathname === "/canvas" ? "page" : undefined} title="项目库"><FolderOpen size={18} /><span>项目库</span></Link>
                <Link href="/admin?section=channels" className={linkClass(settings && (section === "channels" || ["geminiai", "dolaApi", "geminiTools", "chatgptApi", "dreamina", "runninghub", "minimax", "tencentMusic", "qwenAudio"].includes(section || "")))} title="模型与渠道"><Layers3 size={18} /><span>模型与渠道</span></Link>
                <Link href="/admin?section=skills" className={linkClass(settings && section === "skills")} title="技能与连接器"><WandSparkles size={18} /><span>技能与连接器</span></Link>
            </nav>
            {expanded ? <div className={styles.projects}>
                <div className={styles.groupTitle}>最近项目</div>
                {projects.slice(0, 8).map((project) => <Link href={`/canvas/${project.id}`} key={project.id} className={linkClass(activeProject === project.id)} title={project.title} aria-current={activeProject === project.id ? "page" : undefined}><span className={styles.projectDot} /><span className={styles.projectName}>{project.title}</span></Link>)}
                {!projects.length ? <p className={styles.emptyProjects}>项目将显示在这里</p> : null}
            </div> : null}
            <div className={styles.footer}>
                <div className={styles.themeSwitch} role="group" aria-label="外观主题">
                    <button type="button" className={theme === "light" ? styles.themeSelected : ""} aria-label="浅色主题" aria-pressed={theme === "light"} title="浅色主题" onClick={() => switchTheme("light")}><Sun size={17} /></button>
                    <button type="button" className={theme === "dark" ? styles.themeSelected : ""} aria-label="深色主题" aria-pressed={theme === "dark"} title="深色主题" onClick={() => switchTheme("dark")}><Moon size={17} /></button>
                </div>
                <Link href="/admin?section=settings" className={linkClass(settings && !["channels", "geminiai", "dolaApi", "geminiTools", "chatgptApi", "dreamina", "runninghub", "minimax", "tencentMusic", "qwenAudio", "skills"].includes(section || ""))} title="设置"><Settings2 size={18} /><span>设置</span></Link>
            </div>
        </aside>
        <div className={styles.workspace} data-desktop-workspace="true">{children}</div>
    </div>;
}

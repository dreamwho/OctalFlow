"use client";

import { Activity, Globe2, Layers3, SlidersHorizontal } from "lucide-react";
import { adminSections } from "./admin-section-nav";
import { canAccessAdminSection, type AdminSectionKey } from "./admin-sections";
import { isAdminLocalSectionEnabled } from "@/lib/desktop-edition-policy";
import type { PublicUser } from "@/lib/auth/store";
import styles from "./desktop-admin-navigation.module.css";

const groups = [
    { label: "模型与渠道", icon: Layers3, items: ["channels", "geminiai", "dolaApi", "geminiTools", "chatgptApi", "dreamina", "runninghub", "minimax", "tencentMusic", "qwenAudio"] },
    { label: "网络代理", icon: Globe2, items: ["magicProxy", "genericProxy"] },
    { label: "运行记录", icon: Activity, items: ["logs", "generationOperations"] },
    { label: "应用设置", icon: SlidersHorizontal, items: ["settings", "canvasActions", "skills", "mediaStorage", "backup"] },
] as const satisfies readonly { label: string; icon: typeof Layers3; items: readonly AdminSectionKey[] }[];

export function DesktopAdminNavigation({ activeKey, user, onChange, onIntent }: {
    activeKey: AdminSectionKey;
    user: PublicUser;
    onChange: (key: AdminSectionKey) => void;
    onIntent?: (key: AdminSectionKey) => void;
}) {
    const available = groups.map((group) => ({ ...group, items: group.items.filter((key) => canAccessAdminSection(user, key) && isAdminLocalSectionEnabled(key, "admin")) })).filter((group) => group.items.length);
    const current = available.find((group) => group.items.some((key) => key === activeKey)) || available[0];
    const sections = new Map(adminSections.map((section) => [section.key, section]));
    return (
        <aside className={styles.shell} data-desktop-settings="true" aria-label="本地设置导航">
            <div className={styles.settingsTitle}>
                <p>本地工作区</p><h1>设置</h1><span>管理模型、代理与应用</span>
            </div>
            <nav className={styles.categories} aria-label="设置分类">
                {available.map((group) => {
                    const Icon = group.icon;
                    const selected = current?.label === group.label;
                    return <div className={styles.group} key={group.label}>
                        <button type="button" className={`${styles.category} ${selected ? styles.categoryActive : ""}`} aria-expanded={selected} onClick={() => onChange(group.items[0])} onPointerEnter={() => onIntent?.(group.items[0])} onFocus={() => onIntent?.(group.items[0])}><Icon size={17} aria-hidden="true" />{group.label}</button>
                        {selected ? <div className={styles.sections} role="group" aria-label={`${group.label}项目`}>
                            {group.items.map((key) => {
                                const section = sections.get(key);
                                if (!section) return null;
                                return <button key={key} type="button" data-admin-section-key={key} className={`${styles.section} ${activeKey === key ? styles.sectionActive : ""}`} aria-current={activeKey === key ? "page" : undefined} onClick={() => onChange(key)} onPointerEnter={() => onIntent?.(key)} onFocus={() => onIntent?.(key)}>{section.label}</button>;
                            })}
                        </div> : null}
                    </div>;
                })}
            </nav>
            <p className={styles.hint}>配置保存在当前设备</p>
        </aside>
    );
}

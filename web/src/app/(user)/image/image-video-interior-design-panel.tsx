"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, House, Search } from "lucide-react";

import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { listRunningHubCatalogApps, type RunningHubCatalogApp } from "@/services/api/runninghub";
import { INTERIOR_DESIGN_OPTIONS, INTERIOR_DESIGN_PREVIEW_URL, INTERIOR_DESIGN_SCENES, createInteriorDesignSettings, type InteriorDesignOption } from "@/app/(user)/canvas/utils/canvas-interior-design";
import type { CanvasInteriorDesignSettings } from "@/app/(user)/canvas/types";
import styles from "./image-video-workbench.module.css";

type AppChoice = Pick<RunningHubCatalogApp, "id" | "name">;
type SectionKey = "generation" | "scene" | "lighting" | "camera" | "constraints";
type OptionKey = Exclude<keyof CanvasInteriorDesignSettings, "scene" | "mainLight" | "artificialLight" | "techniques">;

const sections: Array<{ key: SectionKey; title: string; fields: Array<{ key: OptionKey; label: string }> }> = [
    { key: "generation", title: "生图模式", fields: [{ key: "task", label: "图生图任务" }, { key: "conversion", label: "转换逻辑" }] },
    { key: "scene", title: "场景设计", fields: [{ key: "spaceType", label: "空间类型" }, { key: "style", label: "设计风格" }, { key: "exteriorView", label: "外景类型" }, { key: "location", label: "地点" }] },
    { key: "lighting", title: "光影氛围", fields: [{ key: "season", label: "季节" }, { key: "weather", label: "天气" }, { key: "time", label: "时间段" }, { key: "curtain", label: "窗帘类型" }, { key: "sunlight", label: "太阳光光影" }, { key: "indoorLight", label: "室内光" }, { key: "colorTemperature", label: "灯光色温" }, { key: "postTone", label: "后期色调" }, { key: "lightingQuality", label: "影调" }] },
    { key: "camera", title: "摄影设备", fields: [{ key: "camera", label: "相机" }, { key: "aperture", label: "光圈" }, { key: "shutter", label: "快门" }, { key: "iso", label: "ISO" }, { key: "focalLength", label: "焦距" }] },
    { key: "constraints", title: "AI 约束", fields: [{ key: "geometry", label: "几何保真" }, { key: "objectIntegrity", label: "物体完整性" }, { key: "materialIntegrity", label: "材质完整性" }] },
];
const dropdownChoices = new Set<OptionKey>(["style", "exteriorView", "camera"]);

export function ImageVideoInteriorDesignPanel({ initialSettings, initialApp, onConfirm }: { initialSettings?: CanvasInteriorDesignSettings; initialApp?: AppChoice; onConfirm: (settings: CanvasInteriorDesignSettings, app?: AppChoice) => void }) {
    const [step, setStep] = useState<"catalog" | "config">(initialSettings ? "config" : "catalog");
    const [settings, setSettings] = useState<CanvasInteriorDesignSettings>(() => initialSettings || createInteriorDesignSettings());
    const [app, setApp] = useState<AppChoice | undefined>(initialApp);
    const [apps, setApps] = useState<RunningHubCatalogApp[]>([]);
    const [query, setQuery] = useState("");
    const [activeSection, setActiveSection] = useState<SectionKey>("generation");

    useEffect(() => {
        void listRunningHubCatalogApps("interior-design").then(setApps).catch(() => setApps([]));
    }, []);

    const choose = (choice?: AppChoice) => {
        setApp(choice);
        setSettings(initialSettings && choice?.id === initialApp?.id ? initialSettings : createInteriorDesignSettings());
        setActiveSection("generation");
        setStep("config");
    };
    const update = (key: OptionKey, value: string) => setSettings((current) => ({ ...current, [key]: value }));
    const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());

    if (step === "catalog") return <div className={styles.interiorPanel}>
        <p className={styles.interiorIntro}>选择室内设计功能，用参考图生成摄影级作品。</p>
        <label className={styles.interiorSearch}><Search /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索室内设计功能" aria-label="搜索室内设计功能" /></label>
        <div className={styles.interiorCatalog}>
            {matches("SU直出摄影级照片 Nano Banana") ? <button type="button" className={styles.interiorCatalogItem} onClick={() => choose()} aria-label="SU直出摄影级照片">
                <img src={INTERIOR_DESIGN_PREVIEW_URL} alt="SU直出摄影级照片预览" />
                <span><strong>SU直出摄影级照片</strong><small>Gemini Nano Banana · 图生图</small></span><ChevronDown />
            </button> : null}
            {apps.filter((item) => matches(`${item.name} ${item.description}`)).map((item) => <button key={item.id} type="button" className={styles.interiorCatalogItem} onClick={() => choose({ id: item.id, name: item.name })} aria-label={item.name}>
                {item.thumbnailUrl ? <img src={browserReadableMediaUrl(imagePreviewUrl(item.thumbnailUrl, 160))} alt={`${item.name}预览`} /> : <span className={styles.interiorCatalogIcon}><House /></span>}
                <span><strong>{item.name}</strong><small>RunningHub · {item.fieldCount} 项参数</small></span><ChevronDown />
            </button>)}
        </div>
    </div>;

    return <div className={styles.interiorPanel}>
        <button type="button" className={styles.interiorBack} onClick={() => setStep("catalog")}><ArrowLeft />返回功能列表</button>
        <div className={styles.interiorScene} role="group" aria-label="设计场景">{INTERIOR_DESIGN_SCENES.map((scene) => <button key={scene.value} type="button" aria-pressed={settings.scene === scene.value} onClick={() => setSettings(createInteriorDesignSettings(scene.value))}>{scene.label}</button>)}</div>
        <div className={styles.interiorSections}>{sections.map((section) => <section key={section.key} className={styles.interiorSection}>
            <button type="button" className={styles.interiorSectionToggle} aria-expanded={activeSection === section.key} onClick={() => setActiveSection((current) => current === section.key ? "generation" : section.key)}><strong>{section.title}</strong><span>{section.fields.length} 项 <ChevronDown /></span></button>
            {activeSection === section.key ? <div className={styles.interiorFields}>
                {section.fields.map(({ key, label }) => !dropdownChoices.has(key) ? <div key={key} className={styles.interiorCompactField} role="radiogroup" aria-label={label}>
                    <span className={styles.interiorFieldLabel}>{label}</span>
                    <div className={styles.interiorChoiceRow}>{(INTERIOR_DESIGN_OPTIONS[key] as readonly InteriorDesignOption[]).map((option) => <button key={option.value} type="button" role="radio" aria-checked={settings[key] === option.value} onClick={() => update(key, option.value)}>{option.label}</button>)}</div>
                </div> : <label key={key} className={styles.interiorField}><span className={styles.interiorFieldLabel}>{label}</span><select aria-label={label} value={settings[key]} onChange={(event) => update(key, event.target.value)}>{(INTERIOR_DESIGN_OPTIONS[key] as readonly InteriorDesignOption[]).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
                {section.key === "lighting" ? <><label className={styles.interiorCheck}><input type="checkbox" checked={settings.mainLight} onChange={(event) => setSettings((current) => ({ ...current, mainLight: event.target.checked }))} />主进光口</label><label className={styles.interiorCheck}><input type="checkbox" checked={settings.artificialLight} onChange={(event) => setSettings((current) => ({ ...current, artificialLight: event.target.checked }))} />人工主光源</label></> : null}
                {section.key === "camera" ? <div className={styles.interiorCompactField} role="group" aria-label="摄影技法"><span className={styles.interiorFieldLabel}>摄影技法</span><div className={styles.interiorChoiceRow}>{INTERIOR_DESIGN_OPTIONS.techniques.map((option) => <button key={option.value} type="button" aria-pressed={settings.techniques.includes(option.value)} onClick={() => setSettings((current) => ({ ...current, techniques: current.techniques.includes(option.value) ? current.techniques.filter((value) => value !== option.value) : [...current.techniques, option.value] }))}>{option.label}</button>)}</div></div> : null}
            </div> : null}
        </section>)}</div>
        <div className={styles.interiorFooter}><button type="button" onClick={() => onConfirm(settings, app)}>使用此配置</button></div>
    </div>;
}

"use client";

import { useEffect, useState } from "react";
import { Aperture, Image as ImageIcon, Maximize2, Minimize2, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { Button, Checkbox, Modal, Segmented, Select, Switch, Tabs } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { listRunningHubCatalogApps, type RunningHubCatalogApp } from "@/services/api/runninghub";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasInteriorDesignScene, CanvasInteriorDesignSettings } from "../types";
import { INTERIOR_DESIGN_OPTIONS, INTERIOR_DESIGN_PREVIEW_URL, INTERIOR_DESIGN_SCENES, INTERIOR_DESIGN_TABS, createInteriorDesignSettings, interiorDesignOptionLabel, type InteriorDesignOption } from "../utils/canvas-interior-design";

type CanvasInteriorDesignDialogProps = {
    open: boolean;
    initialSettings?: CanvasInteriorDesignSettings;
    initialRunningHubAppId?: string;
    initialRunningHubAppName?: string;
    onCancel: () => void;
    onConfirm: (settings: CanvasInteriorDesignSettings, app?: Pick<RunningHubCatalogApp, "id" | "name">) => void;
};

const INTERIOR_CATALOG_TABS = ["功能广场", "我的收藏", "最近使用"] as const;
type InteriorCatalogTab = (typeof INTERIOR_CATALOG_TABS)[number];

export function CanvasInteriorDesignDialog({ open, initialSettings, initialRunningHubAppId, initialRunningHubAppName, onCancel, onConfirm }: CanvasInteriorDesignDialogProps) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [step, setStep] = useState<"catalog" | "config">(initialSettings ? "config" : "catalog");
    const [draft, setDraft] = useState<CanvasInteriorDesignSettings>(() => initialSettings || createInteriorDesignSettings());
    const [previewFailed, setPreviewFailed] = useState(false);
    const [catalogTab, setCatalogTab] = useState<InteriorCatalogTab>("功能广场");
    const [searchQuery, setSearchQuery] = useState("");
    const [expanded, setExpanded] = useState(false);
    const [catalogApps, setCatalogApps] = useState<RunningHubCatalogApp[]>([]);
    const [selectedApp, setSelectedApp] = useState<Pick<RunningHubCatalogApp, "id" | "name"> | undefined>();

    useEffect(() => {
        if (!open) return;
        setDraft(initialSettings || createInteriorDesignSettings());
        setStep(initialSettings ? "config" : "catalog");
        setPreviewFailed(false);
        setCatalogTab("功能广场");
        setSearchQuery("");
        setExpanded(false);
        setSelectedApp(initialRunningHubAppId ? { id: initialRunningHubAppId, name: initialRunningHubAppName || "RunningHub 应用" } : undefined);
        void listRunningHubCatalogApps("interior-design").then(setCatalogApps).catch(() => setCatalogApps([]));
    }, [initialRunningHubAppId, initialRunningHubAppName, initialSettings, open]);

    const setScene = (scene: CanvasInteriorDesignScene) => setDraft(createInteriorDesignSettings(scene));
    const setField = <K extends keyof CanvasInteriorDesignSettings>(key: K, value: CanvasInteriorDesignSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));
    const query = searchQuery.trim().toLowerCase();
    const showCatalogItem = catalogTab === "功能广场" && "su直出摄影级照片 gemini nano banana 室内设计".includes(query);
    const visibleApps = catalogTab === "功能广场" ? catalogApps.filter((app) => !query || `${app.name} ${app.description} runninghub`.toLowerCase().includes(query)) : [];
    const dialogTitle = step === "catalog" ? "室内设计" : selectedApp?.name || "SU直出摄影级照片";

    return (
        <Modal
            open={open}
            width={expanded ? "calc(100vw - 32px)" : "min(960px, calc(100vw - 24px))"}
            centered
            destroyOnHidden
            title={<span className="sr-only">{dialogTitle}</span>}
            closable={false}
            onCancel={onCancel}
            footer={null}
            classNames={{ container: "border border-[#d9e4ee] dark:border-[#4d6478]" }}
            styles={{
                container: {
                    maxHeight: "calc(100dvh - 24px)",
                    overflow: "hidden",
                    padding: 0,
                    background: theme.node.panel,
                    boxShadow:
                        colorTheme === "dark"
                            ? "0 0 0 1px rgba(103,232,249,.16), 0 24px 76px rgba(34,211,238,.14), 0 22px 64px rgba(0,0,0,.5)"
                            : "0 0 0 1px rgba(8,145,178,.09), 0 24px 72px rgba(8,145,178,.16), 0 18px 54px rgba(15,23,42,.2)",
                },
                header: { height: 0, margin: 0, overflow: "hidden" },
                body: { padding: 0 },
            }}
        >
            <div data-canvas-interior-design-dialog style={{ color: theme.node.text }} onPointerDown={(event) => event.stopPropagation()}>
                {step === "catalog" ? (
                    <>
                        <div
                            data-canvas-interior-catalog-toolbar
                            className="grid min-h-16 grid-cols-[auto_minmax(200px,340px)_1fr_auto] items-center gap-4 border-b px-4 max-[720px]:grid-cols-[1fr_auto] max-[720px]:gap-2 max-[720px]:py-3"
                            style={{ borderColor: theme.toolbar.border }}
                        >
                            <div className="hide-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl p-1" style={{ background: theme.node.fill }} role="tablist" aria-label="室内设计功能分类">
                                {INTERIOR_CATALOG_TABS.map((tab) => (
                                    <button
                                        key={tab}
                                        type="button"
                                        role="tab"
                                        aria-selected={catalogTab === tab}
                                        className="h-8 shrink-0 rounded-lg px-3 text-xs font-medium transition"
                                        style={{ background: catalogTab === tab ? theme.toolbar.activeBg : "transparent", color: catalogTab === tab ? theme.toolbar.activeText : theme.node.muted }}
                                        onClick={() => setCatalogTab(tab)}
                                    >
                                        {tab}
                                    </button>
                                ))}
                            </div>
                            <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border px-3 max-[720px]:order-3 max-[720px]:col-span-2" style={{ background: theme.node.fill, borderColor: theme.toolbar.border }}>
                                <Search className="size-4 shrink-0" style={{ color: theme.node.muted }} />
                                <input
                                    type="search"
                                    value={searchQuery}
                                    onChange={(event) => setSearchQuery(event.target.value)}
                                    placeholder="搜索功能名称"
                                    aria-label="搜索室内设计功能"
                                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:opacity-55"
                                    style={{ color: theme.node.text }}
                                />
                            </label>
                            <span />
                            <div className="flex items-center gap-1">
                                <IconButton label={expanded ? "退出全屏" : "放大弹出层"} theme={theme} onClick={() => setExpanded((value) => !value)}>
                                    {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                                </IconButton>
                                <IconButton label="关闭室内设计" theme={theme} onClick={onCancel}>
                                    <X className="size-4.5" />
                                </IconButton>
                            </div>
                        </div>
                        <div data-canvas-interior-catalog className="hide-scrollbar max-h-[calc(100dvh-112px)] overflow-y-auto p-4">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <span className="rounded-md px-2.5 py-1 text-xs font-medium" style={{ background: theme.node.fill }}>
                                    {catalogTab === "功能广场" ? "推荐" : catalogTab}
                                </span>
                                <span className="text-[11px]" style={{ color: theme.node.muted }}>
                                    Gemini · RunningHub
                                </span>
                            </div>
                            {showCatalogItem || visibleApps.length ? (
                                <div className="grid grid-cols-2 content-start gap-4 sm:grid-cols-[repeat(auto-fill,minmax(160px,184px))]">
                                    {showCatalogItem ? <button type="button" className="group min-w-0 text-left" onClick={() => { setSelectedApp(undefined); setStep("config"); }} aria-label="SU直出摄影级照片">
                                        <span className="relative block aspect-square overflow-hidden rounded-xl border" style={{ background: theme.node.fill, borderColor: theme.toolbar.border }}>
                                            {previewFailed ? (
                                                <span className="grid size-full place-items-center gap-2 p-4 text-center text-xs" style={{ color: theme.node.muted }}>
                                                    <ImageIcon className="size-7 opacity-60" />
                                                    预览图暂不可用
                                                </span>
                                            ) : (
                                                <img src={INTERIOR_DESIGN_PREVIEW_URL} alt="SU直出摄影级照片预览" className="size-full object-cover transition duration-200 group-hover:scale-[1.02]" onError={() => setPreviewFailed(true)} />
                                            )}
                                            <span className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">推荐</span>
                                        </span>
                                        <span className="mt-2 block truncate text-[13px] font-semibold">SU直出摄影级照片</span>
                                        <span className="mt-1 flex items-center justify-between gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                                            <span className="flex min-w-0 items-center gap-1 truncate">
                                                <Sparkles className="size-3 shrink-0" /> Nano Banana
                                            </span>
                                            <span className="shrink-0">图生图</span>
                                        </span>
                                    </button> : null}
                                    {visibleApps.map((app) => (
                                        <button key={app.id} type="button" className="group min-w-0 text-left" onClick={() => { setSelectedApp({ id: app.id, name: app.name }); setStep("config"); }} aria-label={app.name}>
                                            <span className="relative block aspect-square overflow-hidden rounded-xl border" style={{ background: theme.node.fill, borderColor: theme.toolbar.border }}>
                                                {app.thumbnailUrl ? <img src={browserReadableMediaUrl(imagePreviewUrl(app.thumbnailUrl, 720))} alt={`${app.name}预览`} className="size-full object-cover transition duration-200 group-hover:scale-[1.02]" /> : <span className="grid size-full place-items-center gap-2 p-4 text-center text-xs" style={{ color: theme.node.muted }}><ImageIcon className="size-7 opacity-60" />暂无预览图</span>}
                                                <span className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">RunningHub</span>
                                            </span>
                                            <span className="mt-2 block truncate text-[13px] font-semibold">{app.name}</span>
                                            <span className="mt-1 flex items-center justify-between gap-2 text-[11px]" style={{ color: theme.node.muted }}><span className="flex min-w-0 items-center gap-1 truncate"><Sparkles className="size-3 shrink-0" />{app.kind === "ai-app" ? "AI 应用" : "工作流"}</span><span className="shrink-0">{app.fieldCount} 参数</span></span>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="grid min-h-40 place-items-center text-sm" style={{ color: theme.node.muted }}>
                                    {searchQuery.trim() ? "没有找到匹配功能" : catalogTab === "我的收藏" ? "暂无收藏功能" : "暂无最近使用记录"}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex max-h-[calc(100dvh-24px)] min-h-0 flex-col">
                        <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-5" style={{ borderColor: theme.toolbar.border }}>
                            <span className="truncate text-base font-semibold">{selectedApp?.name || "SU直出摄影级照片"}</span>
                            <div className="flex items-center gap-1">
                                <IconButton label={expanded ? "退出全屏" : "放大弹出层"} theme={theme} onClick={() => setExpanded((value) => !value)}>
                                    {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                                </IconButton>
                                <IconButton label="关闭摄影参数" theme={theme} onClick={onCancel}>
                                    <X className="size-4.5" />
                                </IconButton>
                            </div>
                        </div>
                        <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                            <div className="mb-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                <Segmented block value={draft.scene} options={INTERIOR_DESIGN_SCENES} onChange={(value) => setScene(value as CanvasInteriorDesignScene)} aria-label="设计场景" />
                            </div>
                            <Tabs tabBarGutter={28} className="canvas-interior-design-tabs" items={INTERIOR_DESIGN_TABS.map((tab) => ({ key: tab.key, label: tab.label, children: tabContent(tab.key, draft, setField, theme) }))} />
                        </div>
                        <div className="flex shrink-0 justify-end gap-2 border-t px-5 py-3" style={{ borderColor: theme.toolbar.border }}>
                            {!initialSettings ? <Button onClick={() => setStep("catalog")}>返回功能</Button> : null}
                            <Button onClick={onCancel}>取消</Button>
                            <Button type="primary" onClick={() => onConfirm(draft, selectedApp)}>
                                确认
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}

function IconButton({ label, theme, onClick, children }: { label: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onClick: () => void; children: React.ReactNode }) {
    return (
        <button type="button" aria-label={label} className="grid size-9 place-items-center rounded-lg transition hover:brightness-110" style={{ color: theme.node.muted }} onClick={onClick}>
            {children}
        </button>
    );
}

function tabContent(
    tab: (typeof INTERIOR_DESIGN_TABS)[number]["key"],
    settings: CanvasInteriorDesignSettings,
    setField: <K extends keyof CanvasInteriorDesignSettings>(key: K, value: CanvasInteriorDesignSettings[K]) => void,
    theme: (typeof canvasThemes)[keyof typeof canvasThemes],
) {
    if (tab === "generation") {
        return (
            <FieldGrid>
                <OptionField label="图生图任务" field="task" value={settings.task} options={INTERIOR_DESIGN_OPTIONS.task} onChange={setField} />
                <OptionField label="转换逻辑" field="conversion" value={settings.conversion} options={INTERIOR_DESIGN_OPTIONS.conversion} onChange={setField} />
                <OptionField label="画面比例" field="aspectRatio" value={settings.aspectRatio} options={INTERIOR_DESIGN_OPTIONS.aspectRatio} onChange={setField} />
                <OptionField label="目标精度" field="resolution" value={settings.resolution} options={INTERIOR_DESIGN_OPTIONS.resolution} onChange={setField} />
            </FieldGrid>
        );
    }
    if (tab === "scene") {
        return (
            <FieldGrid>
                <OptionField label="空间类型" field="spaceType" value={settings.spaceType} options={INTERIOR_DESIGN_OPTIONS.spaceType} onChange={setField} />
                <OptionField label="设计风格" field="style" value={settings.style} options={INTERIOR_DESIGN_OPTIONS.style} onChange={setField} />
                <OptionField label="外景类型" field="exteriorView" value={settings.exteriorView} options={INTERIOR_DESIGN_OPTIONS.exteriorView} onChange={setField} />
                <OptionField label="地点" field="location" value={settings.location} options={INTERIOR_DESIGN_OPTIONS.location} onChange={setField} />
            </FieldGrid>
        );
    }
    if (tab === "lighting") {
        return (
            <FieldGrid>
                <OptionField label="季节" field="season" value={settings.season} options={INTERIOR_DESIGN_OPTIONS.season} onChange={setField} />
                <OptionField label="天气" field="weather" value={settings.weather} options={INTERIOR_DESIGN_OPTIONS.weather} onChange={setField} />
                <OptionField label="时间段" field="time" value={settings.time} options={INTERIOR_DESIGN_OPTIONS.time} onChange={setField} />
                <OptionField label="窗帘类型" field="curtain" value={settings.curtain} options={INTERIOR_DESIGN_OPTIONS.curtain} onChange={setField} />
                <SwitchField label="主进光口" checked={settings.mainLight} theme={theme} onChange={(checked) => setField("mainLight", checked)} />
                <SwitchField label="人工主光源" checked={settings.artificialLight} theme={theme} onChange={(checked) => setField("artificialLight", checked)} />
                <OptionField label="太阳光光影" field="sunlight" value={settings.sunlight} options={INTERIOR_DESIGN_OPTIONS.sunlight} onChange={setField} />
                <OptionField label="室内光" field="indoorLight" value={settings.indoorLight} options={INTERIOR_DESIGN_OPTIONS.indoorLight} onChange={setField} />
                <OptionField label="灯光色温" field="colorTemperature" value={settings.colorTemperature} options={INTERIOR_DESIGN_OPTIONS.colorTemperature} onChange={setField} />
                <OptionField label="后期色调" field="postTone" value={settings.postTone} options={INTERIOR_DESIGN_OPTIONS.postTone} onChange={setField} />
                <OptionField label="影调" field="lightingQuality" value={settings.lightingQuality} options={INTERIOR_DESIGN_OPTIONS.lightingQuality} onChange={setField} />
            </FieldGrid>
        );
    }
    if (tab === "camera") {
        return (
            <FieldGrid>
                <OptionField label="相机" field="camera" value={settings.camera} options={INTERIOR_DESIGN_OPTIONS.camera} onChange={setField} />
                <OptionField label="光圈" field="aperture" value={settings.aperture} options={INTERIOR_DESIGN_OPTIONS.aperture} onChange={setField} />
                <OptionField label="快门" field="shutter" value={settings.shutter} options={INTERIOR_DESIGN_OPTIONS.shutter} onChange={setField} />
                <OptionField label="ISO" field="iso" value={settings.iso} options={INTERIOR_DESIGN_OPTIONS.iso} onChange={setField} />
                <OptionField label="焦距" field="focalLength" value={settings.focalLength} options={INTERIOR_DESIGN_OPTIONS.focalLength} onChange={setField} />
                <label className="min-w-0 sm:col-span-2">
                    <FieldLabel icon={<Aperture className="size-3.5" />}>摄影技法</FieldLabel>
                    <div className="rounded-xl border p-3" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {INTERIOR_DESIGN_OPTIONS.techniques.map((item) => (
                                <Checkbox
                                    key={item.value}
                                    checked={settings.techniques.includes(item.value)}
                                    onChange={(event) => setField("techniques", event.target.checked ? [...settings.techniques, item.value] : settings.techniques.filter((value) => value !== item.value))}
                                >
                                    {item.label}
                                </Checkbox>
                            ))}
                        </div>
                    </div>
                </label>
            </FieldGrid>
        );
    }
    if (tab === "constraints") {
        return (
            <FieldGrid>
                <OptionField label="几何保真" field="geometry" value={settings.geometry} options={INTERIOR_DESIGN_OPTIONS.geometry} onChange={setField} />
                <OptionField label="物体完整性" field="objectIntegrity" value={settings.objectIntegrity} options={INTERIOR_DESIGN_OPTIONS.objectIntegrity} onChange={setField} />
                <OptionField label="材质完整性" field="materialIntegrity" value={settings.materialIntegrity} options={INTERIOR_DESIGN_OPTIONS.materialIntegrity} onChange={setField} />
            </FieldGrid>
        );
    }
    return null;
}

function FieldGrid({ children }: { children: React.ReactNode }) {
    return <div className="grid content-start gap-3 pb-1 sm:grid-cols-2">{children}</div>;
}

function FieldLabel({ icon = <SlidersHorizontal className="size-3.5" />, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
    return (
        <span className="mb-2 flex items-center gap-1.5 text-xs font-medium">
            {icon}
            {children}
        </span>
    );
}

function OptionField<K extends keyof CanvasInteriorDesignSettings>({
    label,
    field,
    value,
    options,
    onChange,
}: {
    label: string;
    field: K;
    value: string;
    options: readonly InteriorDesignOption[];
    onChange: <T extends keyof CanvasInteriorDesignSettings>(key: T, value: CanvasInteriorDesignSettings[T]) => void;
}) {
    return (
        <label className="min-w-0">
            <FieldLabel>{label}</FieldLabel>
            <Select
                value={value}
                options={options.map((item) => ({ label: item.label, value: item.value }))}
                optionFilterProp="label"
                showSearch={options.length > 8}
                className="w-full"
                aria-label={label}
                title={interiorDesignOptionLabel(field as keyof typeof INTERIOR_DESIGN_OPTIONS, value)}
                onChange={(next) => onChange(field, next as CanvasInteriorDesignSettings[K])}
            />
        </label>
    );
}

function SwitchField({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex min-h-[62px] items-center justify-between gap-3 rounded-xl border px-3" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
            <span className="flex items-center gap-1.5 text-xs font-medium">
                <Sparkles className="size-3.5" />
                {label}
            </span>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </div>
    );
}

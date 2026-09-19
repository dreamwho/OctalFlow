import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");

test("short drama real project keeps four production stages and project assets coherent", async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = randomUUID().slice(0, 8);
    const title = `真实短剧视觉验收 ${suffix}`;
    const buildId = await readCurrentBuildId();
    let projectId = "";
    await mkdir(evidenceRoot, { recursive: true });
    try {
        const created = await request.post("/api/drama/projects", { data: { title, summary: "隔离短剧生产流程", ratio: "16:9", initialScript: "夜晚的城市边缘，林夏在雨中寻找一盏亮着的灯。" } });
        expect(created.ok(), await created.text()).toBe(true);
        const initial = ((await created.json()) as { data: { project: Record<string, unknown> } }).data.project;
        projectId = String(initial.id);
        const initialEpisode = (initial.episodes as Array<Record<string, unknown>>)[0];
        const characterId = `character-${suffix}`;
        const sceneId = `scene-${suffix}`;
        const updatedProject = {
            ...initial,
            characters: [{ id: characterId, name: "林夏", description: "在雨夜寻找灯光的主角", profile: { visualIdentity: "短发、浅色风衣", styling: "简洁现代", colorPalette: "蓝青色", consistencyRules: "保持风衣轮廓" } }],
            scenes: [{ id: sceneId, name: "城市边缘", description: "雨夜城市边缘的街道" }],
            props: [],
            clues: [],
            episodes: [
                {
                    ...initialEpisode,
                    script: "夜晚的城市边缘，林夏在雨中寻找一盏亮着的灯。",
                    reviewStatus: "visual_ready",
                    shots: [
                        {
                            id: `shot-${suffix}`,
                            order: 1,
                            title: "雨夜寻找",
                            description: "林夏穿过雨幕，抬头寻找灯光。",
                            sourceText: "林夏在雨中寻找一盏亮着的灯。",
                            shotBoundary: "远景到中景",
                            dialogue: "",
                            narration: "她没有停下脚步。",
                            utterances: [],
                            imagePrompt: "雨夜城市边缘，蓝青色灯光，电影感构图",
                            videoPrompt: "镜头缓慢向前推进，雨丝保持连续",
                            cameraMotion: "缓慢推进",
                            negativePrompt: "",
                            continuity: {
                                shotSize: "中景",
                                cameraAngle: "平视",
                                composition: "居中",
                                characterBlocking: "向前行走",
                                gazeDirection: "抬头",
                                actionStart: "迈步",
                                actionEnd: "寻找灯光",
                                screenDirection: "向右",
                                axisRule: "保持轴线",
                                continuityNotes: "雨幕连续",
                            },
                            duration: 5,
                            characterIds: [characterId],
                            propIds: [],
                            clueIds: [],
                            sceneId,
                            videoMode: "storyboard",
                            storyboardFrameMode: "single",
                            storyboardStatus: "success",
                            storyboardImageUrl: "/brand/dreamyo/flow-light.png",
                            storyboardImageWidth: 1920,
                            storyboardImageHeight: 1080,
                            generationStatus: "idle",
                            audioMode: "source",
                            audioStatus: "idle",
                        },
                    ],
                },
            ],
        };
        const updated = await request.patch(`/api/drama/projects/${encodeURIComponent(projectId)}`, { data: updatedProject });
        expect(updated.ok(), await updated.text()).toBe(true);
        await updated.json();

        for (const theme of ["light", "dark"] as const) {
            await setTheme(page, theme);
            await page.goto(`/drama/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
            await expect(page.locator("[data-drama-stage-navigation]")).toBeVisible();
            await expect(page.getByRole("button", { name: "切换到剧本" })).toBeVisible();
            for (const stage of [
                { label: "剧本", heading: "剧本编辑", key: "script" },
                { label: "内容审核", heading: "内容审核", key: "review" },
                { label: "分镜", heading: "分镜编辑", key: "storyboard" },
                { label: "镜头生成", heading: "镜头生成", key: "generate" },
            ]) {
                await page.getByRole("button", { name: `切换到${stage.label}` }).click();
                const section = page.locator(`[data-drama-stage="${stage.key}"]`);
                await expect(section).toBeVisible();
                await expect(section.getByText(stage.heading, { exact: true }).first()).toBeVisible();
                const measurement = {
                    ...(await section.evaluate(
                        (element, payload) => {
                            const rect = element.getBoundingClientRect();
                            return {
                                route: `/drama/${payload.id}`,
                                viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                                theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                                state: payload.state,
                                section: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                                overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                            };
                        },
                        { id: projectId, state: `${stage.label}真实实体` },
                    )),
                    buildId,
                };
                expect(measurement.overflow).toBe(false);
                const stem = `after-drama-${stage.key}-${theme}-${testInfo.project.name}`;
                await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, entity: title }, null, 2)}\n`, "utf8");
            }

            const beforeFailureResponse = await request.get(`/api/drama/projects/${encodeURIComponent(projectId)}`);
            expect(beforeFailureResponse.ok(), await beforeFailureResponse.text()).toBe(true);
            const beforeFailureProject = ((await beforeFailureResponse.json()) as { data: { project: Record<string, unknown> } }).data.project;
            const failedProject = {
                ...beforeFailureProject,
                episodes: (beforeFailureProject.episodes as Array<Record<string, unknown>>).map((episode) => ({
                    ...episode,
                    shots: (episode.shots as Array<Record<string, unknown>>).map((shot) => ({
                        ...shot,
                        generationStatus: "error",
                        generationError: "fixture：上游视频服务拒绝本次任务",
                    })),
                })),
            };
            const failedUpdate = await request.patch(`/api/drama/projects/${encodeURIComponent(projectId)}`, { data: failedProject });
            expect(failedUpdate.ok(), await failedUpdate.text()).toBe(true);
            const failedPayload = (await failedUpdate.json()) as { data: { project: { episodes?: Array<{ shots?: Array<{ id: string; generationStatus?: string; generationError?: string }> }> } } };
            const persistedFailedShot = failedPayload.data.project.episodes?.flatMap((item) => item.shots || []).find((shot) => shot.id === `shot-${suffix}`);
            expect(persistedFailedShot).toMatchObject({ id: `shot-${suffix}`, generationStatus: "error", generationError: "fixture：上游视频服务拒绝本次任务" });
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.getByRole("button", { name: "切换到镜头生成" }).click();
            const failedSection = page.locator('[data-drama-stage="generate"]');
            await expect(failedSection).toBeVisible();
            await expect(failedSection.getByText("需要处理", { exact: true }).first()).toBeVisible();
            await expect(failedSection.getByText("视频：fixture：上游视频服务拒绝本次任务", { exact: true })).toBeVisible();
            await expect(failedSection.getByRole("button", { name: "重试镜头" }).first()).toBeVisible();
            const failedMeasurement = {
                ...(await failedSection.evaluate(
                    (element, payload) => {
                        const rect = element.getBoundingClientRect();
                        return {
                            route: `/drama/${payload.id}`,
                            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            state: "镜头生成失败可重试",
                            section: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                        };
                    },
                    { id: projectId },
                )),
                buildId,
            };
            expect(failedMeasurement.overflow).toBe(false);
            const failedStem = `after-drama-generate-error-${theme}-${testInfo.project.name}`;
            await page.screenshot({ path: path.join(evidenceRoot, `${failedStem}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `${failedStem}.json`), `${JSON.stringify({ ...failedMeasurement, entity: title }, null, 2)}\n`, "utf8");

            const failedShotId = `shot-${suffix}`;
            const retryResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/drama/projects/${encodeURIComponent(projectId)}`) && response.request().method() === "PATCH", { timeout: 30_000 });
            await failedSection.getByRole("button", { name: "重试镜头" }).first().click();
            const retryResponse = await retryResponsePromise;
            expect(retryResponse.ok(), await retryResponse.text()).toBe(true);
            const retryPayload = (await retryResponse.json()) as { data?: { project?: { episodes?: Array<{ shots?: Array<{ id: string; generationStatus?: string; generationError?: string; generationAttempt?: number }> }> } } };
            const retriedShot = retryPayload.data?.project?.episodes?.flatMap((item) => item.shots || []).find((shot) => shot.id === failedShotId);
            expect(retriedShot?.generationStatus).toMatch(/^(queued|running)$/);
            expect(retriedShot?.generationError).toBeFalsy();
            expect(retriedShot?.generationAttempt).toBeGreaterThan(0);
            await expect(failedSection.getByText(/^(排队中|生成中)$/, { exact: true }).first()).toBeVisible();
            const retryMeasurement = {
                ...(await failedSection.evaluate(
                    (element, payload) => {
                        const rect = element.getBoundingClientRect();
                        return {
                            route: `/drama/${payload.id}`,
                            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            state: "单镜头失败后仅目标镜头进入队列",
                            section: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                        };
                    },
                    { id: projectId },
                )),
                buildId,
            };
            expect(retryMeasurement.overflow).toBe(false);
            const retryStem = `after-drama-generate-retry-${theme}-${testInfo.project.name}`;
            await page.screenshot({ path: path.join(evidenceRoot, `${retryStem}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `${retryStem}.json`), `${JSON.stringify({ ...retryMeasurement, entity: title, retriedShotId: failedShotId }, null, 2)}\n`, "utf8");

            const latestResponse = await request.get(`/api/drama/projects/${encodeURIComponent(projectId)}`);
            expect(latestResponse.ok(), await latestResponse.text()).toBe(true);
            const latestProject = ((await latestResponse.json()) as { data: { project: Record<string, unknown> } }).data.project;
            const restored = await request.patch(`/api/drama/projects/${encodeURIComponent(projectId)}`, {
                data: {
                    ...latestProject,
                    episodes: (latestProject.episodes as Array<Record<string, unknown>>).map((episode) => ({
                        ...episode,
                        shots: (episode.shots as Array<Record<string, unknown>>).map((shot) => ({ ...shot, generationStatus: "idle", generationError: undefined, generationAttempt: undefined, generationTaskId: undefined })),
                    })),
                },
            });
            expect(restored.ok(), await restored.text()).toBe(true);
            await page.reload({ waitUntil: "domcontentloaded" });

            await page.getByRole("button", { name: "打开项目资产" }).click();
            await expect(page.locator('[data-drama-stage="assets"]')).toBeVisible();
            await expect(page.locator("[data-drama-assets-library]")).toBeVisible();
            await expect(page.getByText("角色", { exact: true }).first()).toBeVisible();
            const assetMeasurement = {
                ...(await page.locator('[data-drama-stage="assets"]').evaluate(
                    (element, payload) => {
                        const rect = element.getBoundingClientRect();
                        return {
                            route: `/drama/${payload.id}`,
                            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            state: "项目资产真实角色",
                            section: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                        };
                    },
                    { id: projectId },
                )),
                buildId,
            };
            expect(assetMeasurement.overflow).toBe(false);
            const assetStem = `after-drama-assets-${theme}-${testInfo.project.name}`;
            await page.screenshot({ path: path.join(evidenceRoot, `${assetStem}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `${assetStem}.json`), `${JSON.stringify({ ...assetMeasurement, entity: title }, null, 2)}\n`, "utf8");
        }
    } finally {
        if (projectId) await deleteIfPresent(request, `/api/drama/projects/${encodeURIComponent(projectId)}`);
    }
});

test("short drama audio and render chain persists results in the same production workspace", async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    const suffix = randomUUID().slice(0, 8);
    const title = `短剧音频合成验收 ${suffix}`;
    const buildId = await readCurrentBuildId();
    let projectId = "";
    await mkdir(evidenceRoot, { recursive: true });
    try {
        const created = await request.post("/api/drama/projects", { data: { title, summary: "隔离音频与成片链路", ratio: "16:9", initialScript: "林夏在雨夜寻找一盏灯。" } });
        expect(created.ok(), await created.text()).toBe(true);
        const initial = ((await created.json()) as { data: { project: Record<string, unknown> } }).data.project;
        projectId = String(initial.id);
        const episode = (initial.episodes as Array<Record<string, unknown>>)[0];
        const shotId = `shot-audio-${suffix}`;
        const shot = {
            id: shotId,
            order: 1,
            title: "雨夜对白",
            description: "林夏抬头寻找灯光。",
            sourceText: "林夏在雨夜寻找一盏灯。",
            shotBoundary: "中景",
            dialogue: "我一定会找到那盏灯。",
            narration: "",
            subtitle: "我一定会找到那盏灯。",
            utterances: [],
            imagePrompt: "雨夜城市边缘，蓝青色灯光，电影感构图",
            videoPrompt: "镜头缓慢推进，雨丝连续，人物抬头寻找灯光",
            cameraMotion: "缓慢推进",
            negativePrompt: "",
            continuity: {},
            duration: 3,
            characterIds: [],
            propIds: [],
            clueIds: [],
            videoMode: "direct",
            generationStatus: "success",
            videoUrl: "/animations/generation-loading-animation.mp4",
            audioMode: "voiceover",
            audioStatus: "idle",
        };
        const updated = await request.patch(`/api/drama/projects/${encodeURIComponent(projectId)}`, {
            data: {
                ...initial,
                activeEpisodeId: episode.id,
                episodes: [{ ...episode, reviewStatus: "visual_ready", shots: [shot] }],
            },
        });
        expect(updated.ok(), await updated.text()).toBe(true);

        await setTheme(page, "light");
        await page.goto(`/drama/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "切换到镜头生成" }).click();
        const panel = page.locator('[data-drama-stage="generate"]');
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("button", { name: "生成配音" }).first()).toBeVisible();
        const audioCreate = page.waitForResponse((response) => response.url().endsWith("/api/audio-tasks") && response.request().method() === "POST");
        await panel.getByRole("button", { name: "生成配音" }).first().click();
        const audioResponse = await audioCreate;
        expect(audioResponse.ok(), await audioResponse.text()).toBe(true);
        await expect
            .poll(
                async () => {
                    const response = await request.get(`/api/drama/projects/${encodeURIComponent(projectId)}`);
                    if (!response.ok()) return "request-error";
                    const project = ((await response.json()) as { data: { project: Record<string, unknown> } }).data.project;
                    const currentShot = (project.episodes as Array<Record<string, unknown>>).flatMap((item) => item.shots as Array<Record<string, unknown>>).find((item) => item.id === shotId);
                    return currentShot?.audioStatus || "missing";
                },
                { timeout: 60_000 },
            )
            .toBe("success");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "切换到镜头生成" }).click();
        await expect(panel.getByText("配音完成", { exact: true })).toBeVisible();
        await expect(panel.locator("audio")).toHaveCount(1);
        await expect(panel.getByRole("button", { name: "合成整集" })).toBeVisible({ timeout: 30_000 });
        await page.screenshot({ path: path.join(evidenceRoot, `after-drama-audio-ready-light-${testInfo.project.name}.png`), fullPage: false });
        await writeFile(
            path.join(evidenceRoot, `after-drama-audio-ready-light-${testInfo.project.name}.json`),
            `${JSON.stringify({ route: `/drama/${projectId}`, theme: "light", viewport: await viewport(page), state: "视频原声与 AI 配音均就绪", buildId, shotId }, null, 2)}\n`,
            "utf8",
        );

        const renderCreate = page.waitForResponse((response) => response.url().endsWith("/api/drama/render") && response.request().method() === "POST");
        await panel.getByRole("button", { name: "合成整集" }).click();
        const renderResponse = await renderCreate;
        expect(renderResponse.ok(), await renderResponse.text()).toBe(true);
        const renderTaskId = ((await renderResponse.json()) as { data: { id: string } }).data.id;
        await expect
            .poll(
                async () => {
                    const response = await request.get(`/api/drama/render/${encodeURIComponent(renderTaskId)}`);
                    if (!response.ok()) return "request-error";
                    return String(((await response.json()) as { data?: { status?: string } }).data?.status || "missing");
                },
                { timeout: 120_000 },
            )
            .toBe("success");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "切换到镜头生成" }).click();
        const downloadLink = page.getByLabel("整集合成任务").getByRole("link", { name: "下载整集成片" });
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });
        const downloadHref = await downloadLink.getAttribute("href");
        expect(downloadHref).toMatch(/\/api\/reference-assets\//);
        await page.screenshot({ path: path.join(evidenceRoot, `after-drama-render-success-light-${testInfo.project.name}.png`), fullPage: false });
        await writeFile(
            path.join(evidenceRoot, `after-drama-render-success-light-${testInfo.project.name}.json`),
            `${JSON.stringify({ route: `/drama/${projectId}`, theme: "light", viewport: await viewport(page), state: "整集合成完成且可下载", buildId, shotId, renderTaskId, downloadHref }, null, 2)}\n`,
            "utf8",
        );

        await setTheme(page, "dark");
        await page.goto(`/drama/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "切换到镜头生成" }).click();
        const darkPanel = page.locator('[data-drama-stage="generate"]');
        await expect(darkPanel).toBeVisible();
        await expect(darkPanel.getByLabel("整集合成任务").getByRole("link", { name: "下载整集成片" })).toBeVisible({ timeout: 30_000 });
        const darkRenderMeasurement = {
            route: `/drama/${projectId}`,
            theme: "dark",
            viewport: await viewport(page),
            state: "深色主题整集合成完成且可下载",
            buildId,
            renderTaskId,
            overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth),
        };
        expect(darkRenderMeasurement.overflow).toBe(false);
        await page.screenshot({ path: path.join(evidenceRoot, `after-drama-render-success-dark-${testInfo.project.name}.png`), fullPage: false });
        await writeFile(path.join(evidenceRoot, `after-drama-render-success-dark-${testInfo.project.name}.json`), `${JSON.stringify(darkRenderMeasurement, null, 2)}\n`, "utf8");
    } finally {
        if (projectId) await deleteIfPresent(request, `/api/drama/projects/${encodeURIComponent(projectId)}`);
    }
});

async function readCurrentBuildId() {
    return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
}

async function viewport(page: Page) {
    return page.evaluate(() => ({ width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width || 0, visualHeight: visualViewport?.height || 0, zoom: visualViewport?.scale || 1 }));
}

async function setTheme(page: Page, theme: "light" | "dark") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function deleteIfPresent(request: APIRequestContext, url: string) {
    const response = await request.delete(url);
    expect([200, 204, 404]).toContain(response.status());
}

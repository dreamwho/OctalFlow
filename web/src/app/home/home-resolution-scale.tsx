"use client";

import { useEffect } from "react";

/** 桌面端等比缩放：以 1440 宽的设计比例为基准（图2 基准状态），
 *  2K/4K 等更高分辨率下整页等比放大，各分辨率显示比例保持一致；
 *  <1440 宽沿用既有响应式布局，移动端不受影响。 */
export function HomeResolutionScale() {
    useEffect(() => {
        const apply = () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            // 宽度按 1440 设计基准等比放大；同时约束设计高度不低于 810，超宽屏不产生纵向截断
            const scale = width >= 1440 ? Math.min(width / 1440, height / 810, 2.5) : 1;
            document.documentElement.style.setProperty("--home-resolution-scale", scale === 1 ? "" : String(scale));
        };
        apply();
        window.addEventListener("resize", apply);
        return () => {
            window.removeEventListener("resize", apply);
            document.documentElement.style.removeProperty("--home-resolution-scale");
        };
    }, []);
    return null;
}

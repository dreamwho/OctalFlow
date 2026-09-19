"use client";

import React, { useEffect, useRef } from "react";

export function AmbientBackground({ respectReducedMotion = false }: { respectReducedMotion?: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        if (!canvas || !context || (respectReducedMotion && reduceMotion.matches)) return;

        const sprite = new Image();
        sprite.src = "/assets/octal/starlight-night.png";
        let frame = 0;
        let width = window.innerWidth;
        let height = window.innerHeight;
        let particles: Array<{ x: number; y: number; born: number; size: number }> = [];
        const duration = 7800;
        const cycle = 12100;
        const startedAt = performance.now() + 800;
        const stars = [
            { phase: 0, lastParticleAt: 0, y: 0 },
            { phase: cycle * 0.48, lastParticleAt: 0, y: -0.08 },
        ];

        const resize = () => {
            width = window.innerWidth;
            height = window.innerHeight;
            const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
        };

        const position = (progress: number, yOffset: number) => {
            const inverse = 1 - progress;
            const p0 = { x: width * -0.05, y: height * (0.77 + yOffset) };
            const p1 = { x: width * 0.18, y: height * 0.48 };
            const p2 = { x: width * 0.48, y: height * (0.2 + yOffset * 0.25) };
            const p3 = { x: width * 0.84, y: height * (0.18 + yOffset * 0.12) };
            return {
                x:
                    inverse ** 3 * p0.x +
                    3 * inverse ** 2 * progress * p1.x +
                    3 * inverse * progress ** 2 * p2.x +
                    progress ** 3 * p3.x,
                y:
                    inverse ** 3 * p0.y +
                    3 * inverse ** 2 * progress * p1.y +
                    3 * inverse * progress ** 2 * p2.y +
                    progress ** 3 * p3.y,
            };
        };

        const draw = (item: { x: number; y: number }, size: number, opacity: number) => {
            context.globalAlpha = opacity;
            context.drawImage(sprite, item.x - size / 2, item.y - size / 2, size, size);
        };

        const render = (now: number) => {
            context.clearRect(0, 0, width, height);
            stars.forEach((star) => {
                const elapsed = now - startedAt + star.phase;
                const t = elapsed >= 0 ? elapsed % cycle : -1;
                if (t < 0 || t >= duration) return;
                const raw = t / duration;
                const eased = raw * raw * (3 - 2 * raw);
                const point = position(eased, star.y);
                if (now - star.lastParticleAt > (width < 768 ? 84 : 58)) {
                    particles.push({ ...point, born: now, size: 6 + Math.random() * 4 });
                    star.lastParticleAt = now;
                }
                const fade = Math.min(t / 420, 1, (duration - t) / 760);
                draw(point, width < 768 ? 18 : 24, fade * 0.84);
            });
            particles = particles.filter((particle) => now - particle.born < 2300);
            context.globalCompositeOperation = "lighter";
            particles.forEach((particle) => {
                const age = (now - particle.born) / 2300;
                draw(particle, particle.size * (1 + age * 0.25), (1 - age) ** 2 * 0.32);
            });
            context.globalCompositeOperation = "source-over";
            context.globalAlpha = 1;
            frame = requestAnimationFrame(render);
        };

        resize();
        window.addEventListener("resize", resize);
        const start = () => {
            if (!frame) frame = requestAnimationFrame(render);
        };
        sprite.addEventListener("load", start, { once: true });
        if (sprite.complete) start();
        return () => {
            window.removeEventListener("resize", resize);
            cancelAnimationFrame(frame);
        };
    }, [respectReducedMotion]);

    return (
        <div aria-hidden="true" className="octal-ambient">
            <span className="octal-ambient__glow octal-ambient__glow--a" />
            <span className="octal-ambient__glow octal-ambient__glow--b" />
            <canvas className="octal-ambient__stars" ref={canvasRef} />
        </div>
    );
}

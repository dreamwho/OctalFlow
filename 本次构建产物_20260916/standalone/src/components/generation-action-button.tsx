"use client";

import type { ReactNode } from "react";
import { Button, type ButtonProps } from "antd";
import { LoaderCircle, Square } from "lucide-react";

import { cn } from "@/lib/utils";

type GenerationActionButtonProps = Omit<ButtonProps, "danger" | "icon" | "type"> & {
    appearance?: "primary" | "soft" | "icon";
    cancellable?: boolean;
    density?: "compact" | "standard";
    icon?: ReactNode;
    running?: boolean;
};

const GENERATE_GLYPH_SRC = "/brand/dreamyo/generation/generate-glyph.png";

function GenerateGlyph({ size }: { size: number }) {
    return <img src={GENERATE_GLYPH_SRC} alt="" aria-hidden="true" width={size} height={size} className="generation-action-button__glyph" />;
}

export function GenerationActionButton({ appearance = "primary", cancellable = false, children, className, density = "standard", disabled, icon, loading, running = false, ...props }: GenerationActionButtonProps) {
    const busy = running || Boolean(loading);
    const state = busy ? "running" : disabled ? "disabled" : "ready";
    const glyphSize = appearance === "icon" ? (density === "compact" ? 19 : 21) : 18;
    const actionIcon = running ? cancellable ? <Square className="size-3.5 fill-current" /> : <LoaderCircle className="size-4" /> : icon === undefined ? <GenerateGlyph size={glyphSize} /> : icon;

    return (
        <Button
            {...props}
            type="primary"
            danger={false}
            disabled={disabled}
            loading={loading && !running}
            data-generation-action
            data-appearance={appearance}
            data-density={density}
            data-state={state}
            data-tone={running && cancellable ? "danger" : "brand"}
            className={cn("generation-action-button", className)}
            icon={actionIcon ? <span className={cn("generation-action-button__icon", running && !cancellable && "is-spinning")}>{actionIcon}</span> : undefined}
        >
            {children ? <span className="generation-action-button__label">{children}</span> : null}
        </Button>
    );
}

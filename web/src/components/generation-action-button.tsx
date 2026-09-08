"use client";

import type { ReactNode } from "react";
import { Button, type ButtonProps } from "antd";
import { LoaderCircle, Sparkles, Square } from "lucide-react";

import { cn } from "@/lib/utils";

type GenerationActionButtonProps = Omit<ButtonProps, "danger" | "icon" | "type"> & {
    appearance?: "primary" | "soft" | "icon";
    cancellable?: boolean;
    icon?: ReactNode;
    running?: boolean;
};

export function GenerationActionButton({ appearance = "primary", cancellable = false, children, className, disabled, icon, loading, running = false, ...props }: GenerationActionButtonProps) {
    const busy = running || Boolean(loading);
    const state = busy ? "running" : disabled ? "disabled" : "ready";
    const actionIcon = running ? cancellable ? <Square className="size-3.5 fill-current" /> : <LoaderCircle className="size-4" /> : icon === undefined ? <Sparkles className="size-4" /> : icon;

    return (
        <Button
            {...props}
            type="primary"
            danger={false}
            disabled={disabled}
            loading={loading && !running}
            data-generation-action
            data-appearance={appearance}
            data-state={state}
            data-tone={running && cancellable ? "danger" : "brand"}
            className={cn("generation-action-button", className)}
            icon={actionIcon ? <span className={cn("generation-action-button__icon", running && !cancellable && "is-spinning")}>{actionIcon}</span> : undefined}
        >
            {children ? <span className="generation-action-button__label">{children}</span> : null}
        </Button>
    );
}

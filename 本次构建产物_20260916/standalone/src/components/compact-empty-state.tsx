import type { ReactNode } from "react";

import { DreamyoIcon } from "@/components/ui/dreamyo-icon";
import { cn } from "@/lib/utils";

export function CompactEmptyState({ title, description, icon, action, className }: { title: string; description?: string; icon?: ReactNode; action?: ReactNode; className?: string }) {
    return (
        <div className={cn("compact-empty-state dreamyo-empty-state flex min-h-24 items-center justify-center px-4 py-5 text-center", className)}>
            <div className="flex max-w-md flex-col items-center">
                <span className="grid size-12 place-items-center rounded-2xl bg-white/80 p-2 shadow-[0_8px_20px_rgba(99,102,241,.14)] dark:bg-white/10">{icon || <DreamyoIcon name="empty" size={32} />}</span>
                <div className="mt-3 text-sm font-semibold text-foreground">{title}</div>
                {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
                {action ? <div className="mt-3">{action}</div> : null}
            </div>
        </div>
    );
}

import { cn } from "@/lib/utils";

const toolButtonBaseClass =
    "dreamyo-composer-tool-button shrink-0 !h-11 !min-w-11 !gap-1.5 !rounded-xl !border !border-[#cbd8ee] !bg-[#f4f8ff] !px-2.5 !text-[#536789] transition-colors hover:!border-[#9aa9e8] hover:!bg-[#eaf1ff] hover:!text-[#3f4ba2] focus:!border-[#cbd8ee] focus:!bg-[#f4f8ff] focus:!text-[#536789] active:!border-[#cbd8ee] active:!bg-[#f4f8ff] active:!text-[#536789] dark:!border-[#344c78] dark:!bg-[#13254a] dark:!text-[#c1d3f3] dark:hover:!border-[#5d78b8] dark:hover:!bg-[#1f3768] dark:hover:!text-white dark:focus:!border-[#344c78] dark:focus:!bg-[#13254a] dark:focus:!text-[#c1d3f3] dark:active:!border-[#344c78] dark:active:!bg-[#13254a] dark:active:!text-[#c1d3f3] sm:!px-3";

const toolButtonOpenClass =
    "!border-[#6366f1] !bg-[#eef0ff] !text-[#3f46a0] shadow-[0_0_0_3px_rgba(99,102,241,.10)] focus:!border-[#6366f1] focus:!bg-[#eef0ff] focus:!text-[#3f46a0] active:!border-[#6366f1] active:!bg-[#eef0ff] active:!text-[#3f46a0] dark:!border-[#7c88ff] dark:!bg-[#23366a] dark:!text-[#f1f5ff] dark:focus:!border-[#4b5561] dark:focus:!bg-[#2a3037] dark:focus:!text-white dark:active:!border-[#4b5561] dark:active:!bg-[#2a3037] dark:active:!text-white";

export function creativeComposerToolButtonClass(open: boolean) {
    return cn(toolButtonBaseClass, open && toolButtonOpenClass);
}

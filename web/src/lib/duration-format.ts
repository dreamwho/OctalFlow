/** 时长格式化：毫秒 → 分钟+秒数（全站统一：模型弹层/后台卡片）。
 * 不满 1 分钟只显示秒（44s），整分钟不带秒（10m），混合显示 1m42s。 */
export function formatDurationMinSec(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    if (seconds === 0) return `${minutes}m`;
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

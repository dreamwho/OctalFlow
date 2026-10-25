#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ACTION=update
ARGS=()
PROJECT_DIR=""
while (($#)); do
    case "$1" in
        --update|--rollback) ACTION="${1#--}"; shift ;;
        -h|--help)
            cat <<'USAGE'
用法：./scripts/deploy-runtime-update.sh [--update|--rollback] [部署参数]
默认执行离线 runtime 更新：先校验并 stage runtime 包，再 apply；更新失败沿用底层脚本的自动回滚。
--rollback 恢复最近一次更新前的 Compose 配置并重建目标服务。
部署参数原样传递给 scripts/deploy-source-update.sh（如 --compose、--project-dir）。
USAGE
            exit 0 ;;
        --project-dir)
            (($# >= 2)) || { printf '增量更新失败：--project-dir 缺少路径\n' >&2; exit 1; }
            PROJECT_DIR="$2"; ARGS+=("$1" "$2"); shift 2 ;;
        *) ARGS+=("$1"); shift ;;
    esac
done
[[ -n "$PROJECT_DIR" && "$PROJECT_DIR" == /* && -d "$PROJECT_DIR" && ! -L "$PROJECT_DIR" ]] || { printf '增量更新失败：请提供现存、非符号链接的 --project-dir 绝对路径\n' >&2; exit 1; }
if command -v flock >/dev/null 2>&1; then
    exec 9>"$PROJECT_DIR/.runtime-update.lock"
    flock -n 9 || { printf '增量更新失败：另一个 runtime 更新或回滚正在执行\n' >&2; exit 1; }
fi
if [[ "$ACTION" == rollback ]]; then
    printf '正在恢复上次更新前的配置和服务…\n'
    exec "$SCRIPT_DIR/deploy-source-update.sh" --rollback "${ARGS[@]}"
fi
printf '正在校验并暂存本地构建运行包，无需下载依赖或编译…\n'
"$SCRIPT_DIR/deploy-source-update.sh" --stage-runtime "${ARGS[@]}"
printf '正在备份配置并切换服务，健康检查失败将自动回滚…\n'
exec "$SCRIPT_DIR/deploy-source-update.sh" --apply "${ARGS[@]}"

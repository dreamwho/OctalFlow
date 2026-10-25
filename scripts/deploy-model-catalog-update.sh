#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ACTION=update
ARGS=()
PROJECT_DIR=""
COMPOSE_FILE=""
APP_SERVICE=app
WORKER_SERVICE=generation-worker
GPTAPI_SERVICE=chatgpt-api

die() { printf '模型目录运行包更新失败：%s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'USAGE'
用法：./scripts/deploy-model-catalog-update.sh [--update|--resume|--rollback] --compose /path/compose.yml --project-dir /path/project
  --update    校验、暂存并应用本地 Linux runtime 包（默认）
  --resume    从已暂存 release 继续应用，不重新暂存
  --rollback 恢复最近一次成功更新前的 Compose 和服务
其他部署参数沿用 deploy-source-update.sh。
USAGE
}

while (($#)); do
    case "$1" in
        --update|--resume|--rollback) ACTION="${1#--}"; shift ;;
        --compose) (($# >= 2)) || die "--compose 缺少路径"; COMPOSE_FILE="$2"; ARGS+=("$1" "$2"); shift 2 ;;
        --project-dir) (($# >= 2)) || die "--project-dir 缺少路径"; PROJECT_DIR="$2"; ARGS+=("$1" "$2"); shift 2 ;;
        --app-service) (($# >= 2)) || die "--app-service 缺少值"; APP_SERVICE="$2"; ARGS+=("$1" "$2"); shift 2 ;;
        --worker-service) (($# >= 2)) || die "--worker-service 缺少值"; WORKER_SERVICE="$2"; ARGS+=("$1" "$2"); shift 2 ;;
        --gptapi-service) (($# >= 2)) || die "--gptapi-service 缺少值"; GPTAPI_SERVICE="$2"; ARGS+=("$1" "$2"); shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) ARGS+=("$1"); shift ;;
    esac
done

[[ -n "$PROJECT_DIR" && "$PROJECT_DIR" == /* && -d "$PROJECT_DIR" && ! -L "$PROJECT_DIR" ]] || die "请提供现存、非符号链接的 --project-dir 绝对路径"
[[ -n "$COMPOSE_FILE" && "$COMPOSE_FILE" == /* && -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || die "请提供现存、非符号链接的 --compose 绝对路径"
[[ "$PROJECT_DIR" != *$'\n'* && "$PROJECT_DIR" != *$'\r'* && "$COMPOSE_FILE" != *$'\n'* && "$COMPOSE_FILE" != *$'\r'* ]] || die "Compose 与项目路径不得包含换行符"
[[ "$APP_SERVICE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && "$WORKER_SERVICE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && "$GPTAPI_SERVICE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "Compose 服务名格式无效"
PROJECT_DIR="$(cd -- "$PROJECT_DIR" && pwd)"
COMPOSE_FILE="$(cd -- "$(dirname -- "$COMPOSE_FILE")" && pwd)/$(basename -- "$COMPOSE_FILE")"
[[ -f "$PROJECT_DIR/.env" && ! -L "$PROJECT_DIR/.env" ]] || die "项目目录必须包含普通 .env 文件"
for tool in docker sha256sum python3 flock od tr; do command -v "$tool" >/dev/null 2>&1 || die "缺少主机命令：$tool"; done
[[ ! -L "$PROJECT_DIR/.runtime-update.lock" ]] || die "runtime 更新锁不能是符号链接"
exec 9>"$PROJECT_DIR/.runtime-update.lock"
flock -n 9 || die "另一个 runtime 更新或回滚正在执行"
docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2"

STATE_DIR="$PROJECT_DIR/.source-update"
TRANSACTION_DIR="$STATE_DIR/model-catalog-update"
BACKUPS_DIR="$TRANSACTION_DIR/backups"
PENDING="$TRANSACTION_DIR/pending"
[[ ! -L "$STATE_DIR" && ! -L "$TRANSACTION_DIR" && ! -L "$BACKUPS_DIR" ]] || die "事务状态目录不能是符号链接"
mkdir -p "$BACKUPS_DIR"
MARKER="$(dirname "$COMPOSE_FILE")/.catalog-update-expected-hash"
[[ ! -L "$MARKER" ]] || die "Compose 哈希事务标记不能是符号链接"
RECOVERING=0

read_field() { sed -n "s/^$2=//p" "$1"; }
restore_compose() {
    local backup="$1" temp
    temp="$(mktemp "$(dirname "$COMPOSE_FILE")/.compose-catalog-restore.XXXXXX")"
    cp -p "$backup" "$temp"
    mv -f "$temp" "$COMPOSE_FILE"
}
recover_pending() {
    [[ -f "$PENDING" ]] || return 0
    [[ ! -L "$PENDING" ]] || die "事务 journal 不能是符号链接"
    local recorded_compose recorded_project backup backup_hash before_hash expected_hash current_hash compose_project action phase marker_exists
    recorded_compose="$(read_field "$PENDING" compose)"
    recorded_project="$(read_field "$PENDING" project)"
    backup="$(read_field "$PENDING" backup)"
    backup_hash="$(read_field "$PENDING" backup_sha256)"
    before_hash="$(read_field "$PENDING" before_sha256)"
    [[ "$recorded_compose" == "$COMPOSE_FILE" && "$recorded_project" == "$PROJECT_DIR" ]] || die "待恢复事务属于其他 Compose 文件或项目"
    [[ "$backup" == "$BACKUPS_DIR/"* && -f "$backup" && ! -L "$backup" ]] || die "待恢复事务缺少受管理的 Compose 备份"
    [[ "$backup_hash" =~ ^[0-9a-f]{64}$ && "$before_hash" =~ ^[0-9a-f]{64}$ ]] || die "待恢复事务的哈希字段无效"
    [[ "$(sha256sum "$backup" | awk '{print $1}')" == "$backup_hash" && "$backup_hash" == "$before_hash" ]] || die "待恢复事务 Compose 备份校验失败"
    compose_project="$(read_field "$PENDING" compose_project)"
    [[ "$compose_project" =~ ^[A-Za-z0-9_-]+$ ]] || die "待恢复事务 Compose 项目名无效"
    action="$(read_field "$PENDING" action)"
    phase="$(read_field "$PENDING" phase)"
    [[ "$action" == update || "$action" == rollback ]] || die "待恢复事务 action 无效"
    [[ "$phase" == prepared || "$phase" == restoring ]] || die "待恢复事务 phase 无效"
    current_hash="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
    marker_exists=0
    if [[ -f "$MARKER" && ! -L "$MARKER" ]]; then
        expected_hash="$(cat "$MARKER")"
        [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || die "Compose 事务预期哈希无效"
        marker_exists=1
    fi
    if [[ "$current_hash" == "$before_hash" && "$phase" == prepared ]]; then
        if [[ "$action" != update || "$marker_exists" != 1 ]]; then
            rm -f "$PENDING" "$MARKER"
            return 0
        fi
    fi
    if [[ "$current_hash" != "$before_hash" ]]; then
        [[ "$marker_exists" == 1 && "$current_hash" == "$expected_hash" ]] || die "Compose 不是事务记录中的原版或已生成版本；拒绝覆盖"
    elif [[ "$action" == rollback && "$phase" == prepared ]]; then
        die "回滚事务状态与原 Compose 不一致；拒绝覆盖"
    fi
    write_pending_phase restoring
    restore_compose "$backup"
    local compose_args=(--project-directory "$PROJECT_DIR" --project-name "$compose_project" --env-file "$PROJECT_DIR/.env" -f "$COMPOSE_FILE")
    docker compose "${compose_args[@]}" config -q || die "已恢复原 Compose，但配置校验失败；备份保留：$backup"
    docker compose "${compose_args[@]}" up -d --no-deps --pull never --force-recreate --wait \
        "$(read_field "$PENDING" app_service)" "$(read_field "$PENDING" worker_service)" "$(read_field "$PENDING" gptapi_service)" \
        || die "已恢复原 Compose，但目标服务重建或健康检查失败；备份保留：$backup"
    rm -f "$PENDING" "$MARKER"
    printf '已恢复中断前的 Compose 和目标服务；备份保留：%s\n' "$backup" >&2
}
write_pending_phase() {
    local phase="$1" temp
    temp="$(mktemp "$TRANSACTION_DIR/.pending.XXXXXX")"
    awk -F= -v phase="$phase" '$1 != "phase" { print } END { print "phase=" phase }' "$PENDING" > "$temp"
    chmod 0600 "$temp"
    mv -f "$temp" "$PENDING"
}
write_pending_record() {
    local action="$1" phase="$2" backup="$3" backup_hash="$4" before_hash="$5" compose_project="$6" release="$7" temp
    temp="$(mktemp "$TRANSACTION_DIR/.pending.XXXXXX")"
    printf 'action=%s\nphase=%s\nbackup=%s\nbackup_sha256=%s\nbefore_sha256=%s\ncompose=%s\nproject=%s\ncompose_project=%s\napp_service=%s\nworker_service=%s\ngptapi_service=%s\nrelease=%s\n' \
        "$action" "$phase" "$backup" "$backup_hash" "$before_hash" "$COMPOSE_FILE" "$PROJECT_DIR" "$compose_project" \
        "$APP_SERVICE" "$WORKER_SERVICE" "$GPTAPI_SERVICE" "$release" > "$temp"
    chmod 0600 "$temp"
    mv -f "$temp" "$PENDING"
}
on_exit() {
    local status=$?
    trap - EXIT HUP INT TERM
    if ((status != 0)) && [[ -f "$PENDING" ]] && ((RECOVERING == 0)); then
        RECOVERING=1
        recover_pending || printf '事务恢复未完成；下次运行本脚本会继续恢复。\n' >&2
    fi
    exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

recover_pending
if [[ "$ACTION" == rollback ]]; then
    LAST_APPLY="$STATE_DIR/last-apply"
    [[ -f "$LAST_APPLY" && ! -L "$LAST_APPLY" ]] || die "没有可回滚的 runtime 更新记录"
    TARGET_BACKUP="$(read_field "$LAST_APPLY" backup)"
    TARGET_BACKUP_HASH="$(read_field "$LAST_APPLY" backup_sha256)"
    APPLIED_HASH="$(read_field "$LAST_APPLY" applied_sha256)"
    COMPOSE_PROJECT="$(read_field "$LAST_APPLY" project)"
    [[ "$TARGET_BACKUP" == "$STATE_DIR/backups/"* && -f "$TARGET_BACKUP" && ! -L "$TARGET_BACKUP" ]] || die "找不到上一版本 Compose 备份"
    [[ "$TARGET_BACKUP_HASH" =~ ^[0-9a-f]{64}$ && "$(sha256sum "$TARGET_BACKUP" | awk '{print $1}')" == "$TARGET_BACKUP_HASH" ]] || die "上一版本 Compose 备份校验失败"
    [[ "$COMPOSE_PROJECT" =~ ^[A-Za-z0-9_-]+$ && "$APPLIED_HASH" == "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" ]] || die "Compose 已变化或回滚记录项目无效；拒绝覆盖"
    ROLLBACK_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')-rollback"
    BACKUP="$BACKUPS_DIR/compose.$ROLLBACK_ID.bak"
    [[ ! -e "$BACKUP" && ! -L "$BACKUP" ]] || die "回滚事务备份 ID 冲突；没有修改 Compose"
    cp -p "$COMPOSE_FILE" "$BACKUP"
    BEFORE_HASH="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
    BACKUP_HASH="$(sha256sum "$BACKUP" | awk '{print $1}')"
    [[ "$BACKUP_HASH" == "$BEFORE_HASH" ]] || die "无法创建回滚前 Compose 备份"
    MARKER_TEMP="$(mktemp "$(dirname "$MARKER")/.catalog-update-expected-hash.XXXXXX")"
    printf '%s\n' "$TARGET_BACKUP_HASH" > "$MARKER_TEMP"
    chmod 0600 "$MARKER_TEMP"
    mv -f "$MARKER_TEMP" "$MARKER"
    write_pending_record rollback prepared "$BACKUP" "$BACKUP_HASH" "$BEFORE_HASH" "$COMPOSE_PROJECT" "$ROLLBACK_ID"
    "$SCRIPT_DIR/deploy-source-update.sh" --rollback "${ARGS[@]}"
    [[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" == "$TARGET_BACKUP_HASH" ]] || die "底层 rollback 未恢复到备份 Compose"
    rm -f "$PENDING" "$MARKER"
    trap - EXIT HUP INT TERM
    printf '已回滚到上一版本；仅重建 %s %s %s。\n' "$APP_SERVICE" "$WORKER_SERVICE" "$GPTAPI_SERVICE"
    exit 0
fi

validate_package() {
    local baseline
    [[ -f "$PACKAGE_DIR/expected-build-id.txt" && -f "$PACKAGE_DIR/expected-runtime-files.json" && -f "$PACKAGE_DIR/expected-python-files.json" && -f "$PACKAGE_DIR/python-runtime-files.txt" ]] || die "包缺少 Build ID、Web/Python 基线清单"
    [[ "$(cat "$PACKAGE_DIR/expected-build-id.txt")" == olNkUh-lqWJcSnTkri4l9 ]] || die "Web 旧版 Build ID 必须固定为已交付版本 olNkUh-lqWJcSnTkri4l9"
    python3 - "$PACKAGE_DIR/expected-runtime-files.json" <<'PY' || die "Web 运行基线必须绑定已交付镜像"
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
assert d.get("buildId")=="olNkUh-lqWJcSnTkri4l9"
assert d.get("imageId")=="sha256:640c3f1482573ec994e96a4d18d0fc8eeab7a7fadcef6ed0e305448e6d5783ff"
PY
    python3 - "$PACKAGE_DIR/python-runtime-files.txt" "$PACKAGE_DIR/expected-python-files.json" <<'PY' || die "Python baseline manifest 无效"
import json,pathlib,sys
paths=[x.strip() for x in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines() if x.strip()]
expected=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
want={
 "services/chatgpt-api/api/app.py",
 "services/chatgpt-api/api/accounts.py",
 "services/chatgpt-api/services/account_service.py",
 "services/chatgpt-api/api/integration.py",
 "services/chatgpt-api/contracts/models.py",
 "services/chatgpt-api/services/model_catalog_service.py",
 "services/chatgpt-api/services/openai_backend_api.py",
 "services/chatgpt-api/services/image_failure.py",
 "services/chatgpt-api/utils/helper.py",
}
assert len(paths)==len(set(paths)) and set(paths)==want
assert isinstance(expected,dict) and set(expected)==want
old_hotfix={
 "services/chatgpt-api/api/app.py":{"5b4121f19f53be57f5fa5469487e0a95b13a39a82121b363ef7577b1a0a999ed","34043bf2430398d79441f02c41cc8122e7cef267a53eb797c6c06ecfdf50f55d"},
 "services/chatgpt-api/api/accounts.py":{"ab929e518eb6856b936ebcad974c18c37f8a77e623a9663596bdf5964bb374e6","c2fb4f56ef3b09516b0c9ebad1d400213e8bd44082699cfe0895dd9d4e96394f"},
 "services/chatgpt-api/services/account_service.py":{"13805a96cfc46ece969cb455ab6916c11edca2b2a0055464556c8ca7665cea22","0be685800aefd92e7759ba64e27c44b1f37e94769e9a652fac9eb2bc1e7b47e0"},
}
catalog_baseline={
 "services/chatgpt-api/api/integration.py":{"8e10eb09bf83e44f86f7a5eb8961c527b922e3e12b11cb8971ed5bca11adb95f"},
 "services/chatgpt-api/contracts/models.py":{"1008e7bc2b0f68d2d08e8052f75f58a1cbd3db82cb827bce187f1288f80888c2"},
 "services/chatgpt-api/services/model_catalog_service.py":{"b835852b76d7a5f87c26941221781baf4c8c444730d2003830121664ff3608a2"},
 "services/chatgpt-api/services/openai_backend_api.py":{"4c0fc5798522bf6b2f7836340397739ee06a205a999f9d189595fa51ccef90d3"},
 "services/chatgpt-api/services/image_failure.py":{"3233cb7c754d8f696469775d6f8000dac9adf6db21d56318774a349024df45bf"},
 "services/chatgpt-api/utils/helper.py":{"03abab08841bc5ac64ed282ffb7470d959be95abe37abb034fd12fb9850e5d80"},
}
for path, hashes in expected.items():
    assert isinstance(hashes,list) and len(set(hashes))==len(hashes)
    assert all(isinstance(x,str) and len(x)==64 and all(c in "0123456789abcdef" for c in x) for x in hashes)
    if path in old_hotfix:
        assert len(hashes)==2 and set(hashes)==old_hotfix[path]
    else:
        assert len(hashes)==1 and set(hashes)==catalog_baseline[path]
PY
}

validate_package
if [[ "$ACTION" == update ]]; then
    "$SCRIPT_DIR/deploy-source-update.sh" --stage-runtime --catalog-runtime "${ARGS[@]}"
fi
RELEASE_ID="$(cat "$STATE_DIR/staged-release" 2>/dev/null || true)"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ && -f "$STATE_DIR/releases/$RELEASE_ID/metadata" ]] || die "没有可恢复的 catalog runtime staged release"
[[ "$(sed -n 's/^package_mode=//p' "$STATE_DIR/releases/$RELEASE_ID/metadata")" == runtime ]] || die "staged release 不是 runtime 包"
BACKUP="$BACKUPS_DIR/compose.$RELEASE_ID.bak"
BEFORE_HASH="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
if [[ -e "$BACKUP" || -L "$BACKUP" ]]; then
    [[ -f "$BACKUP" && ! -L "$BACKUP" && "$(sha256sum "$BACKUP" | awk '{print $1}')" == "$BEFORE_HASH" ]] || die "release 已有备份与当前 Compose 不匹配；拒绝重用"
else
    cp -p "$COMPOSE_FILE" "$BACKUP"
fi
BACKUP_HASH="$(sha256sum "$BACKUP" | awk '{print $1}')"
[[ "$BACKUP_HASH" == "$BEFORE_HASH" ]] || die "无法创建完整 Compose 备份"
COMPOSE_PROJECT="$(sed -n 's/^project=//p' "$STATE_DIR/releases/$RELEASE_ID/metadata")"
[[ "$COMPOSE_PROJECT" =~ ^[A-Za-z0-9_-]+$ ]] || die "staged release 缺少有效 Compose 项目名"
write_pending_record update prepared "$BACKUP" "$BACKUP_HASH" "$BEFORE_HASH" "$COMPOSE_PROJECT" "$RELEASE_ID"

DREAMYO_SOURCE_UPDATE_COMPOSE_HASH_MARKER="$MARKER" \
    "$SCRIPT_DIR/deploy-source-update.sh" --apply --catalog-runtime "${ARGS[@]}"
[[ -f "$STATE_DIR/last-apply" && "$(sed -n 's/^release=//p' "$STATE_DIR/last-apply")" == "$STATE_DIR/releases/$RELEASE_ID" ]] || die "底层 runtime apply 未写入成功记录"
rm -f "$PENDING" "$MARKER"
trap - EXIT HUP INT TERM
printf '模型目录 runtime 更新完成；新 Build ID：%s\n' "$(cat "$PACKAGE_DIR/runtime/web/.next/BUILD_ID")"

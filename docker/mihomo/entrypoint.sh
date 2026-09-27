#!/bin/sh
set -eu

umask 077

secret=${DREAMYO_MAGIC_PROXY_SECRET-}
if [ "${#secret}" -lt 32 ]; then
    printf '%s\n' 'DREAMYO_MAGIC_PROXY_SECRET must contain at least 32 characters' >&2
    exit 1
fi

listen_host=${DREAMYO_MAGIC_PROXY_LISTEN_HOST-}
case "$listen_host" in
    0.0.0.0|127.0.0.1) ;;
    *)
        printf '%s\n' 'DREAMYO_MAGIC_PROXY_LISTEN_HOST must be 0.0.0.0 or 127.0.0.1' >&2
        exit 1
        ;;
esac

runtime_dir=/root/.config/mihomo/runtime
provider_file=$runtime_dir/subscription.yaml
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"

if [ ! -e "$provider_file" ]; then
    printf '%s\n' 'proxies: []' > "$provider_file"
fi
if [ ! -f "$provider_file" ]; then
    printf '%s\n' 'Mihomo provider path is not a regular file' >&2
    exit 1
fi

chmod 600 "$provider_file"
chown 1000:1000 "$runtime_dir" "$provider_file"

if [ -f "$runtime_dir/config.yaml" ]; then
    # 旧版本应用可能写入过携带无效 provider 路径的动态配置：先校验，解析失败回退
    # bootstrap 启动，避免容器崩溃循环卡死整个部署（应用随后会重写正确配置并热重载）。
    if /mihomo -t -f "$runtime_dir/config.yaml" >/dev/null 2>&1; then
        exec /mihomo -f "$runtime_dir/config.yaml" -secret "$DREAMYO_MAGIC_PROXY_SECRET" -ext-ctl "$DREAMYO_MAGIC_PROXY_LISTEN_HOST:9090"
    fi
    printf '%s\n' 'runtime config.yaml is invalid; falling back to bootstrap config' >&2
fi

exec /mihomo -secret "$DREAMYO_MAGIC_PROXY_SECRET" -ext-ctl "$DREAMYO_MAGIC_PROXY_LISTEN_HOST:9090"

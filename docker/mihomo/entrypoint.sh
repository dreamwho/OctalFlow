#!/bin/sh
set -eu

umask 077

secret=${OCTALAICANVAS_MAGIC_PROXY_SECRET-}
if [ "${#secret}" -lt 32 ]; then
    printf '%s\n' 'OCTALAICANVAS_MAGIC_PROXY_SECRET must contain at least 32 characters' >&2
    exit 1
fi

listen_host=${OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST-}
case "$listen_host" in
    0.0.0.0|127.0.0.1) ;;
    *)
        printf '%s\n' 'OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST must be 0.0.0.0 or 127.0.0.1' >&2
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

exec /mihomo -secret "$OCTALAICANVAS_MAGIC_PROXY_SECRET" -ext-ctl "$OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST:9090"

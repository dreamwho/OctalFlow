#!/usr/bin/env bash
# 在服务器部署目录执行：bash 服务器自检omni模型.sh   （v2：修正端口与判断依据）
set -Eeuo pipefail
cd "$(dirname "$0")"

NEW_GEMINIAI_CREATED="2026-10-02T05:24:06"
NEW_APP_CREATED="2026-10-02T07:20:27"

echo "== 1) 镜像新旧判断（最可靠依据：镜像创建时间）=="
for img in dreamyo-geminiai:offline dreamyo-app:offline; do
  CREATED=$(docker inspect "$img" --format '{{.Created}}' 2>/dev/null || echo "missing")
  case "$img" in
    *geminiai*) THRESHOLD="$NEW_GEMINIAI_CREATED" ;;
    *)          THRESHOLD="$NEW_APP_CREATED" ;;
  esac
  echo "  $img 创建于 $CREATED（新镜像应 >= $THRESHOLD）"
  if [[ "$CREATED" < "$THRESHOLD" ]]; then
    echo "  BAD: $img 是旧镜像 —— 处置：docker load -i images/${img%%:*}.tar"
  else
    echo "  OK"
  fi
done

echo
echo "== 2) GeminiAI sidecar（8080 端口）目录是否含 omni =="
GKEY=$(grep -E "^DREAMYO_GEMINIAI_API_KEY=" .env 2>/dev/null | cut -d= -f2)
if [ -z "$GKEY" ]; then
  echo "  .env 无 DREAMYO_GEMINIAI_API_KEY，跳过"
else
  if curl -s -H "x-api-key: $GKEY" http://127.0.0.1:8080/v1/models | grep -q "gemini-omni-1.1-flash"; then
    echo "  OK: sidecar 目录包含 gemini-omni-1.1-flash"
  else
    echo "  BAD: 目录没有 omni —— geminiai sidecar 需重启加载新镜像：docker restart dreamyo-geminiai 或重跑 ./一键部署.sh"
  fi
fi

echo
echo "== 3) app 代码是否含 omni 接入 =="
if docker exec dreamyo sh -c "grep -rl 'gemini-omni-1.1-flash' .next/server 2>/dev/null | head -1" | grep -q .; then
  echo "  OK"
else
  echo "  BAD: app 代码旧 —— 处置：docker load -i images/app.tar 后重跑 ./一键部署.sh"
fi

echo
echo "== 4) geminivids 运行状态 =="
docker ps --filter name=dreamyo-geminivids --format '{{.Names}} {{.Status}}'

echo
echo "== 结论 =="
echo "第 1/3 步全 OK 后：后台 → GeminiAIStudio → 同步目录（如按钮存在）或直接勾选 gemini-omni-1.1-flash → 保存所选模型。"
echo "保存时若页面弹『所选模型不在 GeminiAI 已同步目录中』= 第 2 步 sidecar 未含 omni（旧镜像未重载）。"

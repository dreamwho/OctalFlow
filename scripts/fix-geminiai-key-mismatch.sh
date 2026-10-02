#!/usr/bin/env bash
# 服务器部署目录执行：bash fix-geminiai-key-mismatch.sh
# 诊断并修复：geminiai 容器内 key 与 .env key 不一致（401）的问题
set -Eeuo pipefail
cd "$(dirname "$0")"

GKEY=$(grep -E "^DREAMYO_GEMINIAI_API_KEY=" .env | tr -d "\r\"" | cut -d= -f2 | tail -1)
CKEY=$(docker exec dreamyo-geminiai printenv AISTUDIO_API_KEY 2>/dev/null | tr -d "\r" || echo "")

echo "== .env 中该 key 出现次数 =="
grep -cE "^DREAMYO_GEMINIAI_API_KEY=" .env || true
echo "== 对比（末 8 位）=="
echo ".env  key: ...${GKEY: -8} (长度 ${#GKEY})"
echo "容器 key: ...${CKEY: -8} (长度 ${#CKEY})"

echo
echo "== 用容器自己的 key 直接测 /v1/models（验证镜像内容）=="
CODE=$(curl -s -o /tmp/gvm2.json -w "%{http_code}" -H "x-api-key: $CKEY" http://127.0.0.1:8080/v1/models)
echo "HTTP $CODE"
if [ "$CODE" = "200" ]; then
  echo "omni 数量: $(grep -o 'gemini-omni[^\"]*' /tmp/gvm2.json | sort -u | tr '\n' ' ')"
  echo ">>> 镜像内容正确。"
else
  echo ">>> 用容器 key 仍失败，请把上面输出发给开发。"
  exit 1
fi

if [ "$GKEY" != "$CKEY" ]; then
  echo
  echo "== key 不一致 → 全量 force-recreate 让所有容器重读 .env =="
  docker compose -f docker-compose.offline-external-db.yml up -d --force-recreate
  sleep 20
  CODE2=$(curl -s -o /tmp/gvm3.json -w "%{http_code}" -H "x-api-key: $GKEY" http://127.0.0.1:8080/v1/models)
  echo "修复后 .env key 请求: HTTP $CODE2"
  if [ "$CODE2" = "200" ]; then
    echo "omni 数量: $(grep -o 'gemini-omni[^\"]*' /tmp/gvm3.json | sort -u | tr '\n' ' ')"
    echo ">>> 修复完成。浏览器强刷后台页面，勾选 gemini-omni-1.1-flash 保存即可。"
  else
    echo ">>> 仍失败，请把输出发给开发。"
  fi
else
  echo ">>> key 一致但此前 401？请重跑之前那段输出原始响应的命令并发我。"
fi

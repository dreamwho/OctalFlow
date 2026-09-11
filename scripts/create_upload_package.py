import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "待上传文件_20260911")

if os.path.exists(TARGET):
    shutil.rmtree(TARGET)
os.makedirs(TARGET, exist_ok=True)

FILES = [
    # backend chatgpt-api
    "services/chatgpt-api/api/integration.py",
    "services/chatgpt-api/contracts/proxy.py",
    "services/chatgpt-api/services/proxy_management_service.py",
    "services/chatgpt-api/services/proxy_service.py",
    "services/chatgpt-api/tests/test_proxy_diagnostics.py",
    "services/chatgpt-api/tests/test_runtime_contract.py",
    # web src - chatgpt-api
    "web/src/services/api/chatgpt-api.ts",
    "web/src/lib/server/chatgpt-api-service.ts",
    "web/src/app/admin/chatgpt-api/components/admin-chatgpt-api-section.tsx",
    "web/src/app/admin/chatgpt-api/components/chatgpt-proxy-manager.tsx",
    "web/src/app/admin/chatgpt-api/components/chatgpt-proxy-runtime-control.tsx",
    "web/src/app/admin/chatgpt-api/components/chatgpt-chained-proxy-panel.tsx",
    "web/src/app/admin/chatgpt-api/components/use-chatgpt-proxy-runtime.ts",
    "web/src/app/admin/chatgpt-api/components/use-chatgpt-proxy-runtime.test.ts",
    # web src - geminiai & gemini-tools & magic-proxy
    "web/src/components/admin/magic-proxy-binding-card.tsx",
    "web/src/components/admin/admin-geminiai-section.tsx",
    "web/src/components/admin/admin-gemini-tools-section.tsx",
    "web/src/services/api/magic-proxy.ts",
    "web/src/lib/server/magic-proxy-service.ts",
    "web/src/lib/server/database/magic-proxy-repository.ts",
    "web/src/lib/server/database/schema.ts",
    "web/src/lib/server/geminiai-provider.ts",
    "web/src/lib/server/gemini-tools-store.ts",
    "web/src/lib/server/geminiai-request-log-store.ts",
    # database schema doc
    "docs/backend-database.md",
]

for rel_path in FILES:
    src = os.path.join(ROOT, rel_path)
    dst = os.path.join(TARGET, rel_path)
    if os.path.exists(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    else:
        print(f"Warning: file not found {src}")

# Copy web/.next build directory (excluding cache)
next_src = os.path.join(ROOT, "web", ".next")
next_dst = os.path.join(TARGET, "web", ".next")
if os.path.exists(next_src):
    shutil.copytree(next_src, next_dst, ignore=shutil.ignore_patterns("cache"))

print(f"Successfully created upload package at {TARGET}")

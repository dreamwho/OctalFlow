import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "待上传文件_20260926")

if os.path.islink(TARGET) or os.path.isfile(TARGET):
    os.unlink(TARGET)
elif os.path.isdir(TARGET):
    shutil.rmtree(TARGET)
os.makedirs(TARGET, exist_ok=True)

# 核心修改的源码与配置文件
SRC_FILES = [
    # 1. 画布富文本提示词：点击引用图片更换浮层定位修复、空白取消、分类高亮隔离与多次引用完整识别
    "web/src/app/(user)/canvas/components/canvas-rich-prompt-editor.tsx",
    "web/src/app/(user)/canvas/components/canvas-rich-prompt-editor.test.tsx",
    "web/src/app/(user)/canvas/components/canvas-node-content.tsx",
    # 2. Dola API 服务端：下行 creation 失败终态识别、提取 fail_msg/fail_code、会话页面定位与 DOM 错误提取、截图留证
    "services/dola-api/src/dola_api/contracts.py",
    "services/dola-api/src/dola_api/query.py",
    "services/dola-api/src/dola_api/session.py",
    "services/dola-api/src/dola_api/app.py",
    "services/dola-api/tests/test_contracts.py",
    # 3. Web 端 Dola 协议错误字典、请求日志与路由层错误/截图完整持久化
    "web/src/lib/dola-errors.ts",
    "web/src/lib/dola-errors.test.ts",
    "web/src/lib/server/dola/service.ts",
    "web/src/app/api/dola/[...path]/route.ts",
    "web/src/app/api/ai/system/[channelId]/[...path]/route.ts",
    "web/src/lib/server/dola/provider.ts",
    "web/src/lib/server/dola/provider.test.ts",
    "web/src/lib/server/dola/admin.ts",
    # 4. 后台基础设置与分类排序
    "web/src/lib/auth/postgres-auth-settings-service.ts",
    "web/src/lib/auth/postgres-auth-settings-service.test.ts",
]

for rel_path in SRC_FILES:
    src = os.path.join(ROOT, rel_path)
    dst = os.path.join(TARGET, rel_path)
    if os.path.exists(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        print(f"Copied: {rel_path}")
    else:
        print(f"Warning: file not found {src}")

# 复制前端编译产物 web/.next（排除开发与本地编译缓存 cache）
next_src = os.path.join(ROOT, "web", ".next")
next_dst = os.path.join(TARGET, "web", ".next")
if os.path.exists(next_src):
    print("Copying Next.js build output web/.next (excluding cache)...")
    shutil.copytree(next_src, next_dst, ignore=shutil.ignore_patterns("cache", "build-isolated-data"))
    print(f"Next.js build output copied to {next_dst}")

print(f"\nSuccessfully created upload package at: {TARGET}")

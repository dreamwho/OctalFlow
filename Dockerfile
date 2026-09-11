# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dreamina-build
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
ADD --checksum=sha256:78e49e845b70b17c42015f9214a295564c9bf9048f8a5745429c18566c270ff3 https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_linux_amd64 /usr/local/bin/dreamina
RUN chmod 0755 /usr/local/bin/dreamina && dreamina --version

FROM node:22-bookworm-slim AS depth-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/video-depth-build
COPY services/video-depth/requirements.txt ./requirements.txt
RUN python3 -m venv /opt/video-depth \
    && /opt/video-depth/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/video-depth/bin/pip install --no-cache-dir --no-deps torch==2.13.0 torchvision==0.28.0 --index-url https://download.pytorch.org/whl/cpu \
    && /opt/video-depth/bin/pip install --no-cache-dir -r requirements.txt
COPY services/video-depth/download_model.py ./download_model.py
RUN OCTALAICANVAS_VIDEO_DEPTH_MODEL=/opt/video-depth-model /opt/video-depth/bin/python download_model.py \
    && /opt/video-depth/bin/python -c "from transformers import AutoImageProcessor, AutoModelForDepthEstimation; p='/opt/video-depth-model'; AutoImageProcessor.from_pretrained(p, local_files_only=True); AutoModelForDepthEstimation.from_pretrained(p, local_files_only=True)"

FROM python:3.14-slim-bookworm AS chatgpt-build
WORKDIR /app/services/chatgpt-api
COPY services/chatgpt-api/pyproject.toml services/chatgpt-api/uv.lock ./
RUN pip install --no-cache-dir uv \
    && uv sync --locked --no-dev

FROM node:22-bookworm-slim AS web-build

WORKDIR /app/web
ARG BUILD_NODE_OPTIONS
ARG NEXT_BUILD_CPUS
ARG PNPM_VERSION=11.9.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=1
ENV NODE_OPTIONS=${BUILD_NODE_OPTIONS}
ENV NEXT_BUILD_CPUS=${NEXT_BUILD_CPUS}
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
COPY .env* /app/
RUN if [ -f /app/.env ]; then cp -f /app/.env /app/web/.env; fi
RUN --mount=type=cache,target=/app/web/.next/cache pnpm run typecheck && NEXT_SKIP_BUILD_TYPECHECK=1 pnpm run build
RUN node scripts/build-local-data-migration.mjs
RUN set -eux; \
    mkdir -p /app/sharp-runtime/node_modules/.pnpm; \
    find node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-*' -exec cp -a {} /app/sharp-runtime/node_modules/.pnpm/ \;; \
    test -n "$(find /app/sharp-runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-linux-*' -print -quit)"; \
    test -n "$(find /app/sharp-runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-libvips-linux-*' -print -quit)"

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV TZ=Asia/Shanghai
ENV OCTALAICANVAS_DATA_DIR=/app/web/.data
ENV OCTALAICANVAS_INTERNAL_ORIGIN=http://127.0.0.1:3000
ENV NODE_OPTIONS=--max-old-space-size=384
ENV UV_THREADPOOL_SIZE=2
ENV OCTALAICANVAS_VIDEO_DEPTH_PYTHON=/opt/video-depth/bin/python
ENV OCTALAICANVAS_VIDEO_DEPTH_SCRIPT=/app/services/video-depth/infer_depth_frames.py
ENV OCTALAICANVAS_VIDEO_DEPTH_MODEL=/opt/video-depth-model
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates ffmpeg fonts-noto-cjk postgresql-client python3 libgomp1 libsqlite3-0 libbz2-1.0 libreadline8 libffi8 \
    && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/web/scripts
COPY --from=depth-build /opt/video-depth /opt/video-depth
COPY --from=depth-build /opt/video-depth-model /opt/video-depth-model
COPY services/video-depth/infer_depth_frames.py services/video-depth/NOTICE.md /app/services/video-depth/
COPY --from=dreamina-build /usr/local/bin/dreamina /usr/local/bin/dreamina
COPY --from=chatgpt-build /usr/local/bin/python3.13 /usr/local/bin/python3.13
COPY --from=chatgpt-build /usr/local/lib/libpython3.13.so.1.0 /usr/local/lib/libpython3.13.so.1.0
COPY --from=chatgpt-build /usr/local/lib/python3.13 /usr/local/lib/python3.13
COPY services/chatgpt-api /app/services/chatgpt-api
COPY --from=chatgpt-build /app/services/chatgpt-api/.venv /app/services/chatgpt-api/.venv
RUN ln -sfn python3.13 /usr/local/bin/python3 && ln -sfn python3.13 /usr/local/bin/python \
    && /app/services/chatgpt-api/.venv/bin/python -c "import fastapi, uvicorn, sqlalchemy, cryptography, curl_cffi, tiktoken, PIL, pybase64"

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
COPY --from=web-build /app/sharp-runtime/node_modules/.pnpm /app/web/node_modules/.pnpm
COPY web/scripts/reset-admin-password.mjs /app/web/scripts/reset-admin-password.mjs
COPY web/scripts/generation-runtime.mjs /app/web/scripts/generation-runtime.mjs
COPY web/scripts/generation-worker-policy.mjs /app/web/scripts/generation-worker-policy.mjs
COPY web/scripts/generation-worker.mjs /app/web/scripts/generation-worker.mjs
COPY web/scripts/disaster-recovery-core.mjs /app/web/scripts/disaster-recovery-core.mjs
COPY web/scripts/disaster-object-storage.mjs /app/web/scripts/disaster-object-storage.mjs
COPY web/scripts/disaster-backup.mjs /app/web/scripts/disaster-backup.mjs
COPY web/scripts/disaster-restore.mjs /app/web/scripts/disaster-restore.mjs
COPY --from=web-build /app/web/scripts/local-data-migration.mjs /app/web/scripts/local-data-migration.mjs
COPY web/scripts/restore-private-files.mjs web/scripts/restore-private-migration.mjs /app/web/scripts/
COPY --from=web-build /app/web/.env* /app/web/

RUN cd /app/web && node -e "require('sharp')"
COPY docker/dreamina/version.json /app/web/.data/dreamina/version.json
RUN mkdir -p /app/web/.data/dreamina && ln -s /app/web/.data/dreamina /home/node/.dreamina_cli && chown -R node:node /app/web && chmod 0600 /app/web/.env* 2>/dev/null || true
RUN install -d -o node -g node /app/web/.data/chatgpt-api

EXPOSE 3000
USER node
CMD ["sh", "-c", "cd /app/web && exec node server.js"]

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src \
    TZ=Asia/Shanghai \
    DOLA_PROVIDER_PORT=18082

RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md NOTICE.md ./
COPY src ./src

RUN pip install --no-cache-dir '.[browser]' \
    && ok=""; \
    for attempt in 1 2 3 4 5; do \
        if python -m camoufox fetch \
           && python -c "from camoufox.pkgman import camoufox_path; camoufox_path(download_if_missing=False)"; then ok=1; break; fi; \
        echo "camoufox fetch attempt $attempt failed, retrying in 15s"; sleep 15; \
    done; \
    [ -n "$ok" ] || { echo "camoufox fetch failed" >&2; exit 1; }

EXPOSE 18082
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:18082/health', timeout=3)"
CMD ["uvicorn", "dola_api.app:app", "--host", "0.0.0.0", "--port", "18082"]

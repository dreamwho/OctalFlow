FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src \
    AISTUDIO_PORT=8080 \
    AISTUDIO_HOST=0.0.0.0 \
    AISTUDIO_ACCOUNTS_DIR=/data/accounts \
    AISTUDIO_CONFIG_FILE=/app/config.yaml \
    AISTUDIO_TMP_DIR=/tmp/aistudio \
    AISTUDIO_DUMP_RAW_RESPONSE=0 \
    CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-noto-color-emoji \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libwayland-client0 \
    libwayland-egl1 \
    libwayland-server0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 geminiai \
    && useradd --uid 10001 --gid geminiai --create-home --shell /usr/sbin/nologin geminiai

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m cloakbrowser install \
    && HOME=/home/geminiai python -m camoufox fetch \
    && chown -R geminiai:geminiai /home/geminiai

COPY src ./src
COPY config.yaml ./config.yaml
COPY docker-entrypoint.py /usr/local/bin/geminiai-entrypoint.py

RUN mkdir -p /data/accounts /tmp/aistudio /opt/cloakbrowser \
    && chown -R geminiai:geminiai /data /tmp/aistudio /opt/cloakbrowser \
    && chmod 0700 /data /data/accounts /tmp/aistudio /opt/cloakbrowser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request; response = urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=5); raise SystemExit(0 if response.status == 200 else 1)"

ENTRYPOINT ["python", "/usr/local/bin/geminiai-entrypoint.py"]
CMD ["python", "-m", "aistudio_api.api.app", "--host", "0.0.0.0", "--port", "8080"]

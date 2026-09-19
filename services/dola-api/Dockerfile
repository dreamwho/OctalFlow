FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DOLA_PROVIDER_PORT=18082

WORKDIR /app
COPY pyproject.toml README.md NOTICE.md ./
COPY src ./src

RUN pip install --no-cache-dir '.[browser]' \
    && python -m camoufox fetch

EXPOSE 18082
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:18082/health', timeout=3)"
CMD ["uvicorn", "dola_api.app:app", "--host", "0.0.0.0", "--port", "18082"]

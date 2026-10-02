FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY src ./src
COPY main.py ./
COPY docker-entrypoint.py ./

RUN pip install --no-cache-dir .

RUN groupadd -g 10011 geminivids \
    && useradd -u 10011 -g geminivids -m -d /home/geminivids -s /usr/sbin/nologin geminivids \
    && mkdir -p /data/accounts /data/tasks \
    && chown -R geminivids:geminivids /data /home/geminivids /app

USER geminivids
ENV HOME=/home/geminivids

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=10s --start-period=5s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["python", "docker-entrypoint.py"]
CMD ["python", "main.py", "server", "--host", "0.0.0.0", "--port", "8080"]

FROM python:3.11-slim

# Build context is the repository root (see docker-compose.yml) so the sanitised
# example config can ship inside the image for `docker compose exec backend pytest -v`.

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

LABEL com.settl.project=settl \
      com.settl.service=backend

# pg_dump / pg_restore for backups, matching the PostgreSQL 16 server (bookworm ships 15,
# which refuses to dump a newer server), from the PostgreSQL project's own apt repository.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-16; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*; \
    pg_dump --version

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/tests ./tests
COPY config.example.yaml ./config.example.yaml
ENV EXAMPLE_CONFIG_PATH=/app/config.example.yaml

RUN mkdir -p /app/uploads /app/config /app/backups

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM python:3.11-slim

# Build context is the repository root (see docker-compose.yml) so the sanitised
# example config can ship inside the image for `docker compose exec backend pytest -v`.

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/tests ./tests
COPY config.example.yaml ./config.example.yaml
ENV EXAMPLE_CONFIG_PATH=/app/config.example.yaml

RUN mkdir -p /app/uploads /app/config

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

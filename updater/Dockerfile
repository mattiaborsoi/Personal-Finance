FROM python:3.11-alpine

# git to pull the repository, the Docker CLI + Compose plugin to rebuild the stack
# through the host's Docker socket (mounted by docker-compose.yml).
RUN apk add --no-cache git docker-cli docker-cli-compose \
    && git config --system --add safe.directory '*'

WORKDIR /app
COPY updater.py ./
ENV PYTHONUNBUFFERED=1
CMD ["python", "updater.py"]

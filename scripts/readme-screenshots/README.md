# README screenshots

Rebuilds the images in `docs/images/` from a throwaway Settl filled with an invented
household (Alex and Sam, eight months of synthetic statements). Nothing here touches a
real installation or real data.

- `seed.py` talks only to the HTTP API of a fresh, empty Settl: it names the household,
  sets the rules, uploads generated CSV statements month by month, approves them, logs a
  few partner claims, records a payment, sets the opening balance, splits an M&S receipt,
  adds notes and closes every month but the newest, which keeps ten lines to review.
  Standard library only.
- `shoot.py` signs in with Playwright and captures each screenshot at 1440×900 (the claim
  form at 390×844), 2× scale, light theme except `dark.png`.

## Running it

From a copy of the repository (not your own installation):

```sh
git archive HEAD | tar -x -C /tmp/settl-demo && cd /tmp/settl-demo
cp config.example.yaml config.yaml
cat > .env <<EOF
DB_PASSWORD=$(openssl rand -hex 16)
SECRET_KEY=$(openssl rand -hex 32)
PRIMARY_PASSWORD=demo-alex-$(openssl rand -hex 4)
SECONDARY_PASSWORD=demo-sam-$(openssl rand -hex 4)
COMPOSE_PROFILES=
LLM_PROVIDER=none
EMBEDDING_PROVIDER=hash
UPDATE_CHECK=false
EOF
docker compose -p settl-readme up -d --build
```

If port 80, 8000 or 5432 is taken, add a `docker-compose.override.yml` in that copy
that moves the frontend port (for example `ports: !override ["127.0.0.1:8088:80"]`) and
drops the others (`ports: !reset []`).

Then, from this directory:

```sh
python3 -m venv .venv && .venv/bin/pip install playwright pillow
export SETTL_URL=http://127.0.0.1   # or the port you chose
export SETTL_PRIMARY_PASSWORD=...    # PRIMARY_PASSWORD from that .env
export SETTL_SECONDARY_PASSWORD=...  # SECONDARY_PASSWORD from that .env
python3 seed.py
.venv/bin/python shoot.py            # writes docs/images/*.png
```

`shoot.py` uses the installed Google Chrome if there is one, otherwise run
`.venv/bin/playwright install chromium` first. Pillow is optional: it re-saves each PNG
when that makes it smaller. `SETTL_DEMO_END=YYYY-MM` and `SETTL_DEMO_MONTHS` move or
lengthen the demo window (default: the eight months up to last month).

Look at every image before committing it, then remove the stack with
`docker compose -p settl-readme down -v`.

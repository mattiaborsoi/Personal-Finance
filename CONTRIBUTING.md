# Contributing to Settl

Thanks for taking an interest. Settl is a small self-hosted app maintained in
spare time, so the process is deliberately light.

## Found a bug or have an idea?

Open an issue. There are two templates: **Bug report** (what you did, what you
expected, what happened, the commit shown under Settings → System) and **Feature
request** (the problem you are trying to solve, not only the solution). Please
never paste bank statements, account numbers, real names or API keys into an
issue, even partially: describe the shape of the data instead.

## Want to change something?

1. Fork the repository and create a branch from `main`.
2. Make the change with tests. The gates that CI runs are:

   ```bash
   cd backend && ruff check . && pytest -v
   ruff check --config backend/pyproject.toml updater && python -m py_compile updater/*.py
   cd frontend && npm ci && npm run lint && npx tsc --noEmit && npm test && npm run build
   ```

   Most backend tests need PostgreSQL with pgvector and are skipped without one, so
   a green `pytest` on a laptop without a database is not the CI gate: run them in
   the container (`docker compose exec backend pytest -v`) or as described in
   docs/TECHNICAL.md, "Development setup".
3. Keep pull requests focused: one change per PR, with a short description of
   what and why. The PR template asks for the same.
4. Open the pull request against `main`. CI runs automatically; a maintainer
   reviews and merges.

## Ground rules

* British English in copy and docs; the design rules for the UI are in
  `frontend/DESIGN.md`.
* No personal data anywhere in the repository: examples use fictional people,
  placeholder suppliers and randomised card digits. `gitleaks` runs in CI and as a
  pre-commit hook (`pip install pre-commit && pre-commit install`).
* Anything that reads statements, moves money between people or calls a model
  needs a test that shows the maths or the contract.
* Security issues: see `SECURITY.md` rather than opening a public issue.

By contributing you agree that your contribution is licensed under the MIT
licence in `LICENSE`.

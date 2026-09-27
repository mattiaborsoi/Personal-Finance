## What and why

<!-- One or two sentences: what changes, and the problem it solves. Link the issue if there is one. -->

## How it was checked

- [ ] `cd backend && ruff check . && pytest -v` (against a pgvector database, or in the container)
- [ ] `ruff check --config backend/pyproject.toml updater && python -m py_compile updater/updater.py` (if `updater/` changed)
- [ ] `cd frontend && npm run lint && npx tsc --noEmit && npm test && npm run build`
- [ ] Tried it in the running app (say what you did)

## Notes for the reviewer

<!-- Anything unusual: a schema change, a new setting, a behaviour change users would notice. -->

- [ ] No personal data, statements or keys in this change

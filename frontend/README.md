# Frontend

React 18 + TypeScript + Vite 5 + Tailwind 3 single-page app for the household ledger.
It talks only to the REST contract in `../docs/API.md` through `src/api.ts`.

## Develop

```sh
npm ci
npm run dev        # http://localhost:5173, proxies /api -> http://localhost:8000
```

## Quality gates (also run in CI)

```sh
npm run lint       # eslint flat config with react-hooks
npx tsc --noEmit
npm test           # vitest, jsdom, fetch mocked - fully offline
npm run build      # tsc + vite build -> dist/
```

## Production

`Dockerfile` builds `dist/` in `node:22-alpine` and serves it from `nginx:1.27-alpine`
on port 80 (`nginx.conf`). `/api/` is proxied to `http://backend:8000/api/`; every
other path falls back to `index.html`.

## Layout

- `src/api.ts` - typed fetch wrapper, response interfaces, session storage, 401 handling
- `src/auth`, `src/config` - auth and config contexts (config is loaded once after login)
- `src/pages` - one component per route
- `src/components` - small presentational and data components, one per file
- `src/lib` - money/date formatting, settlement phrasing, view definitions
- `src/test` - vitest setup and render/fetch helpers

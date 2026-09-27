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
on port 80 (`nginx.conf`). `/api/` is proxied to `http://backend:8000/api/`;
`/assets/` serves the hashed bundle (404 if missing, cached for a year); every other
path falls back to `index.html`. `nginx-security-headers.conf` is included in every
location block (CSP, `nosniff`, `X-Frame-Options: DENY`, `no-referrer`); the
reasoning is in the security section of `../docs/TECHNICAL.md`.

## Layout

- `src/api.ts` - typed fetch wrapper, response interfaces, the signed-in session (kept in `localStorage`), 401 handling
- `src/auth`, `src/config` - auth and config contexts (config is fetched once after login and re-fetched through `useReloadConfig()` after Settings changes)
- `src/pages` - one component per route
- `src/components` - small presentational and data components, with their vitest specs alongside (`*.test.tsx`)
- `src/hooks` - `useAsync`, the keyed loader pages use (keeps data while a reload is in flight; `setData` for optimistic updates)
- `src/lib` - `ui.ts` (the design-system class strings, see `DESIGN.md`), `theme.ts`, money/date/label formatting, settlement phrasing, split, claim and transfer helpers, view definitions
- `src/test` - vitest setup, `renderWithProviders` / `mockFetch` helpers and typed response fixtures (`fixtures.ts`)

# Instructions for AI assistants (Copilot and others)

The architecture, commands, decisions and open items live in `CLAUDE.md` at the
repo root. Read it first; this file only states the rules to keep when changing
code. If the two ever disagree, `CLAUDE.md` wins.

## Runtimes (keep them separate)

- **Deno**: the app, the build, and almost all tests. No Node APIs here.
- **Node**: only the Playwright browser tests in `node-tests/`. They must not
  import Deno modules and start the app themselves.
- **Docker**: only Postgres (`docker/`). No application code in `docker/`.

## Layout

```
app/src/            server code
app/frontend-src/   browser code (TS) and the three HTML pages (dj, jd, sb)
app/tests/          unit/ frontend/ contract/ integration/ (Deno)
public/             built bundles dj.js jd.js sb.js (generated, tracked in git)
node-tests/         Playwright (Node)
docker/             docker-compose.yml, postgres/db-init/01_schema.sql, 02_seed.sql
scripts/            build_artifacts.ts, issue-links.ts
tools/              e2e.sh, run-e2e.sh, init-test-db.sh
```

## Rules

- **What is served.** Browser bundles come from `public/` (`/js/:file`); the three
  HTML pages are served from `app/frontend-src` through an explicit allowlist of
  routes. Never add a static mount that exposes `app/`, `audio/` or any other
  directory. Audio is served only by the authenticated `GET /audio/...` route.
- **Thin route handlers.** No business logic in `app/src/main.ts` handlers: put it
  in a module (see `responseService.ts`, `audioLibrary.ts`). Validate, call, map to
  an HTTP status.
- **Database access** goes through `app/src/db.ts`; storage of audio bytes goes
  through the `AudioStorage` interface. Schema changes go in
  `docker/postgres/db-init/01_schema.sql` and must be idempotent.
- **Shared code** between server and browser (`contract.ts`, `protocol.ts` types)
  must not use Deno or DOM APIs.
- **Prefer pure functions** and explicit imports; keep modules small.
- **Generated bundles**: after changing anything under `app/frontend-src` or the
  code it imports, run `deno task build` and commit `public/*.js`
  (`deno task static` checks this).
- **Tests**: new behaviour needs a test in the matching suite. Check exit codes,
  not just the pass count (`deno test` can print "ok" and still exit 1).
- Don't introduce a browser bundler (Webpack, Vite, Rollup); bundles come from
  `deno bundle` via `scripts/build_artifacts.ts`.
- Don't restructure directories or modify Docker files unless asked.

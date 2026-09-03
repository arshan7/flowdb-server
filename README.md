# flowdb-server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Backend for [Tablespace / FlowDB](https://github.com/arshan7/FlowDB). It does
two jobs:

1. **Persistence** — stores every Tablespace project, source, model, report,
   dashboard, branch and checkpoint in its own Postgres database. The
   frontend has no local (IndexedDB) fallback anymore; this service is
   required to run the app.
2. **Live-database access** — introspects an external Postgres database into
   the `{ nodes, edges, enums }` shape the frontend's SQL/DBML importers
   already produce, and (for a "Connected" source) runs read-only,
   row-capped `SELECT` queries against it for the Data / report layer.

It talks to two kinds of database, kept strictly separate:

| | flowdb-server's own DB | a user's external DB |
|---|---|---|
| what | projects, diagrams, checkpoints | the schema/data the user is modelling |
| pooling | one long-lived pool (`src/lib/db.js`) | a fresh pool per request (`src/lib/pgIntrospect.js`), torn down immediately |
| credentials | `DATABASE_URL` env var | supplied per request, or stored **AES-256-GCM encrypted** at rest for a Connected source (`src/lib/crypto.js`) |
| writes | yes | **never** — read-only, `information_schema` / `pg_catalog` / `SELECT` only |

The schema of flowdb-server's own database is managed by a separate repo,
[`flowdb-migrations`](../flowdb-migrations) (Alembic). This service does not
run migrations; point both at the same Postgres instance.

## Architecture

```
src/
  index.js              # express app, CORS, auth mount, error backstop, graceful shutdown
  middleware/apiKey.js   # constant-time x-api-key check (fails closed if unset)
  routes/
    introspect.js        # POST /api/introspect
    tablespace.js         # ~40 CRUD + query routes (projects → checkpoints)
  lib/
    db.js                # the app's own pooled Postgres connection
    tablespaceStore.js    # every DB read/write for the persistence layer
    pgIntrospect.js       # per-request connection to an external DB
    queryEngine.js        # compiles a report spec → parameterised SQL
    queryCache.js         # 30s in-process result cache (bounded, swept)
    crypto.js            # encrypt/decrypt a stored connection string
    syncSource.js / syncScheduler.js  # background re-introspection of Connected sources
    schemaDiff / schemaMerge / reconcile  # 3-way merge for branches
```

Every async route is wrapped so a rejected promise reaches the Express error
handler instead of crashing the process; `unhandledRejection` /
`uncaughtException` / `SIGTERM` are all handled in `index.js`.

## API

All `/api/*` routes require `x-api-key: <API_KEY>` and `Content-Type:
application/json`. Errors are `{ "error": "<message>" }` with a 4xx/5xx
status; connection strings are never echoed or logged, even on failure.

- `POST /api/introspect` — `{ connectionString, schema? }` → `{ nodes,
  edges, enums }`. Read-only; `schema` defaults to `"public"`.
- `/api/projects`, `/api/projects/:id/sources`, `/api/sources/:id/models`,
  `/api/sources/:id/reports`, `/api/sources/:id/dashboards`,
  `/api/sources/:id/branches`, `/api/sources/:id/checkpoints`, … — standard
  REST CRUD for the persistence layer (see `src/routes/tablespace.js`).
- `POST /api/sources/:id/preview` / `/query` / `/column-summary` — read-only,
  row-capped data access against a Connected source.
- `GET /health` — unauthenticated, `{ "status": "ok" }`, for uptime checks.

## Local development

```bash
npm install
cp .env.example .env    # fill in every variable — see the comments in that file
npm run dev             # node --watch src/index.js
npm test                # node --test
```

You need a reachable Postgres for `DATABASE_URL` with the `flowdb-migrations`
schema applied (`alembic upgrade head` in that repo).

Required env (all documented in `.env.example`): `API_KEY`, `DATABASE_URL`,
`CONNECTION_ENCRYPTION_KEY`. Optional: `PORT`, `ALLOWED_ORIGIN`.

## Deploying (Render)

`render.yaml` is a Blueprint. **New → Blueprint**, point it at this repo,
then set the `sync: false` secrets (`API_KEY`, `DATABASE_URL`,
`ALLOWED_ORIGIN`, `CONNECTION_ENCRYPTION_KEY`) in the service's Environment
tab. The frontend derives its server URL from its own build (see the FlowDB
repo's `src/core/api/client.js`).

## Security notes

- `API_KEY` is a **shared secret**, sent by the frontend on every request
  and compared in constant time; it fails closed (500) if unset. It is
  inlined into the frontend bundle at build time, so it stops casual abuse,
  not a determined caller with devtools. Real per-user auth is future work
  (see the FlowDB `ROADMAP.md`). Until then, treat the deployed instance as
  a shared-trust environment.
- The introspection/query paths only ever read. Every column name a report
  references is re-validated server-side against the modelled schema before
  it reaches SQL; identifiers are quoted, values are bound parameters.
- Set `ALLOWED_ORIGIN` in production to lock CORS to your frontend's origin
  (it defaults to `*` only for local convenience).
- `CONNECTION_ENCRYPTION_KEY` protects stored connection strings at rest —
  back it up; rotating or losing it makes every stored string
  undecryptable.

See [`../FlowDB/docs/CODE_AUDIT.md`](../FlowDB/docs/CODE_AUDIT.md) for the
current known-gaps list.

## License

MIT — see [LICENSE](LICENSE).
